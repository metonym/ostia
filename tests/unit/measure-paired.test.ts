import { describe, expect, test } from "bun:test"
import { poolOrders, summarizePaired } from "../../src/ab/index"
import { createDocument } from "../../src/ir/document"
import type { Measurement, PairedEvidence } from "../../src/ir/types"
import {
  measurePaired,
  memoryChange,
  PairedSideError,
  ratioStats,
} from "../../src/measure/paired"
import { formatAbSummary, memoryCells } from "../../src/renderers/paired"
import { computeTimingStats } from "../../src/stats/index"

function spin(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}

describe("memoryChange", () => {
  test("flags a change past both the percent threshold and the floor", () => {
    expect(memoryChange(1000, 2000, 10, 100).verdict).toBe("regressed")
    expect(memoryChange(2000, 1000, 10, 100).verdict).toBe("improved")
  })

  test("a change under the floor is unchanged, however large in percent", () => {
    // 0 to 80 bytes: one heap block over a 100-call batch.
    expect(memoryChange(0, 80, 10, 164).verdict).toBe("unchanged")
    expect(memoryChange(0, 8000, 10, 164).verdict).toBe("regressed")
  })

  test("a change under the percent threshold is unchanged, however large in bytes", () => {
    const mib = 1024 * 1024
    const change = memoryChange(100 * mib, 105 * mib, 10, mib)
    expect(change.verdict).toBe("unchanged")
    expect(change.floorBytes).toBe(mib)
  })
})

describe("ratioStats", () => {
  test("flags a regression when the median and the 25th percentile are both past the threshold", () => {
    const stats = ratioStats([1.3, 1.25, 1.35, 1.28, 1.32, 1.3, 1.29], 10)
    expect(stats.flagged).toBe("regressed")
    expect(stats.medianRatio).toBeCloseTo(1.3)
  })

  test("flags an improvement symmetrically", () => {
    const stats = ratioStats([0.7, 0.72, 0.68, 0.71, 0.69], 10)
    expect(stats.flagged).toBe("improved")
  })

  test("a median past the threshold isn't enough when a quarter of rounds were faster", () => {
    // Median 1.2, but p25 is below 1: the candidate wasn't consistently slower.
    const stats = ratioStats([0.8, 0.85, 0.9, 1.2, 1.2, 1.25, 1.3, 1.3], 10)
    expect(stats.medianRatio).toBeGreaterThan(1.1)
    expect(stats.ratioP25).toBeLessThan(1)
    expect(stats.flagged).toBeUndefined()
  })

  test("a consistent change under the threshold isn't flagged", () => {
    const stats = ratioStats([1.05, 1.06, 1.04, 1.05, 1.05], 10)
    expect(stats.flagged).toBeUndefined()
    expect(stats.ratioP25).toBeGreaterThan(1)
  })
})

