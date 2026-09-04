import type { TimingStats, Trial, Warning } from "../ir/types.ts"
import { computeTimingStats, timingWarnings } from "../stats/index.ts"

export interface InprocessTimingOptions {
  /** Wall-clock budget for the sampling loop, per task (default: 500). The loop
   * always runs for at least this long. */
  timeBudgetMs?: number
  /** Hard floor on the number of trials. When set, the loop keeps sampling past the
   * time budget until this many trials exist, however slow each one is. When unset,
   * the floor is cost-aware: as many trials as fit in the budget, clamped to
   * [3, 20], so a slow task never overruns the budget by more than one trial. */
  minSamples?: number
  /** Warmup budget as a fraction of `timeBudgetMs` (default: 0.1), not a call
   * count. Warmup always runs at least one call; for a task slower than the
   * warmup budget that single call is the whole warmup. */
  warmupFraction?: number
  gc?: boolean
}

const DEFAULT_TIME_BUDGET_MS = 500
const DEFAULT_MIN_SAMPLES = 20
const MIN_SAMPLES_FLOOR = 3
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

// Prevents the JIT from eliminating calls whose result is otherwise unused. Write-only
// by design. The accumulation itself, not the final value, defeats dead-code
// elimination; nothing needs to read it back.
// biome-ignore lint/correctness/noUnusedVariables: intentionally write-only, see above
let sink = 0
function consume(value: unknown): void {
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
    consume(isPromiseLike(result) ? await result : result)
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
    consume(isPromiseLike(result) ? await result : result)
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
      consume(isPromiseLike(result) ? await result : result)
    }
    singleCallNs = Math.max(1, (Bun.nanoseconds() - calibStart) / batchSize)
    batchSize = sizeBatch(singleCallNs, timeBudgetNs)
  }
  const trialCostNs = singleCallNs * batchSize
  const minSamples =
    opts.minSamples ??
    Math.min(
      DEFAULT_MIN_SAMPLES,
      Math.max(MIN_SAMPLES_FLOOR, Math.floor(timeBudgetNs / trialCostNs)),
    )

  const trials: Trial[] = []
  const start = Bun.nanoseconds()
  let elapsed = 0
  let i = 0
  while (i < minSamples || elapsed < timeBudgetNs) {
    const trialStart = Bun.nanoseconds()
    for (let b = 0; b < batchSize; b++) {
      const result = fn()
      consume(isPromiseLike(result) ? await result : result)
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
  return { trials, timing, warnings }
}
