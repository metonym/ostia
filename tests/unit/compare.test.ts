import { describe, expect, test } from "bun:test"
import {
  compareDocuments,
  compareWorkload,
  DEFAULT_THRESHOLDS,
} from "../../src/compare/index.ts"
import {
  makeInstrumentedRun,
  makeSubprocessWorkload,
  makeTimingRun,
  newDocument,
} from "../../src/ir/document.ts"
import type { CpuEvidence, Trial } from "../../src/ir/types.ts"
import { computeTimingStats } from "../../src/stats/index.ts"

function timingDoc(workloadCommand: string[], samples: number[]) {
  const workload = makeSubprocessWorkload(
    workloadCommand,
    workloadCommand.join(" "),
  )
  const trials: Trial[] = samples.map((wallNs, i) => ({
    i,
    wallNs,
    exitCode: 0,
  }))
  const run = makeTimingRun({
    workload,
    configFingerprint: "cfg_fixed",
    trials,
    timing: computeTimingStats(samples),
    warnings: [],
  })
  return { doc: newDocument([workload], [run]), workload, run }
}

describe("compareWorkload - timing", () => {
  test("flags a regression when median grows beyond the threshold", () => {
    const base = timingDoc(
      ["bun", "a.ts"],
      [10_000_000, 10_100_000, 10_200_000, 10_050_000, 10_150_000],
    )
    const cand = timingDoc(
      ["bun", "a.ts"],
      [12_000_000, 12_100_000, 12_200_000, 12_050_000, 12_150_000],
    )

    const cmp = compareWorkload(base.doc, cand.doc, base.workload.id)
    expect(cmp).toBeDefined()
    expect(cmp!.timing).toBeDefined()
    expect(cmp!.timing!.verdict).toBe("regressed")
    expect(cmp!.timing!.medianDeltaPct).toBeGreaterThan(
      DEFAULT_THRESHOLDS.timingPct,
    )
    expect(cmp!.verdict).toBe("fail")
  })

  test("passes when timing is within the noise threshold", () => {
    const base = timingDoc(
      ["bun", "a.ts"],
      [10_000_000, 10_010_000, 9_990_000, 10_005_000, 9_995_000],
    )
    const cand = timingDoc(
      ["bun", "a.ts"],
      [10_020_000, 10_030_000, 10_010_000, 10_025_000, 10_015_000],
    )

    const cmp = compareWorkload(base.doc, cand.doc, base.workload.id)
    expect(cmp!.timing!.verdict).toBe("unchanged")
    expect(cmp!.verdict).toBe("pass")
  })

  test("labels an improvement distinctly from unchanged", () => {
    const base = timingDoc(
      ["bun", "a.ts"],
      [20_000_000, 20_100_000, 20_200_000, 20_050_000, 20_150_000],
    )
    const cand = timingDoc(
      ["bun", "a.ts"],
      [10_000_000, 10_100_000, 10_200_000, 10_050_000, 10_150_000],
    )

    const cmp = compareWorkload(base.doc, cand.doc, base.workload.id)
    expect(cmp!.timing!.verdict).toBe("improved")
    expect(cmp!.timing!.medianDeltaPct).toBeLessThan(0)
    expect(cmp!.verdict).toBe("pass")
  })

  test("returns undefined for a workload absent from one document", () => {
    const base = timingDoc(["bun", "a.ts"], [10_000_000])
    const cand = timingDoc(["bun", "b.ts"], [10_000_000])
    expect(
      compareWorkload(base.doc, cand.doc, base.workload.id),
    ).toBeUndefined()
  })
})

describe("compareDocuments - batch matching by workload id", () => {
  test("only compares workloads present in both documents", () => {
    const a1 = timingDoc(["bun", "a.ts"], [10_000_000, 10_100_000, 10_050_000])
    const b1 = timingDoc(["bun", "b.ts"], [5_000_000, 5_100_000, 5_050_000])
    const base = newDocument(
      [...a1.doc.workloads, ...b1.doc.workloads],
      [...a1.doc.runs, ...b1.doc.runs],
    )

    const a2 = timingDoc(["bun", "a.ts"], [10_000_000, 10_100_000, 10_050_000])
    const cand = a2.doc

    const comparisons = compareDocuments(base, cand)
    expect(comparisons).toHaveLength(1)
    expect(comparisons[0]!.verdict).toBe("pass")
  })
})

describe("compareWorkload - CPU frame deltas", () => {
  function cpuDoc(command: string[], frameSelfUs: Record<string, number>) {
    const workload = makeSubprocessWorkload(command, command.join(" "))
    const frames = Object.keys(frameSelfUs).map((name) => ({
      key: `fr_${name}`,
      name,
    }))
    const totals = frames.map((f, i) => ({
      frameIx: i,
      selfUs: frameSelfUs[f.name]!,
      totalUs: frameSelfUs[f.name]!,
      samples: 1,
    }))
    const cpu: CpuEvidence = {
      origin: "cpu-prof",
      samplingIntervalUs: 1000,
      frames,
      nodes: [],
      totals,
    }
    const run = makeInstrumentedRun({
      workload,
      phase: "cpu",
      configFingerprint: "cfg_fixed",
      diagnosticWallNs: 1_000_000,
      cpu,
      warnings: [],
      artifacts: [],
    })
    return { doc: newDocument([workload], [run]), workload }
  }

  test("ranks frames by absolute delta and flags a regression above minFrameSelfUs floor", () => {
    const base = cpuDoc(["bun", "a.ts"], { hot: 50_000, cold: 2_000 })
    const cand = cpuDoc(["bun", "a.ts"], { hot: 80_000, cold: 2_100 })

    const cmp = compareWorkload(base.doc, cand.doc, base.workload.id)
    expect(cmp!.frames).toBeDefined()
    expect(cmp!.frames![0]!.name).toBe("hot")
    expect(cmp!.verdict).toBe("fail")
  })

  test("ignores deltas on frames below the minFrameSelfUs noise floor", () => {
    const base = cpuDoc(["bun", "a.ts"], { tiny: 10 })
    const cand = cpuDoc(["bun", "a.ts"], { tiny: 100 })

    const cmp = compareWorkload(base.doc, cand.doc, base.workload.id)
    expect(cmp!.frames![0]!.deltaPct).toBeGreaterThan(
      DEFAULT_THRESHOLDS.frameSelfPct,
    )
    expect(cmp!.verdict).toBe("pass")
  })
})
