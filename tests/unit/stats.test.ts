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