describe("measurePaired", () => {
  test("returns index-aligned per-round samples and ratios", async () => {
    const result = await measurePaired(
      () => spin(2_000),
      () => spin(2_000),
      { rounds: 5 },
    )
    expect(result.rounds).toBe(5)
    expect(result.baseSamples).toHaveLength(5)
    expect(result.candSamples).toHaveLength(5)
    expect(result.ratios).toHaveLength(5)
    expect(result.batch).toBeGreaterThanOrEqual(1)
    for (let i = 0; i < 5; i++) {
      expect(result.ratios[i]).toBeCloseTo(
        result.candSamples[i]! / result.baseSamples[i]!,
      )
    }
    expect(result.sameOutput).toBe(true)
  }, 20_000)

  test("sees a candidate doing several times the work as several times slower", async () => {
    const result = await measurePaired(
      () => spin(2_000),
      () => spin(8_000),
      { rounds: 7 },
    )
    const { medianRatio, flagged } = ratioStats(result.ratios, 10)
    expect(medianRatio).toBeGreaterThan(2)
    expect(flagged).toBe("regressed")
  }, 20_000)

  test("candFirst gives the candidate the first call, warmup and batches", async () => {
    for (const candFirst of [false, true]) {
      const calls: string[] = []
      await measurePaired(
        () => calls.push("base"),
        () => calls.push("cand"),
        { rounds: 3, candFirst },
      )
      const first = candFirst ? "cand" : "base"
      // The first call, then that side's whole warmup.
      expect(calls.slice(0, 2)).toEqual([
        first,
        first === "base" ? "cand" : "base",
      ])
      expect(calls[2]).toBe(first)
      expect(calls[3]).toBe(first)
    }
  }, 20_000)

  test("compares the two sides' first return values", async () => {
    const result = await measurePaired(
      () => ({ out: spin(100) }),
      () => ({ out: spin(101) }),
      { rounds: 3 },
    )
    expect(result.sameOutput).toBe(false)
  }, 20_000)

  test("a slow side isn't over-run while a fast side's warmup catches up", async () => {
    let slowCalls = 0
    const slow = () => {
      slowCalls++
      const end = Bun.nanoseconds() + 2_000_000
      while (Bun.nanoseconds() < end) {}
    }
    await measurePaired(() => 1, slow, { rounds: 3 })
    // Probe + one calibration call + ~5-call batches for 3 warm and 3 timed rounds.
    expect(slowCalls).toBeLessThan(100)
  }, 20_000)

  test("rejects with the signal's reason when aborted", async () => {
    const aborted = AbortSignal.abort(new Error("stop"))
    await expect(
      measurePaired(
        () => 1,
        () => 2,
        { signal: aborted },
      ),
    ).rejects.toThrow("stop")

    const controller = new AbortController()
    let calls = 0
    await expect(
      measurePaired(
        () => {
          if (++calls === 50) controller.abort(new Error("mid-run"))
          return spin(2_000)
        },
        () => spin(2_000),
        { rounds: 5000, signal: controller.signal },
      ),
    ).rejects.toThrow("mid-run")
  }, 20_000)

  test("works with async tasks", async () => {
    const result = await measurePaired(
      async () => spin(500),
      async () => spin(500),
      { rounds: 3 },
    )
    expect(result.ratios).toHaveLength(3)
    expect(result.sameOutput).toBe(true)
  }, 20_000)
})

describe("measurePaired - a side that throws", () => {
  test("rejects with a PairedSideError naming the side", async () => {
    const err = await measurePaired(
      () => spin(100),
      () => {
        throw new TypeError("boom")
      },
      { rounds: 3 },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PairedSideError)
    expect((err as PairedSideError).side).toBe("cand")
    expect((err as PairedSideError).message).toBe("boom")
    expect((err as PairedSideError).cause).toBeInstanceOf(TypeError)
  })

  test("names the side when it throws only after warmup", async () => {
    let calls = 0
    const err = await measurePaired(
      () => {
        if (++calls > 10) throw new Error("late")
        return spin(100)
      },
      () => spin(100),
      { rounds: 3 },
    ).catch((e: unknown) => e)
    expect((err as PairedSideError).side).toBe("base")
  })
})

function threwMeasurement(side: "base" | "cand" | "both"): Measurement {
  return {
    id: "t",
    workloadId: "t",
    phase: "paired",
    instrumented: false,
    configFingerprint: "cfg",
    trials: [],
    warnings: [],
    artifacts: [],
    threw: { side, message: "boom" },
  }
}

function pairedMeasurement(p: Partial<PairedEvidence>): Measurement {
  return {
    id: "m",
    workloadId: "w",
    phase: "paired",
    instrumented: false,
    configFingerprint: "cfg",
    trials: [],
    warnings: [],
    artifacts: [],
    paired: {
      rounds: 15,
      batch: 1,
      baseSamples: [],
      baseMedianNs: 1,
      ratios: [],
      medianRatio: 1,
      ratioP25: 1,
      ratioP75: 1,
      verdict: "unchanged",
      sameOutput: true,
      ...p,
    },
  }
}

const settings = {
  base: { ref: "HEAD", sha: "abc" },
  rounds: 15,
  thresholdPct: 10,
  geomeanThresholdPct: 1.5,
}

