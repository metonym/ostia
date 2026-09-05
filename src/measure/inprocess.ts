import type { TimingStats, Trial, Warning } from "../ir/types.ts"
import { computeTimingStats, timingWarnings } from "../stats/index.ts"

export interface InprocessTimingOptions {
  /** Wall-clock budget for the sampling loop, per task (default: 500). The loop
   * always runs for at least this long. */
  timeBudgetMs?: number
  /** Hard floor on the number of trials. When set, the loop keeps sampling past the
   * time budget until this many trials exist, however slow each one is. When unset,
   * the floor is cost-aware (see `defaultSampleFloor`): as many trials as fit in the
   * budget, capped at 20, but never below the rigor floor the task's per-trial cost
   * earns it (3 at ≤1ms, rising to 10 for multi-second calls). */
  minSamples?: number
  /** Warmup budget as a fraction of `timeBudgetMs` (default: 0.1), not a call
   * count. Warmup always runs at least one call; for a task slower than the
   * warmup budget that single call is the whole warmup. */
  warmupFraction?: number
  gc?: boolean
}

const DEFAULT_TIME_BUDGET_MS = 500
// Cap on the budget-derived floor. Only matters as an upper bound: a task cheap
// enough to fit 20 trials in the budget is time-bound and collects far more.
const BUDGET_FLOOR_CAP = 20
const RIGOR_FLOOR_MIN = 3
const RIGOR_FLOOR_CAP = 10
const RIGOR_SAMPLES_PER_DECADE = 2
const DEFAULT_WARMUP_FRACTION = 0.1
// A single trial is batched until it spans at least this long, so the timer's
// resolution doesn't dominate the reading.
const BATCH_THRESHOLD_NS = 1000
// Batch further so a full budget yields at most about this many trials. Every trial
// is retained, sorted, serialized into the IPC document and parsed back by the CLI;
// unbounded trial counts (millions per sub-microsecond task) cost seconds per task
// outside the timed region.
const MAX_TRIALS_TARGET = 10_000

export interface InprocessTimingResult {
  trials: Trial[]
  timing: TimingStats
  warnings: Warning[]
}

/** The sample count a task's per-trial cost earns it regardless of the time
 * budget: 3 at 1ms or less, two more per decade of cost, capped at 10 from about
 * 3s up. Cheap tasks never see this floor (the budget fills them with thousands
 * of trials); it only lifts the few expensive tasks in a suite, which are exactly
 * the ones where a 3-sample mean is shakiest and where each extra trial buys the
 * most. Spending scales with cost by design: a 100ms task pays ~0.7s for 7
 * trials, a 2.4s task ~24s for 10, instead of a flat 3 for both. */
export function rigorFloor(trialCostNs: number): number {
  const decadesAboveOneMs = Math.log10(Math.max(1, trialCostNs) / 1e6)
  const floor = Math.round(
    RIGOR_FLOOR_MIN + RIGOR_SAMPLES_PER_DECADE * decadesAboveOneMs,
  )
  return Math.min(RIGOR_FLOOR_CAP, Math.max(RIGOR_FLOOR_MIN, floor))
}

/** Cost-aware default floor when no explicit `minSamples` is given: as many
 * trials as fit in the budget (capped at 20) so one slow task can't blow the
 * suite's total, but never fewer than the task's `rigorFloor`. */
export function defaultSampleFloor(
  trialCostNs: number,
  timeBudgetNs: number,
): number {
  const fit = Math.floor(timeBudgetNs / trialCostNs)
  return Math.min(BUDGET_FLOOR_CAP, Math.max(fit, rigorFloor(trialCostNs)))
}

// Prevents the JIT from eliminating calls whose result is otherwise unused. Write-only
// by design. The accumulation itself, not the final value, defeats dead-code
// elimination; nothing needs to read it back.
// biome-ignore lint/correctness/noUnusedVariables: intentionally write-only, see above
let sink = 0

/** Pins `value` against dead-code elimination. `measureTask` already does this
 * for a task's own return value; `keep()` (exported from `src/index.ts`) is the
 * same sink made public, for an intermediate value inside a task body that
 * would otherwise go unused and risk being optimized away. */
export function keep(value: unknown): void {
  if (typeof value === "number") sink += value
  else if (value !== undefined && value !== null) sink += 1
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<unknown>).then === "function"
  )
}

