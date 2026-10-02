import type { Measurement, TimingStats, Trial, Warning } from "../ir/types.ts"
import {
  assertReusableTimeSource,
  type PrepareHook,
  runPrepare,
  runTrial,
  type SpawnTrialOptions,
} from "../spawn/index.ts"
import { computeTimingStats, timingWarnings } from "../stats/index.ts"

export interface TimingPhaseOptions extends SpawnTrialOptions {
  /** Exact trial count; the budget is ignored. */
  samples?: number
  /** Warmup trial count, discarded before sampling. */
  warmup?: number
  /** Floor on trials when `samples` is unset. */
  minSamples?: number
  /** Wall-clock budget for the sampling loop, ms. */
  budgetMs?: number
  /** Runs unmeasured before every trial, warmup included. */
  prepare?: PrepareHook
  /** Exit codes treated as success (hyperfine's `--ignore-failure`): such a
   * trial still contributes its sample and never triggers `nonzero-exit`. */
  ignoreExitCodes?: number[]
}

const DEFAULT_MIN_SAMPLES = 10
const DEFAULT_BUDGET_MS = 3000
const DEFAULT_WARMUP = 3

export interface TimingPhaseResult {
  trials: Trial[]
  /** Absent when no trial produced a sample (e.g. all timed out). */
  timing?: TimingStats
  warnings: Warning[]
}

/** One command's trial loop, a trial at a time so `time()` can round-robin
 * several commands (`--interleave`). `warmup()` first, then `step()` until it
 * returns false. */
export interface TimingPhaseIterator {
  warmup(): Promise<void>
  /** Runs one more trial unless the stopping criterion is met; returns whether one ran. */
  step(): Promise<boolean>
  done(): boolean
  result(): TimingPhaseResult
}

/** `undefined` is a timed-out trial: killed, so it has no exit code to fail on. */
function isFailedExit(code: number | undefined, ignored: Set<number>): boolean {
  return code !== undefined && code !== 0 && !ignored.has(code)
}

export function createTimingPhase(
  opts: TimingPhaseOptions,
): TimingPhaseIterator {
  // Fail fast on bad options, before any trial runs.
  assertSamplingOptions("time", opts)
  if (opts.timeSource) assertReusableTimeSource(opts.timeSource)
  const warmupCount = opts.warmup ?? DEFAULT_WARMUP
  const samples = opts.samples
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES
  const budgetNs =
    samples !== undefined ? 0 : (opts.budgetMs ?? DEFAULT_BUDGET_MS) * 1e6
  const reported = opts.timeSource !== undefined
  const ignoreExitCodes = opts.ignoreExitCodes ?? []
  const ignored = new Set(ignoreExitCodes)

  const trials: Trial[] = []
  let totalNs = 0
  let i = 0
  let failedEarly = false
  // One representative excerpt is enough for the aggregate warning.
  let firstNoMatchOutput: string | undefined

  function done(): boolean {
    if (failedEarly) return true
    if (samples !== undefined) return i >= samples
    return i >= minSamples && totalNs >= budgetNs
  }

  async function trial(phase: "warmup" | "timing", index: number) {
    if (opts.prepare) {
      await runPrepare(
        opts.prepare,
        { phase, index },
        {
          cwd: opts.cwd,
          env: opts.env,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
        },
      )
    }
    return runTrial(opts)
  }

  return {
    async warmup() {
      for (let w = 0; w < warmupCount; w++) {
        if (opts.signal?.aborted) return
        await trial("warmup", w)
      }
    },
    async step() {
      if (done() || opts.signal?.aborted) return false
      const result = await trial("timing", i)
      // Killed by cancellation mid-trial: drop the truncated sample.
      if (opts.signal?.aborted) return false
      if (result.timeSourceNoMatch) {
        firstNoMatchOutput ??= result.timeSourceMissOutput
      }
      const exitCode = result.exitCode ?? undefined
      trials.push({
        i,
        wallNs: result.wallNs,
        exitCode,
        userNs: result.userNs,
        systemNs: result.systemNs,
        maxRssBytes: result.maxRssBytes,
        ...(result.reportedNs !== undefined && {
          reportedNs: result.reportedNs,
        }),
        ...(result.timedOut && { timedOut: true as const }),
        ...(result.timeSourceNoMatch && { timeSourceNoMatch: true as const }),
      })
      // The budget bounds the loop's wall time even for reported-time samples.
      totalNs += result.wallNs
      i++
      // A failing exit already makes this a harness failure; more trials can't change that.
      if (isFailedExit(exitCode, ignored)) failedEarly = true
      return true
    },
    done,
    result(): TimingPhaseResult {
      // Excluded, never a `wallNs` fallback: that would mix wall time into a reported-time series.
      const sampled = trials.filter((t) => !t.timedOut && !t.timeSourceNoMatch)
      const timingSamples = sampled.map((t) =>
        reported ? t.reportedNs! : t.wallNs,
      )

      const warnings: Warning[] = []
      const timedOutCount = trials.filter((t) => t.timedOut).length
      if (timedOutCount > 0) {
        warnings.push({
          code: "timeout",
          message: `${timedOutCount} of ${trials.length} trial(s) timed out after ${opts.timeoutMs}ms.`,
          data: { timeoutMs: opts.timeoutMs, trials: timedOutCount },
        })
      }

      const noMatchCount = trials.filter((t) => t.timeSourceNoMatch).length
      if (noMatchCount > 0 && opts.timeSource) {
        const { pattern } = opts.timeSource
        warnings.push({
          code: "time-source-no-match",
          message: `${noMatchCount} of ${trials.length} trial(s) didn't match the timeSource pattern.`,
          data: {
            pattern: typeof pattern === "string" ? pattern : pattern.source,
            trials: noMatchCount,
            ...(firstNoMatchOutput !== undefined && {
              output: firstNoMatchOutput,
            }),
          },
        })
      }

      if (timingSamples.length === 0) return { trials, warnings }

      const timing = computeTimingStats(timingSamples)
      warnings.push(
        ...timingWarnings(
          timing,
          sampled.map((t) => t.exitCode),
          reported ? "reported" : "subprocess",
          ignoreExitCodes,
        ),
      )
      return { trials, timing, warnings }
    },
  }
}

