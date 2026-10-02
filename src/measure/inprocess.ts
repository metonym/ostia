import { formatDuration } from "../format.ts"
import type { TimingStats, Trial, Warning } from "../ir/types.ts"
import { computeTimingStats, timingWarnings } from "../stats/index.ts"
import { batchTimer, probeFirstCall, type TaskBody } from "./loop.ts"

export interface InprocessTimingOptions {
  /** Wall-clock budget for the sampling loop, per task (default: 500). */
  budgetMs?: number
  /** Exact trial count; the budget is ignored. */
  samples?: number
  /** Keep sampling past the budget until this many trials exist. When unset
   * the floor is cost-aware (see `defaultSampleFloor`). */
  minSamples?: number
  /** Warmup budget as a fraction of `budgetMs` (default: 0.1); unlike
   * `time()`'s `warmup`, which is a trial count. Always runs at least one call. */
  warmup?: number
  gc?: boolean
}

const DEFAULT_TIME_BUDGET_MS = 500
// Upper bound only: a task cheap enough to fit 20 trials in the budget is time-bound.
const BUDGET_FLOOR_CAP = 20
const RIGOR_FLOOR_MIN = 3
const RIGOR_FLOOR_CAP = 10
const RIGOR_SAMPLES_PER_DECADE = 2
const DEFAULT_WARMUP_FRACTION = 0.1
// Batch each trial to at least this long so timer resolution doesn't dominate.
const BATCH_THRESHOLD_NS = 1000
// Batch further so a full budget yields about this many trials: every trial is
// sorted, serialized over IPC and parsed back, which costs seconds at millions.
const TRIALS_TARGET = 10_000
// Hard stop for a task that got faster than its calibration predicted.
const MAX_TRIALS = 2 * TRIALS_TARGET
// Warmup doubles its batch until one spans this long.
const WARMUP_CHUNK_NS = 1_000_000
const CALIBRATION_ROUNDS = 5

export interface InprocessTimingResult {
  trials: Trial[]
  timing: TimingStats
  warnings: Warning[]
}

/** Samples a task's per-trial cost earns regardless of budget: 3 at 1ms or
 * less, two more per decade of cost, capped at 10 from about 3s up. Only
 * expensive tasks ever hit it; the budget fills cheap ones with thousands. */
export function rigorFloor(trialCostNs: number): number {
  const decadesAboveOneMs = Math.log10(Math.max(1, trialCostNs) / 1e6)
  const floor = Math.round(
    RIGOR_FLOOR_MIN + RIGOR_SAMPLES_PER_DECADE * decadesAboveOneMs,
  )
  return Math.min(RIGOR_FLOOR_CAP, Math.max(RIGOR_FLOOR_MIN, floor))
}

/** Default floor without `minSamples`: as many trials as fit in the budget
 * (capped at 20), never fewer than `rigorFloor`. */
export function defaultSampleFloor(
  trialCostNs: number,
  timeBudgetNs: number,
): number {
  const fit = Math.floor(timeBudgetNs / trialCostNs)
  return Math.min(BUDGET_FLOOR_CAP, Math.max(fit, rigorFloor(trialCostNs)))
}

// Write-only on purpose: a store to module state is never provably dead.
// biome-ignore lint/correctness/noUnusedVariables: see above
let kept: unknown

/** Pins `value` against dead-code elimination for an intermediate inside a
 * task body. A task's own return value is already pinned by the timing loop. */
export function keep(value: unknown): void {
  kept = value
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
  fn: TaskBody,
  opts: InprocessTimingOptions = {},
): Promise<InprocessTimingResult> {
  const timeBudgetNs = (opts.budgetMs ?? DEFAULT_TIME_BUDGET_MS) * 1e6
  const warmupBudgetNs = timeBudgetNs * (opts.warmup ?? DEFAULT_WARMUP_FRACTION)

  // The first call picks the loop and is the cost estimate when warmup is off.
  const first = await probeFirstCall(fn)
  let singleCallNs = first.ns
  const timeBatch = batchTimer(fn, first.isAsync)

  const warmupStart = Bun.nanoseconds()
  let n = 1
  while (Bun.nanoseconds() - warmupStart < warmupBudgetNs) {
    const ns = await timeBatch(n)
    singleCallNs = Math.max(1, ns / n)
    if (ns < WARMUP_CHUNK_NS) n *= 2
  }

  // A single warmup batch can be inflated by a GC pause or tier-up compile and
  // under-batch a fast task into a flood of trials; settle on the median of a
  // few batches at the planned size instead.
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
  }

  const timing = computeTimingStats(trials.map((t) => t.wallNs))
  if (batchSize > 1) timing.batch = batchSize
  const warnings = timingWarnings(timing, [], "inprocess")

  // Only fires when an explicit `minSamples` undercut the default floor.
  const target = rigorFloor(trialCostNs)
  if (trials.length < target) {
    warnings.push({
      code: "low-sample-count",
      message: `Only ${trials.length} sample(s) at ~${formatDuration(trialCostNs)} per trial; ${target} is the floor for this cost class. Raise minSamples or the time budget for a steadier number.`,
      data: { samples: trials.length, target, trialCostNs },
    })
  }

  return { trials, timing, warnings }
}
