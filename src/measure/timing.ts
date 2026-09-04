import type { TimingStats, Trial, Warning } from "../ir/types.ts"
import { runTrial, type SpawnTrialOptions } from "../spawn/index.ts"
import { computeTimingStats, timingWarnings } from "../stats/index.ts"

export interface TimingPhaseOptions extends SpawnTrialOptions {
  runs?: number
  warmup?: number
  minRuns?: number
  minTotalNs?: number
}

const DEFAULT_MIN_RUNS = 10
const DEFAULT_MIN_TOTAL_NS = 3_000_000_000
const DEFAULT_WARMUP = 3

export interface TimingPhaseResult {
  trials: Trial[]
  timing: TimingStats
  warnings: Warning[]
}

export async function runTimingPhase(
  opts: TimingPhaseOptions,
): Promise<TimingPhaseResult> {
  const warmup = opts.warmup ?? DEFAULT_WARMUP
  for (let i = 0; i < warmup; i++) {
    await runTrial(opts)
  }

  const trials: Trial[] = []
  const minRuns = opts.runs ?? opts.minRuns ?? DEFAULT_MIN_RUNS
  const minTotalNs =
    opts.runs !== undefined ? 0 : (opts.minTotalNs ?? DEFAULT_MIN_TOTAL_NS)

  let totalNs = 0
  let i = 0
  while (i < minRuns || totalNs < minTotalNs) {
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
    if (opts.runs !== undefined && i >= opts.runs) break
  }

  const samples = trials.map((t) => t.wallNs)
  const timing = computeTimingStats(samples)
  const warnings = timingWarnings(
    timing,
    trials.map((t) => t.exitCode),
  )

  return { trials, timing, warnings }
}