export async function drainTimingPhase(
  phase: TimingPhaseIterator,
): Promise<void> {
  await phase.warmup()
  while (await phase.step()) {}
}

export async function runTimingPhase(
  opts: TimingPhaseOptions,
): Promise<TimingPhaseResult> {
  const phase = createTimingPhase(opts)
  await drainTimingPhase(phase)
  return phase.result()
}

/** True when some trial exited non-zero (outside `ignoreExitCodes`) or none
 * produced a sample. Not a regression: `ostia time` and `ostia ci` both exit 2.
 * A timed-out trial has no exit code, so it fails the run only when no trial
 * is left to sample (the `timeout` warning covers the partial case). */
export function isHarnessFailure(
  measurement: Pick<Measurement, "trials" | "timing">,
  ignoreExitCodes: number[] = [],
): boolean {
  if (!measurement.timing) return true
  const ignored = new Set(ignoreExitCodes)
  return measurement.trials.some((t) => isFailedExit(t.exitCode, ignored))
}

export function assertSamplingOptions(
  fnName: string,
  opts: {
    samples?: number
    minSamples?: number
    budgetMs?: number
    warmup?: number
    timeoutMs?: number
  },
): void {
  for (const [key, value] of Object.entries({
    samples: opts.samples,
    minSamples: opts.minSamples,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 1)) {
      throw new RangeError(`${fnName}: ${key} must be >= 1, got ${value}`)
    }
  }
  if (opts.budgetMs !== undefined && !Number.isFinite(opts.budgetMs)) {
    throw new RangeError(
      `${fnName}: budgetMs must be finite, got ${opts.budgetMs}`,
    )
  }
  if (
    opts.warmup !== undefined &&
    (!Number.isFinite(opts.warmup) || opts.warmup < 0)
  ) {
    throw new RangeError(`${fnName}: warmup must be >= 0, got ${opts.warmup}`)
  }
  if (
    opts.timeoutMs !== undefined &&
    (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)
  ) {
    throw new RangeError(
      `${fnName}: timeoutMs must be > 0, got ${opts.timeoutMs}`,
    )
  }
}