describe("summarizePaired", () => {
  test("passes when nothing regressed and the geomean is under its threshold", () => {
    const summary = summarizePaired(
      [
        pairedMeasurement({ medianRatio: 1.01 }),
        pairedMeasurement({ medianRatio: 0.99 }),
      ],
      settings,
    )
    expect(summary.matched).toBe(2)
    expect(summary.geomeanPct).toBeCloseTo(0, 1)
    expect(summary.verdict).toBe("pass")
  })

  test("fails on a broad slowdown that flags no single workload", () => {
    const summary = summarizePaired(
      [1.03, 1.02, 1.03, 1.02].map((r) =>
        pairedMeasurement({ medianRatio: r }),
      ),
      settings,
    )
    expect(summary.regressed).toBe(0)
    expect(summary.geomeanPct!).toBeGreaterThan(1.5)
    expect(summary.verdict).toBe("fail")
  })

  test("counts confirmed verdicts, and flagged-but-unconfirmed ones as unchanged", () => {
    const summary = summarizePaired(
      [
        pairedMeasurement({
          medianRatio: 1.5,
          flagged: "regressed",
          confirmed: true,
          verdict: "regressed",
          repeats: [
            {
              medianRatio: 1.5,
              ratioP25: 1.4,
              ratioP75: 1.6,
              flagged: "regressed",
            },
          ],
        }),
        pairedMeasurement({
          medianRatio: 1.3,
          flagged: "regressed",
          confirmed: false,
          verdict: "unchanged",
          repeats: [{ medianRatio: 1.0, ratioP25: 0.9, ratioP75: 1.1 }],
        }),
        pairedMeasurement({ sameOutput: false }),
      ],
      { ...settings, geomeanThresholdPct: 100 },
    )
    expect(summary.regressed).toBe(1)
    expect(summary.unchanged).toBe(2)
    expect(summary.unconfirmed).toBe(1)
    expect(summary.outputDiffers).toBe(1)
    expect(summary.verdict).toBe("fail")
  })

  test("a flagged workload's geomean contribution is the median over its main run and repeats", () => {
    const summary = summarizePaired(
      [
        pairedMeasurement({
          medianRatio: 1.24,
          flagged: "regressed",
          confirmed: false,
          verdict: "unchanged",
          repeats: [
            { medianRatio: 1.0, ratioP25: 0.95, ratioP75: 1.05 },
            { medianRatio: 1.01, ratioP25: 0.95, ratioP75: 1.05 },
          ],
        }),
      ],
      settings,
    )
    expect(summary.geomeanPct).toBeCloseTo(1, 5)
  })

  test("fails when a task threw on the candidate side only", () => {
    for (const [side, verdict] of [
      ["cand", "fail"],
      ["base", "pass"],
      ["both", "pass"],
    ] as const) {
      const summary = summarizePaired(
        [pairedMeasurement({}), threwMeasurement(side)],
        settings,
      )
      expect(summary.threw).toBe(1)
      expect(summary.matched).toBe(1)
      expect(summary.verdict).toBe(verdict)
    }
  })

  test("leaves a changed suite with changed output out of the geomean", () => {
    const summary = summarizePaired(
      [
        pairedMeasurement({ medianRatio: 1 }),
        pairedMeasurement({
          medianRatio: 30,
          suiteChanged: true,
          sameOutput: false,
        }),
        pairedMeasurement({ medianRatio: 1, suiteChanged: true }),
      ],
      settings,
    )
    expect(summary.notComparable).toBe(1)
    expect(summary.geomeanPct).toBeCloseTo(0, 5)
    expect(summary.verdict).toBe("pass")
  })

  test("geomean is null when nothing was paired", () => {
    const summary = summarizePaired([], settings)
    expect(summary.matched).toBe(0)
    expect(summary.geomeanPct).toBeNull()
    expect(summary.verdict).toBe("pass")
  })

  test("a memory regression fails the run; memory counts each task once", () => {
    const retained = (base: number, cand: number) =>
      memoryChange(base, cand, 10, 100)
    const summary = summarizePaired(
      [
        pairedMeasurement({ retained: retained(0, 8000) }),
        pairedMeasurement({
          retained: retained(4000, 0),
          peak: memoryChange(10e6, 2e6, 10, 1e6),
        }),
        pairedMeasurement({ medianRatio: 1 }),
      ],
      { ...settings, memThresholdPct: 10 },
    )
    expect(summary.regressed).toBe(0)
    expect(summary.memory).toEqual({
      thresholdPct: 10,
      regressed: 1,
      improved: 1,
    })
    expect(summary.verdict).toBe("fail")
    expect(formatAbSummary(summary)).toContain(
      "· memory: 1 regressed, 1 improved · fail",
    )
  })

  test("no memory summary without memory readings", () => {
    const summary = summarizePaired([pairedMeasurement({})], settings)
    expect(summary.memory).toBeUndefined()
    expect(formatAbSummary(summary)).not.toContain("memory")
  })
})

