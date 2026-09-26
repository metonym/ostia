import type { TimingStats, Trial, Warning } from "../ir/types.ts"
import { computeTimingStats, timingWarnings } from "../stats/index.ts"

export interface InprocessTimingOptions {
  /** Wall-clock budget for the sampling loop, per task (default: 500). The loop
   * always runs for at least this long, unless `samples` is set. */
  budgetMs?: number
  /** Exact trial count. When set, the budget is ignored and the loop runs
   * exactly this many trials, however slow each one is - the in-process
   * equivalent of `time()`'s `samples`. */
  samples?: number
  /** Hard floor on the number of trials when no exact `samples` count is
   * given. When set, the loop keeps sampling past the time budget until this
   * many trials exist, however slow each one is. When unset, the floor is
   * cost-aware (see `defaultSampleFloor`): as many trials as fit in the
   * budget, capped at 20, but never below the rigor floor the task's per-trial cost
   * earns it (3 at ≤1ms, rising to 10 for multi-second calls). */
  minSamples?: number
  /** Warmup budget as a fraction of `budgetMs` (default: 0.1) - a fraction,
   * not a call count, named `warmup` for cross-surface consistency with
   * `time()`'s trial-count `warmup`; the two are genuinely different units (a
   * fraction here, a count there), not papered over. Warmup always runs at
   * least one call; for a task slower than the warmup budget that single call
   * is the whole warmup. */
  warmup?: number
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
// Batch further so a full budget yields about this many trials. Every trial is
// retained, sorted, serialized into the IPC document and parsed back by the CLI;
// unbounded trial counts (millions per sub-microsecond task) cost seconds per task
// outside the timed region.
const TRIALS_TARGET = 10_000
// Hard stop on the budget-driven loop: a task that got faster than its
// calibration predicted still ends at a bounded trial count instead of
// overshooting the target many times over.
const MAX_TRIALS = 2 * TRIALS_TARGET
// Warmup doubles its batch until one batch spans this long, so the compiled loop
// is hot at roughly the batch size it will be sampled at.
const WARMUP_CHUNK_NS = 1_000_000
const CALIBRATION_ROUNDS = 5
// Ring buffer the loop writes every result into: the JIT can't prove a stored
// value unused, so it can't elide the call or its allocations.
const SINK_SIZE = 256

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

// Write-only by design: a store to module state is never provably dead, which
// is all it takes to keep the value (and its computation) alive.
// biome-ignore lint/correctness/noUnusedVariables: intentionally write-only, see above
let kept: unknown

/** Pins `value` against dead-code elimination, for an intermediate value inside
 * a task body that would otherwise go unused and risk being optimized away. A
 * task's own return value is already pinned by the sampling loop. */
export function keep(value: unknown): void {
  kept = value
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<unknown>).then === "function"
  )
}

type TaskFn = () => unknown | Promise<unknown>
type Loop = (fn: TaskFn, sink: unknown[], n: number) => number | Promise<number>

const AsyncFunction = (async () => {}).constructor as FunctionConstructor
let loopSerial = 0

/** Compiles a timing loop dedicated to one task. JSC specializes compiled code
 * per function: one loop shared by every task gets its `fn()` call site tuned
 * (inlined, type-specialized) for whichever task ran first, and then measures
 * every later task through a slower generic call - the same task read 3ns or
 * 80ns depending on its position in the suite. The serial in the source keeps
 * JSC's code cache from handing two tasks the same compiled body. An async task
 * gets an awaiting loop; a sync one never pays for a microtask per call. */
function compileLoop(isAsync: boolean): Loop {
  const body = `/* ostia task loop ${loopSerial++} */
const t0 = Bun.nanoseconds()
for (let b = 0; b < n; b++) sink[b & ${SINK_SIZE - 1}] = ${isAsync ? "await " : ""}fn()
return Bun.nanoseconds() - t0`
  const ctor = isAsync ? AsyncFunction : Function
  return ctor("fn", "sink", "n", body) as Loop
}

function sizeBatch(singleCallNs: number, timeBudgetNs: number): number {
  return Math.max(
    1,
    Math.ceil(BATCH_THRESHOLD_NS / singleCallNs),
    Math.ceil(timeBudgetNs / (singleCallNs * TRIALS_TARGET)),
  )
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]!
}

export async function measureTask(
  fn: TaskFn,
  opts: InprocessTimingOptions = {},
): Promise<InprocessTimingResult> {
  const timeBudgetNs = (opts.budgetMs ?? DEFAULT_TIME_BUDGET_MS) * 1e6
  const warmupBudgetNs = timeBudgetNs * (opts.warmup ?? DEFAULT_WARMUP_FRACTION)

  // The first call decides which loop the task gets, and doubles as the cost
  // estimate when warmup is disabled.
  const firstStart = Bun.nanoseconds()
  const first = fn()
  const isAsync = isPromiseLike(first)
  if (isAsync) await first
  let singleCallNs = Math.max(1, Bun.nanoseconds() - firstStart)

  const loop = compileLoop(isAsync)
  const sink: unknown[] = new Array(SINK_SIZE)
  const timeBatch = (n: number): number | Promise<number> => loop(fn, sink, n)

  const warmupStart = Bun.nanoseconds()
  let n = 1
  while (Bun.nanoseconds() - warmupStart < warmupBudgetNs) {
    const ns = await timeBatch(n)
    singleCallNs = Math.max(1, ns / n)
    if (ns < WARMUP_CHUNK_NS) n *= 2
  }

  // The warmup estimate comes from a single batch, which a GC pause or a
  // tier-up compile can inflate many times over (and under-batch a fast task
  // into a flood of trials). A few batches at the planned size, timed exactly
  // as the loop will, settle it on their median. Only batched (fast) tasks pay
  // this, and each batch is at most ~1/10000th of the budget.
  let batchSize = sizeBatch(singleCallNs, timeBudgetNs)
  if (batchSize > 1) {
    const perCall: number[] = []
    for (let r = 0; r < CALIBRATION_ROUNDS; r++) {
      perCall.push((await timeBatch(batchSize)) / batchSize)
    }
    singleCallNs = Math.max(1, medianOf(perCall))
    batchSize = sizeBatch(singleCallNs, timeBudgetNs)
  }
  const trialCostNs = singleCallNs * batchSize
  const minSamples =
    opts.samples ??
    opts.minSamples ??
    defaultSampleFloor(trialCostNs, timeBudgetNs)
  // An exact sample count ignores the budget entirely, same as subprocess
  // timing's `samples`.
  const effectiveBudgetNs = opts.samples !== undefined ? 0 : timeBudgetNs
  const maxTrials = opts.samples ?? Math.max(MAX_TRIALS, minSamples)

  const trials: Trial[] = []
  const start = Bun.nanoseconds()
  let elapsed = 0
  let i = 0
  while (i < minSamples || (elapsed < effectiveBudgetNs && i < maxTrials)) {
    const ns = await timeBatch(batchSize)
    trials.push({ i, wallNs: ns / batchSize })
    i++
    elapsed = Bun.nanoseconds() - start
    if (opts.gc) Bun.gc(true)
    if (i >= maxTrials && i >= minSamples) break
  }

  const wallTimes = trials.map((t) => t.wallNs)
  const timing = computeTimingStats(wallTimes)
  if (batchSize > 1) timing.batch = batchSize
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
