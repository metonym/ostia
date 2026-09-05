import type { TimingStats, Trial, Warning } from "../ir/types.ts"
import {
  type PrepareHook,
  runPrepare,
  runTrial,
  type SpawnTrialOptions,
} from "../spawn/index.ts"
import { computeTimingStats, timingWarnings } from "../stats/index.ts"

export interface TimingPhaseOptions extends SpawnTrialOptions {
  /** Exact trial count; when set, the budget (`budgetMs`) is ignored and the
   * loop runs exactly this many trials. */
  samples?: number
  /** Warmup trial count, discarded before sampling starts. */
  warmup?: number
  /** Hard floor on trials when no exact `samples` count is given. */
  minSamples?: number
  /** Wall-clock time budget for the sampling loop, ms. */
  budgetMs?: number
  /** Runs before every trial, warmup included, unmeasured. See
   * `PrepareHook`. */
  prepare?: PrepareHook
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
  const samples = opts.samples
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES
  const minSamplesFloor = samples ?? minSamples
  // An exact sample count ignores the budget entirely.
  const budgetNs =
    samples !== undefined
      ? 0
      : opts.budgetMs !== undefined
        ? opts.budgetMs * 1e6
        : DEFAULT_BUDGET_NS
  const reported = opts.timeSource !== undefined

  const trials: Trial[] = []
  let totalNs = 0
  let i = 0

  function done(): boolean {
    if (samples !== undefined) return i >= samples
    return i >= minSamplesFloor && totalNs >= budgetNs
  }

  async function trial(phase: "warmup" | "timing", index: number) {
    if (opts.prepare) {
      await runPrepare(
        opts.prepare,
        { phase, index },
        { cwd: opts.cwd, env: opts.env },
      )
    }
    return runTrial(opts)
  }

  return {
    async warmup() {
      for (let w = 0; w < warmupCount; w++) await trial("warmup", w)
    },
    async step() {
      if (done()) return false
      const result = await trial("timing", i)
      trials.push({
        i,
        wallNs: result.wallNs,
        exitCode: result.exitCode,
        userNs: result.userNs,
        systemNs: result.systemNs,
        maxRssBytes: result.maxRssBytes,
        ...(result.reportedNs !== undefined && {
          reportedNs: result.reportedNs,
        }),
      })
      // The budget is about how long the loop is allowed to take, so it
      // always counts wall time, even when the samples are reported times.
      totalNs += result.wallNs
      i++
      return true
    },
    done,
    result(): TimingPhaseResult {
      const timingSamples = trials.map((t) =>
        reported ? (t.reportedNs ?? t.wallNs) : t.wallNs,
      )
      const timing = computeTimingStats(timingSamples)
      const warnings = timingWarnings(
        timing,
        trials.map((t) => t.exitCode),
        reported ? "reported" : "subprocess",
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
