import type { TimingStats, Warning } from "../ir/types.ts"

export function computeTimingStats(samples: number[]): TimingStats {
  if (samples.length === 0) {
    throw new Error("computeTimingStats: samples must be non-empty")
  }
  const n = samples.length
  const sorted = sortedCopy(samples)
  let total = 0
  for (let i = 0; i < n; i++) total += samples[i]!
  const mean = total / n
  const median = percentile(sorted, 0.5)
  let squaredDeviation = 0
  for (let i = 0; i < n; i++) {
    const d = samples[i]! - mean
    squaredDeviation += d * d
  }
  const stddev = Math.sqrt(squaredDeviation / n)
  const min = sorted[0]!
  const max = sorted[n - 1]!

  const q1 = percentile(sorted, 0.25)
  const q3 = percentile(sorted, 0.75)
  const iqr = q3 - q1
  const mildLow = q1 - 1.5 * iqr
  const mildHigh = q3 + 1.5 * iqr
  const severeLow = q1 - 3 * iqr
  const severeHigh = q3 + 3 * iqr

  let mild = 0
  let severe = 0
  for (let i = 0; i < n; i++) {
    const s = samples[i]!
    if (s < severeLow || s > severeHigh) severe++
    else if (s < mildLow || s > mildHigh) mild++
  }

  const p99 = percentile(sorted, 0.99)
  const deviations = new Float64Array(n)
  for (let i = 0; i < n; i++) deviations[i] = Math.abs(samples[i]! - median)
  deviations.sort()
  const mad = percentile(deviations, 0.5)

  return {
    unit: "ns",
    samples,
    mean,
    median,
    stddev,
    min,
    max,
    outliers: { mild, severe },
    p75: q3,
    p99,
    mad,
  }
}

function sortedCopy(samples: number[]): Float64Array {
  const sorted = new Float64Array(samples.length)
  sorted.set(samples)
  sorted.sort()
  return sorted
}

function percentile(sorted: Float64Array, p: number): number {
  const n = sorted.length
  if (n === 1) return sorted[0]!
  const idx = p * (n - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  const frac = idx - lo
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac
}

const FAST_COMMAND_NS = 5_000_000
const TIMER_RESOLUTION_NS = 200

export type TimingMode = "subprocess" | "inprocess"

export function timingWarnings(
  stats: TimingStats,
  exitCodes: (number | undefined)[],
  mode: TimingMode = "subprocess",
): Warning[] {
  const warnings: Warning[] = []

  const first = stats.samples[0]
  if (first !== undefined) {
    const sorted = sortedCopy(stats.samples)
    const q1 = percentile(sorted, 0.25)
    const q3 = percentile(sorted, 0.75)
    const iqr = q3 - q1
    if (first > stats.median + 3 * iqr && iqr > 0) {
      warnings.push({
        code: "slow-first-run",
        message: `First run took ${(first / 1e6).toFixed(2)}ms, much slower than the median ${(stats.median / 1e6).toFixed(2)}ms. Consider more warmup.`,
        data: { firstNs: first, medianNs: stats.median },
      })
    }
  }

  if (stats.outliers.mild + stats.outliers.severe > 0) {
    warnings.push({
      code: "outliers-detected",
      message: `${stats.outliers.mild + stats.outliers.severe} outlier(s) detected (${stats.outliers.severe} severe, ${stats.outliers.mild} mild).`,
      data: stats.outliers,
    })
  }

  if (mode === "subprocess" && stats.median < FAST_COMMAND_NS) {
    warnings.push({
      code: "fast-command",
      message: `Median run time (${(stats.median / 1e6).toFixed(3)}ms) is very fast; results may be dominated by spawn overhead.`,
      data: { medianNs: stats.median },
    })
  }

  if (mode === "inprocess" && stats.median < TIMER_RESOLUTION_NS) {
    warnings.push({
      code: "below-timer-resolution",
      message: `Median run time (${stats.median.toFixed(0)}ns) is close to timer resolution; consider a larger batch size or a coarser operation.`,
      data: { medianNs: stats.median },
    })
  }

  const nonZero = exitCodes.filter((c) => c !== undefined && c !== 0)
  if (nonZero.length > 0) {
    warnings.push({
      code: "nonzero-exit",
      message: `${nonZero.length} of ${exitCodes.length} trial(s) exited non-zero.`,
      data: { exitCodes: nonZero },
    })
  }

  return warnings
}