function sizeBatch(singleCallNs: number, timeBudgetNs: number): number {
  return Math.max(
    1,
    Math.ceil(BATCH_THRESHOLD_NS / singleCallNs),
    Math.ceil(timeBudgetNs / (singleCallNs * MAX_TRIALS_TARGET)),
  )
}

export async function measureTask(
  fn: () => unknown | Promise<unknown>,
  opts: InprocessTimingOptions = {},
): Promise<InprocessTimingResult> {
  const timeBudgetNs = (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS) * 1e6
  const warmupBudgetNs =
    timeBudgetNs * (opts.warmupFraction ?? DEFAULT_WARMUP_FRACTION)

  const warmupStart = Bun.nanoseconds()
  let warmupCalls = 0
  let warmupElapsed = 0
  while (warmupElapsed < warmupBudgetNs) {
    // Only suspend on an actual promise: `await` on a plain value still costs a
    // microtask turn per call, which at sub-microsecond task cost is most of what
    // gets measured. Warmup, calibration and the sampling loop must all call the
    // same way so the cost estimate matches what the loop measures (an async
    // helper would reintroduce the promise per call).
    const result = fn()
    keep(isPromiseLike(result) ? await result : result)
    warmupCalls++
    warmupElapsed = Bun.nanoseconds() - warmupStart
  }

  // Per-call cost estimate, used only to size batches and the sample floor. Reuses
  // the warmup phase rather than paying a dedicated calibration call; a warmup
  // fraction of 0 is the only case that runs one.
  let singleCallNs: number
  if (warmupCalls > 0) {
    singleCallNs = Math.max(1, warmupElapsed / warmupCalls)
  } else {
    const calibStart = Bun.nanoseconds()
    const result = fn()
    keep(isPromiseLike(result) ? await result : result)
    singleCallNs = Math.max(1, Bun.nanoseconds() - calibStart)
  }

  let batchSize = sizeBatch(singleCallNs, timeBudgetNs)
  if (batchSize > 1) {
    // The warmup estimate carries a timer read per call, which overstates a
    // sub-100ns call several times over and would under-batch it. One batch timed
    // as a block, exactly as the loop does, corrects that. Only batched (fast)
    // tasks pay this, and one batch is at most ~1/10000th of the budget.
    const calibStart = Bun.nanoseconds()
    for (let b = 0; b < batchSize; b++) {
      const result = fn()
      keep(isPromiseLike(result) ? await result : result)
    }
    singleCallNs = Math.max(1, (Bun.nanoseconds() - calibStart) / batchSize)
    batchSize = sizeBatch(singleCallNs, timeBudgetNs)
  }
  const trialCostNs = singleCallNs * batchSize
  const minSamples =
    opts.minSamples ?? defaultSampleFloor(trialCostNs, timeBudgetNs)

  const trials: Trial[] = []
  const start = Bun.nanoseconds()
  let elapsed = 0
  let i = 0
  while (i < minSamples || elapsed < timeBudgetNs) {
    const trialStart = Bun.nanoseconds()
    for (let b = 0; b < batchSize; b++) {
      const result = fn()
      keep(isPromiseLike(result) ? await result : result)
    }
    const trialEnd = Bun.nanoseconds()
    trials.push({ i, wallNs: (trialEnd - trialStart) / batchSize })
    i++
    elapsed = Bun.nanoseconds() - start
    if (opts.gc) Bun.gc(true)
  }

  const samples = trials.map((t) => t.wallNs)
  const timing = computeTimingStats(samples)
  const warnings = timingWarnings(timing, [], "inprocess")

  // The default floor guarantees the rigor target, so this only fires when an
  // explicit `minSamples` (suite-wide or per-task) undercut it. Structured so a
  // renderer or an agent can flag "this number is thin" without re-deriving the
  // policy from the raw sample array.
  const target = rigorFloor(trialCostNs)
  if (trials.length < target) {
    warnings.push({
      code: "low-sample-count",
      message: `Only ${trials.length} sample(s) at ~${fmtCost(trialCostNs)} per trial; ${target} is the floor for this cost class. Raise minSamples or the time budget for a steadier number.`,
      data: { samples: trials.length, target, trialCostNs },
    })
  }

  return { trials, timing, warnings }
}

function fmtCost(ns: number): string {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)}s`
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(1)}ms`
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(1)}µs`
  return `${ns.toFixed(0)}ns`
}
