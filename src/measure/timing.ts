import type { TimingStats, Trial, Warning } from "../ir/types.ts"
import { runTrial, type SpawnTrialOptions } from "../spawn/index.ts"
import { computeTimingStats, timingWarnings } from "../stats/index.ts"

export interface TimingPhaseOptions extends SpawnTrialOptions {
  /** @deprecated Use `samples`. */
  runs?: number
  /** Exact trial count. Same concept as the deprecated `runs`; when set, the
   * budget (`budgetMs`/`minTotalNs`) is ignored and the loop runs exactly
   * this many trials. */
  samples?: number
  /** Warmup trial count, discarded before sampling starts. */
  warmup?: number
  /** @deprecated Use `minSamples`. */
  minRuns?: number
  /** Hard floor on trials when no exact `samples` count is given. */
  minSamples?: number
  /** @deprecated Use `budgetMs` (same value, in ms instead of ns). */
  minTotalNs?: number
  /** Wall-clock time budget for the sampling loop, ms. Same concept as the
   * deprecated `minTotalNs`. */
  budgetMs?: number
}

const DEFAULT_MIN_SAMPLES = 10
const DEFAULT_BUDGET_NS = 3_000_000_000
const DEFAULT_WARMUP = 3

export interface TimingPhaseResult {
  trials: Trial[]
  timing: TimingStats
  warnings: Warning[]
}

/** One command's trial loop, exposed one trial at a time so `time()` can
 * round-robin several commands' loops against each other (`--interleave`)
 * instead of running one command's loop to completion before the next
 * starts. `warmup()` first, then `step()` until it returns false. */
export interface TimingPhaseIterator {
  warmup(): Promise<void>
  /** Runs one more trial if the phase hasn't reached its stopping criterion
   * (exact `samples`, or `minSamples` and `budgetMs` both satisfied) yet;
   * returns whether a trial ran. */
  step(): Promise<boolean>
  done(): boolean
  result(): TimingPhaseResult
}

export function createTimingPhase(
  opts: TimingPhaseOptions,
): TimingPhaseIterator {
  const warmupCount = opts.warmup ?? DEFAULT_WARMUP
  const samples = opts.samples ?? opts.runs
  const minSamples = opts.minSamples ?? opts.minRuns ?? DEFAULT_MIN_SAMPLES
  const minSamplesFloor = samples ?? minSamples
  // An exact sample count ignores the budget entirely, same as it always has
  // under the `runs` name.
  const budgetNs =
    samples !== undefined
      ? 0
      : opts.budgetMs !== undefined
        ? opts.budgetMs * 1e6
        : (opts.minTotalNs ?? DEFAULT_BUDGET_NS)

  const trials: Trial[] = []
  let totalNs = 0
  let i = 0

  function done(): boolean {
    if (samples !== undefined) return i >= samples
    return i >= minSamplesFloor && totalNs >= budgetNs
  }

  return {
    async warmup() {
      for (let w = 0; w < warmupCount; w++) await runTrial(opts)
    },
    async step() {
      if (done()) return false
      const result = await runTrial(opts)
      trials.push({
        i,
        wallNs: result.wallNs,
        exitCode: result.exitCode,
        userNs: result.userNs,
        systemNs: result.systemNs,
        maxRssBytes: result.maxRssBytes,
      })
      totalNs += result.wallNs
      i++
      return true
    },
    done,
    result(): TimingPhaseResult {
      const timingSamples = trials.map((t) => t.wallNs)
      const timing = computeTimingStats(timingSamples)
      const warnings = timingWarnings(
        timing,
        trials.map((t) => t.exitCode),
      )
      return { trials, timing, warnings }
    },
  }
}

export async function runTimingPhase(
  opts: TimingPhaseOptions,
): Promise<TimingPhaseResult> {
  const phase = createTimingPhase(opts)
  await phase.warmup()
  while (await phase.step()) {
    /* drain the phase's own stopping criterion */
  }
  return phase.result()
}
