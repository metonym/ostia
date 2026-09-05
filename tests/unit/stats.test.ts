import { describe, expect, test } from "bun:test"
import type { TimingStats } from "../../src/ir/types.ts"
import { computeTimingStats, timingWarnings } from "../../src/stats/index.ts"

describe("computeTimingStats", () => {
  test("computes correct stats for [10, 20, 30, 40, 50]", () => {
    const samples = [10, 20, 30, 40, 50]
    const stats = computeTimingStats(samples)

    expect(stats.mean).toBe(30)
    expect(stats.median).toBe(30)
    expect(stats.min).toBe(10)
    expect(stats.max).toBe(50)
    expect(stats.stddev).toBeCloseTo(14.142135, 5)
    expect(stats.unit).toBe("ns")
    expect(stats.p75).toBe(40)
    expect(stats.p99).toBeCloseTo(49.6, 10)
    expect(stats.mad).toBe(10)
  })

  test("p75/p99/mad on a larger fixed sample (deterministic, known answers)", () => {
    // 1..100, so p-th percentile (linear interpolation, n=100) lands exactly
    // on p*99 + 1.
    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    const stats = computeTimingStats(samples)

    expect(stats.median).toBe(50.5)
    expect(stats.p75).toBeCloseTo(75.25, 10)
    expect(stats.p99).toBeCloseTo(99.01, 10)
    // |x - 50.5| for x in 1..100 ranges 0.5..49.5 in steps of 1, two values
    // per magnitude; the median of that sorted deviation list is 25.
    expect(stats.mad).toBe(25)
  })

  test("throws on empty array", () => {
    expect(() => computeTimingStats([])).toThrow()
  })

  test("detects severe outliers", () => {
    const samples = [100, 102, 101, 99, 100, 98, 101, 5000]
    const stats = computeTimingStats(samples)

    expect(stats.outliers.severe).toBeGreaterThanOrEqual(1)
  })

  test("preserves original samples array order", () => {
    const samples = [100, 102, 101, 99, 100, 98, 101, 5000]
    const stats = computeTimingStats(samples)

    expect(stats.samples).toEqual(samples)
  })
})

describe("timingWarnings", () => {
  test("detects fast-command warning when median is very small", () => {
    const stats: TimingStats = {
      unit: "ns",
      samples: [1_000_000, 1_000_000, 1_000_000],
      mean: 1_000_000,
      median: 1_000_000,
      stddev: 0,
      min: 1_000_000,
      max: 1_000_000,
      outliers: { mild: 0, severe: 0 },
    }
    const exitCodes = [0, 0, 0]

    const warnings = timingWarnings(stats, exitCodes)

    expect(warnings.some((w) => w.code === "fast-command")).toBe(true)
  })

  test("detects nonzero-exit warning when exitCodes contain non-zero values", () => {
    const stats: TimingStats = {
      unit: "ns",
      samples: [50_000_000, 50_000_000, 50_000_000, 50_000_000],
      mean: 50_000_000,
      median: 50_000_000,
      stddev: 0,
      min: 50_000_000,
      max: 50_000_000,
      outliers: { mild: 0, severe: 0 },
    }
    const exitCodes = [0, 0, 1, 0]

    const warnings = timingWarnings(stats, exitCodes)
    const nonzeroWarning = warnings.find((w) => w.code === "nonzero-exit")

    expect(nonzeroWarning).toBeDefined()
    expect(nonzeroWarning?.data?.exitCodes).toContain(1)
  })

  test("does not emit fast-command or nonzero-exit when conditions are clean", () => {
    const stats: TimingStats = {
      unit: "ns",
      samples: [50_000_000, 50_000_000, 50_000_000],
      mean: 50_000_000,
      median: 50_000_000,
      stddev: 0,
      min: 50_000_000,
      max: 50_000_000,
      outliers: { mild: 0, severe: 0 },
    }
    const exitCodes = [0, 0, 0]

    const warnings = timingWarnings(stats, exitCodes)

    const hasFastCommand = warnings.some((w) => w.code === "fast-command")
    const hasNonzeroExit = warnings.some((w) => w.code === "nonzero-exit")

    expect(hasFastCommand).toBe(false)
    expect(hasNonzeroExit).toBe(false)
  })
})