describe("memoryCells", () => {
  const cells = (base: number, cand: number, floor: number) =>
    memoryCells({
      run: undefined as never,
      reading: "peak",
      change: memoryChange(base, cand, 10, floor),
    })

  test("shows the byte change, with a percent unless the base is under the floor", () => {
    const mib = 1024 * 1024
    expect(cells(2 * mib, mib, 0)).toEqual({
      reading: "peak",
      base: "2.00MiB",
      candidate: "1.00MiB",
      change: "-1.00MiB (-50.0%)",
      verdict: "improved",
    })
    expect(cells(0, 2048, 100).change).toBe("+2.00KiB")
    expect(cells(21, 8069, 164).change).toBe("+7.86KiB")
    // Medians of fractional bytes per call round to whole bytes.
    expect(cells(0.1, 0.32, 100).change).toBe("0B")
    expect(cells(64, 64, 100)).toMatchObject({
      change: "0B",
      verdict: "",
    })
  })
})

describe("poolOrders", () => {
  /** A one-order run of one workload whose rounds all read `ratio`. */
  const run = (ratio: number, rounds: number) => {
    const baseSamples = Array.from({ length: rounds }, () => 100)
    const candSamples = baseSamples.map((b) => b * ratio)
    const stats = ratioStats(
      candSamples.map((c, i) => c / baseSamples[i]!),
      10,
    )
    return createDocument(
      [],
      [
        {
          ...pairedMeasurement({
            rounds,
            baseSamples,
            baseMedianNs: 100,
            ratios: candSamples.map((c, i) => c / baseSamples[i]!),
            ...stats,
            verdict: stats.flagged ?? "unchanged",
          }),
          timing: computeTimingStats(candSamples),
        },
      ],
    )
  }

  test("a bias that flips with the order cancels", () => {
    // Base first reads 12% slower; candidate first, 12% faster.
    const pooled = poolOrders(run(1.12, 8), run(0.88, 7), 10)
    const m = pooled.measurements[0]!
    expect(run(1.12, 8).measurements[0]!.paired!.flagged).toBe("regressed")
    expect(m.paired!.rounds).toBe(15)
    expect(m.paired!.ratios).toHaveLength(15)
    expect(m.timing!.samples).toHaveLength(15)
    expect(m.paired!.flagged).toBeUndefined()
    expect(m.paired!.verdict).toBe("unchanged")
  })

  test("a change in both orders stays flagged", () => {
    const pooled = poolOrders(run(1.3, 8), run(1.2, 7), 10)
    expect(pooled.measurements[0]!.paired!.verdict).toBe("regressed")
  })

  test("a throw in either order counts; different sides make both", () => {
    const threw = (side: "base" | "cand") =>
      createDocument(
        [],
        [{ ...pairedMeasurement({}), threw: { side, message: side } }],
      )
    const once = poolOrders(run(1, 8), threw("cand"), 10).measurements[0]!
    expect(once.threw?.side).toBe("cand")
    const both = poolOrders(threw("base"), threw("cand"), 10).measurements[0]!
    expect(both.threw).toEqual({ side: "both", message: "base\ncand" })
  })
})
