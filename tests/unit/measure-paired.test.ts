import { describe, expect, test } from "bun:test"
import { poolOrders, summarizePaired } from "../../src/ab/index"
import { createDocument } from "../../src/ir/document"
import type { Measurement, PairedEvidence } from "../../src/ir/types"
import { instructionCounter } from "../../src/measure/instructions"
import {
  measurePaired,
  memoryChange,
  PairedSideError,
  pairedEvidence,
  ratioStats,
} from "../../src/measure/paired"
import {
  formatAbHeader,
  formatAbSummary,
  memoryCells,
  type PairedRun,
  pairedCells,
} from "../../src/renderers/paired"
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

  test.skipIf(instructionCounter().unavailable !== undefined)(
    "counts each side's instructions per call, index-aligned with the times",
    async () => {
      const result = await measurePaired(
        () => spin(2_000),
        () => spin(8_000),
        { rounds: 5 },
      )
      const { baseSamples, candSamples } = result.instructions!
      expect(baseSamples).toHaveLength(5)
      expect(candSamples).toHaveLength(5)
      // A round can still run in a lower JIT tier; the median can't.
      const { medianRatio } = ratioStats(
        candSamples.map((c, i) => c / baseSamples[i]!),
        10,
      )
      expect(medianRatio).toBeGreaterThan(3.5)
      expect(medianRatio).toBeLessThan(5)
    },
    20_000,
  )

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

  test("a result too deeply nested to compare doesn't fail the run", async () => {
    type Link = { next?: Link }
    const chain = (depth: number): Link => {
      const head: Link = {}
      let tail = head
      for (let i = 0; i < depth; i++) tail = tail.next = {}
      return head
    }
    const result = await measurePaired(
      () => chain(200_000),
      () => chain(200_000),
      { rounds: 3 },
    )
    expect(result.sameOutput).toBe(true)
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

describe("pairedEvidence", () => {
  // Time swings ±20% round to round; instructions read a steady +5%.
  const rounds = {
    rounds: 6,
    batch: 10,
    baseSamples: [100, 100, 100, 100, 100, 100],
    ratios: [1.2, 0.8, 1.2, 0.8, 1.2, 0.8],
    instructions: {
      baseSamples: [1000, 1000, 1000, 1000, 1000, 1000],
      candSamples: [1050, 1050, 1049, 1051, 1050, 1050],
    },
    sameOutput: true,
  }

  test("flags by the metric it's given", () => {
    const byTime = pairedEvidence(rounds, 3, "time")
    expect(byTime.flagged).toBeUndefined()
    expect(byTime.verdict).toBe("unchanged")
    const byInstructions = pairedEvidence(rounds, 3, "instructions")
    expect(byInstructions.flagged).toBe("regressed")
    expect(byInstructions.verdict).toBe("regressed")
    expect(byInstructions.medianRatio).toBe(byTime.medianRatio)
    expect(byInstructions.instructions).toMatchObject({
      baseMedian: 1000,
      candMedian: 1050,
    })
    expect(byInstructions.instructions!.medianRatio).toBeCloseTo(1.05)
    expect(byInstructions.instructions!.ratios).toHaveLength(6)
  })

  test("without instruction counts, the instructions metric flags nothing", () => {
    const { instructions: _, ...timeOnly } = rounds
    const p = pairedEvidence(
      { ...timeOnly, ratios: [1.5, 1.5, 1.5, 1.5, 1.5, 1.5] },
      3,
      "instructions",
    )
    expect(p.instructions).toBeUndefined()
    expect(p.flagged).toBeUndefined()
    expect(pairedEvidence({ ...p, ...timeOnly }, 3, "time").flagged).toBe(
      undefined,
    )
  })
})

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

  test("the instructions metric takes its geomean from instruction ratios", () => {
    const instructions = (medianRatio: number) => ({
      baseSamples: [],
      candSamples: [],
      baseMedian: 1000,
      candMedian: 1000 * medianRatio,
      ratios: [],
      medianRatio,
      ratioP25: medianRatio,
      ratioP75: medianRatio,
    })
    const measurements = [
      pairedMeasurement({
        medianRatio: 1.5,
        instructions: instructions(1.04),
        flagged: "regressed",
        confirmed: true,
        verdict: "regressed",
        repeats: [1.06, 1.05].map((r) => ({
          medianRatio: 0.7,
          ratioP25: 0.6,
          ratioP75: 0.8,
          instructions: { medianRatio: r, ratioP25: r, ratioP75: r },
          flagged: "regressed" as const,
        })),
      }),
      pairedMeasurement({ medianRatio: 0.5, instructions: instructions(1) }),
    ]
    const summary = summarizePaired(measurements, {
      ...settings,
      metric: "instructions",
    })
    expect(summary.metric).toBe("instructions")
    // sqrt(median(1.04, 1.06, 1.05) * 1)
    expect(summary.geomeanPct).toBeCloseTo((Math.sqrt(1.05) - 1) * 100, 5)
    expect(summarizePaired(measurements, settings).metric).toBe("time")
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

  test("pools instruction counts and flags by the metric", () => {
    const counted = (ratio: number, rounds: number) => {
      const doc = run(1, rounds)
      const base = Array.from({ length: rounds }, () => 1000)
      doc.measurements[0]!.paired!.instructions = {
        baseSamples: base,
        candSamples: base.map((b) => b * ratio),
        baseMedian: 1000,
        candMedian: 1000 * ratio,
        ratios: base.map(() => ratio),
        medianRatio: ratio,
        ratioP25: ratio,
        ratioP75: ratio,
      }
      return doc
    }
    const pooled = poolOrders(
      counted(1.05, 8),
      counted(1.04, 7),
      3,
      "instructions",
    )
    const p = pooled.measurements[0]!.paired!
    expect(p.instructions!.baseSamples).toHaveLength(15)
    expect(p.instructions!.medianRatio).toBeCloseTo(1.05)
    expect(p.verdict).toBe("regressed")
    expect(
      poolOrders(counted(1.05, 8), counted(1.04, 7), 3).measurements[0]!.paired!
        .verdict,
    ).toBe("unchanged")
    // One order uncounted: the pooled task has no instruction count.
    expect(
      poolOrders(counted(1.05, 8), run(1, 7), 3, "instructions")
        .measurements[0]!.paired!.instructions,
    ).toBeUndefined()
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

describe("pairedCells", () => {
  const run = {
    ...pairedMeasurement({
      baseMedianNs: 1000,
      medianRatio: 1.2,
      ratioP25: 1.1,
      ratioP75: 1.3,
      instructions: {
        baseSamples: [],
        candSamples: [],
        baseMedian: 2_500_000,
        candMedian: 2_625_000,
        ratios: [],
        medianRatio: 1.05,
        ratioP25: 1.04,
        ratioP75: 1.06,
      },
      flagged: "regressed",
      confirmed: true,
      verdict: "regressed",
      repeats: [
        {
          medianRatio: 0.9,
          ratioP25: 0.8,
          ratioP75: 1,
          instructions: { medianRatio: 1.06, ratioP25: 1.05, ratioP75: 1.07 },
          flagged: "regressed",
        },
      ],
    }),
    timing: computeTimingStats([1200]),
  } as PairedRun

  test("by time, the instruction change goes in `also`", () => {
    expect(pairedCells(run, "time")).toEqual({
      base: "1.00 µs",
      candidate: "1.20 µs",
      change: "+20.0%",
      spread: "+10.0%…+30.0%",
      also: "+5.0%",
      verdict: "regressed, confirmed (repeats: -10.0%)",
    })
  })

  test("by instructions, the counts and their change lead and time goes in `also`", () => {
    expect(pairedCells(run, "instructions")).toEqual({
      base: "2.50M",
      candidate: "2.63M",
      change: "+5.0%",
      spread: "+4.0%…+6.0%",
      also: "+20.0%",
      verdict: "regressed, confirmed (repeats: +6.0%)",
    })
  })

  test("the header names the instructions metric", () => {
    const ab = summarizePaired([], settings)
    expect(formatAbHeader(ab)).not.toContain("instructions")
    expect(formatAbHeader({ ...ab, metric: "instructions" })).toContain(
      "15 rounds · by instructions/call · threshold",
    )
  })
})
