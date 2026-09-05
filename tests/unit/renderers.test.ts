import { describe, expect, test } from "bun:test"
import {
  makeEntryWorkload,
  makeSubprocessWorkload,
  makeTimingMeasurement,
  newDocument,
} from "../../src/ir/document.ts"
import type { Trial } from "../../src/ir/types.ts"
import { renderers } from "../../src/renderers/index.ts"
import { computeTimingStats } from "../../src/stats/index.ts"

function fixedDoc() {
  const wa = makeSubprocessWorkload(["bun", "a.ts"], "bun a.ts")
  const wb = makeSubprocessWorkload(["bun", "b.ts"], "bun b.ts")

  const samplesA = [10_000_000, 11_000_000, 10_500_000, 10_200_000, 10_800_000]
  const samplesB = [20_000_000, 21_000_000, 20_500_000, 20_200_000, 20_800_000]
  const trialsA: Trial[] = samplesA.map((wallNs, i) => ({
    i,
    wallNs,
    exitCode: 0,
  }))
  const trialsB: Trial[] = samplesB.map((wallNs, i) => ({
    i,
    wallNs,
    exitCode: 0,
  }))

  const runA = makeTimingMeasurement({
    workload: wa,
    configFingerprint: "cfg_fixed",
    trials: trialsA,
    timing: computeTimingStats(samplesA),
    warnings: [],
  })
  const runB = makeTimingMeasurement({
    workload: wb,
    configFingerprint: "cfg_fixed",
    trials: trialsB,
    timing: computeTimingStats(samplesB),
    warnings: [],
  })

  const doc = newDocument([wa, wb], [runA, runB])
  return doc
}

describe("renderers - golden output on fixed fake data", () => {
  test("table renderer shows both commands with a relative column", async () => {
    const doc = fixedDoc()
    const result = await renderers.table.render(doc, {})
    expect(result.text).toBeDefined()
    expect(result.text).toContain("bun a.ts")
    expect(result.text).toContain("bun b.ts")
    expect(result.text).toContain("Relative")
    expect(result.text).toContain("1.00×")
    expect(result.text).toMatch(/\d\.\d\d× slower/)
  })

  test("table renderer omits Relative column for a single workload", async () => {
    const doc = fixedDoc()
    doc.workloads = [doc.workloads[0]!]
    doc.measurements = [doc.measurements[0]!]
    const result = await renderers.table.render(doc, {})
    expect(result.text).not.toContain("Relative")
  })

  test("table renderer scopes Relative to siblings within the same group", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))

    // Group "css": a ~41ms task and a ~20ms sibling (~2.05x apart).
    const wSlow = makeEntryWorkload("suite.ts", "css/optimizeCssWithReport", {
      label: "css/optimizeCssWithReport",
    })
    const wFast = makeEntryWorkload("suite.ts", "css/optimizeCssFast", {
      label: "css/optimizeCssFast",
    })
    // Group "strings" (alone): a ~1µs task, unrelated to group "css".
    const wTiny = makeEntryWorkload("suite.ts", "strings/noSubstring", {
      label: "strings/noSubstring",
    })

    const samplesSlow = [
      41_000_000, 41_200_000, 40_800_000, 41_100_000, 40_900_000,
    ]
    const samplesFast = [
      20_000_000, 20_200_000, 19_800_000, 20_100_000, 19_900_000,
    ]
    const samplesTiny = [1_000, 1_200, 800, 1_100, 900]

    const runSlow = makeTimingMeasurement({
      workload: wSlow,
      configFingerprint: "cfg",
      trials: trials(samplesSlow),
      timing: computeTimingStats(samplesSlow),
      warnings: [],
    })
    const runFast = makeTimingMeasurement({
      workload: wFast,
      configFingerprint: "cfg",
      trials: trials(samplesFast),
      timing: computeTimingStats(samplesFast),
      warnings: [],
    })
    const runTiny = makeTimingMeasurement({
      workload: wTiny,
      configFingerprint: "cfg",
      trials: trials(samplesTiny),
      timing: computeTimingStats(samplesTiny),
      warnings: [],
    })

    const doc = newDocument([wSlow, wFast, wTiny], [runSlow, runFast, runTiny])
    const result = await renderers.table.render(doc, {})
    const lines = result.text!.split("\n")
    const slowLine = lines.find((l) => l.includes("css/optimizeCssWithReport"))
    const tinyLine = lines.find((l) => l.includes("strings/noSubstring"))

    // ~41ms is ~2.05x its group sibling (~20ms), not ~40000x the unrelated
    // near-zero task in the other group.
    expect(slowLine).toContain("2.05× slower")

    // "strings" has exactly one task, so it's its own baseline: 1.00×, not a
    // multiplier against the fastest task in the whole document.
    expect(tinyLine).toContain("1.00×")
  })

  test("table renderer computes Relative against an explicit baseline task", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))

    // "old" is marked baseline even though "new" is faster: Relative should
    // read from "old", not from the group's fastest task.
    const wOld = makeEntryWorkload("suite.ts", "impl/old", {
      label: "impl/old",
      baseline: true,
    })
    const wNew = makeEntryWorkload("suite.ts", "impl/new", {
      label: "impl/new",
    })

    const samplesOld = [
      20_000_000, 20_200_000, 19_800_000, 20_100_000, 19_900_000,
    ]
    const samplesNew = [
      10_000_000, 10_200_000, 9_800_000, 10_100_000, 9_900_000,
    ]

    const runOld = makeTimingMeasurement({
      workload: wOld,
      configFingerprint: "cfg",
      trials: trials(samplesOld),
      timing: computeTimingStats(samplesOld),
      warnings: [],
    })
    const runNew = makeTimingMeasurement({
      workload: wNew,
      configFingerprint: "cfg",
      trials: trials(samplesNew),
      timing: computeTimingStats(samplesNew),
      warnings: [],
    })

    const doc = newDocument([wOld, wNew], [runOld, runNew])
    const result = await renderers.table.render(doc, {})
    const lines = result.text!.split("\n")
    const oldLine = lines.find((l) => l.includes("impl/old"))
    const newLine = lines.find((l) => l.includes("impl/new"))

    expect(oldLine).toContain("1.00× (baseline)")
    expect(newLine).toContain("2.00× faster")
  })

  test("table renderer trusts entry.group over splitting the id, so task names may contain '/'", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))
    // Both tasks are in group "diffText()"; the second task's *name* contains a
    // "/" that a lastIndexOf split would misread as a nested group.
    const wA = makeEntryWorkload("suite.ts", "diffText()/append at end", {
      label: "diffText()/append at end",
      group: "diffText()",
    })
    const wB = makeEntryWorkload(
      "suite.ts",
      "diffText()/no shared prefix/suffix",
      { label: "diffText()/no shared prefix/suffix", group: "diffText()" },
    )
    const samplesA = [20_000, 20_200, 19_800, 20_100, 19_900]
    const samplesB = [10_000, 10_200, 9_800, 10_100, 9_900]
    const doc = newDocument(
      [wA, wB],
      [
        makeTimingMeasurement({
          workload: wA,
          configFingerprint: "cfg",
          trials: trials(samplesA),
          timing: computeTimingStats(samplesA),
          warnings: [],
        }),
        makeTimingMeasurement({
          workload: wB,
          configFingerprint: "cfg",
          trials: trials(samplesB),
          timing: computeTimingStats(samplesB),
          warnings: [],
        }),
      ],
    )
    const result = await renderers.table.render(doc, {})
    const lineA = result.text!.split("\n").find((l) => l.includes("append"))
    expect(lineA).toContain("2.00× slower")
  })

  test("json renderer round-trips schema-critical fields and is deterministic", async () => {
    const doc = fixedDoc()
    const result1 = await renderers.json.render(doc, {})
    const result2 = await renderers.json.render(doc, {})
    expect(result1.text).toBe(result2.text)

    const parsed = JSON.parse(result1.text!)
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.workloads).toHaveLength(2)
    expect(parsed.measurements).toHaveLength(2)
    expect(parsed.measurements[0].instrumented).toBe(false)
    expect(parsed.measurements[0].phase).toBe("timing")
  })

  test("markdown renderer includes a timing table with both commands", async () => {
    const doc = fixedDoc()
    const result = await renderers.markdown.render(doc, {})
    expect(result.text).toContain("# Profile Report")
    expect(result.text).toContain("## Timing")
    expect(result.text).toContain("bun a.ts")
    expect(result.text).toContain("bun b.ts")
    expect(result.text).toMatch(/\|\s*Command\s*\|/)
  })

  test("markdown renderer is deterministic for the same document", async () => {
    const doc = fixedDoc()
    const a = await renderers.markdown.render(doc, {})
    const b = await renderers.markdown.render(doc, {})
    expect(a.text).toBe(b.text)
  })

  test("jsonl renderer emits one header line plus one line per run, each valid JSON", async () => {
    const doc = fixedDoc()
    const result = await renderers.jsonl.render(doc, {})
    const lines = result.text!.trim().split("\n")
    expect(lines).toHaveLength(1 + doc.measurements.length)

    const header = JSON.parse(lines[0]!)
    expect(header.schemaVersion).toBe(2)
    expect(header.workloads).toHaveLength(2)
    expect(header.measurements).toBeUndefined()

    for (let i = 0; i < doc.measurements.length; i++) {
      const run = JSON.parse(lines[i + 1]!)
      expect(run.id).toBe(doc.measurements[i]!.id)
      expect(run.phase).toBe("timing")
    }
  })
})

describe("minimal renderer - one compact JSON object per timing run", () => {
  test("emits one line per task with stats, no raw sample array, and warning codes with data", async () => {
    const doc = fixedDoc()
    doc.measurements[1]!.warnings.push({
      code: "low-sample-count",
      message: "thin",
      data: { samples: 3, target: 7 },
    })
    const result = await renderers.minimal.render(doc, {})
    const lines = result.text!.trim().split("\n")
    expect(lines).toHaveLength(2)

    const a = JSON.parse(lines[0]!)
    const b = JSON.parse(lines[1]!)
    expect(a.task).toBe("bun a.ts")
    expect(a.unit).toBe("ns")
    expect(a.samples).toBe(5)
    expect(Array.isArray(a.samples)).toBe(false)
    expect(a.mean).toBeCloseTo(10_500_000, -3)
    expect(a.median).toBe(10_500_000)
    expect(typeof a.stddevPct).toBe("number")
    expect(a.relative).toBe(1)
    expect(a.warnings).toEqual([])
    expect(b.relative).toBeCloseTo(1.952, 2)
    expect(b.warnings).toEqual([
      { code: "low-sample-count", data: { samples: 3, target: 7 } },
    ])
    for (const key of Object.keys(b)) expect(key).not.toBe("message")
  })

  test("carries task/group descriptions, group, and baseline flag from the workload", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))
    const w = makeEntryWorkload("suite.ts", "parse/small", {
      label: "parse/small",
      group: "parse",
      baseline: true,
      description: "small input, exercises the fast path",
      groupDescription: "parser throughput",
    })
    const samples = [1_000, 1_100, 900]
    const doc = newDocument(
      [w],
      [
        makeTimingMeasurement({
          workload: w,
          configFingerprint: "cfg",
          trials: trials(samples),
          timing: computeTimingStats(samples),
          warnings: [],
        }),
      ],
    )
    const line = JSON.parse((await renderers.minimal.render(doc, {})).text!)
    expect(line.task).toBe("parse/small")
    expect(line.group).toBe("parse")
    expect(line.description).toBe("small input, exercises the fast path")
    expect(line.groupDescription).toBe("parser throughput")
    expect(line.baseline).toBe(true)
    // Single timing run: no Relative, same as the table.
    expect(line.relative).toBeUndefined()
  })

  test("includes the comparison delta per task when the document has comparisons", async () => {
    const doc = fixedDoc()
    doc.comparisons = [
      {
        id: "cmp_x",
        baselineMeasurementId: "run_base",
        candidateMeasurementId: doc.measurements[0]!.id,
        timing: {
          medianDeltaPct: 12.5,
          meanDeltaPct: 11,
          verdict: "regressed",
        },
        thresholds: {
          timingPct: 5,
          frameSelfPct: 10,
          heapTypePct: 10,
          minFrameSelfUs: 1000,
        },
        verdict: "fail",
      },
    ]
    const lines = (await renderers.minimal.render(doc, {}))
      .text!.trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines[0]!.delta).toEqual({
      medianPct: 12.5,
      meanPct: 11,
      verdict: "regressed",
      pass: false,
    })
    expect(lines[1]!.delta).toBeUndefined()
  })

  test("is far smaller than the full document for a many-sample run", async () => {
    const doc = fixedDoc()
    const big = Array.from({ length: 20_000 }, (_, i) => 10_000 + (i % 7))
    doc.measurements[0]!.timing = computeTimingStats(big)
    doc.measurements[0]!.trials = big.map((wallNs, i) => ({ i, wallNs }))
    const full = (await renderers.json.render(doc, {})).text!
    const minimal = (await renderers.minimal.render(doc, {})).text!
    expect(minimal.length).toBeLessThan(full.length / 100)
    expect(JSON.parse(minimal.trim().split("\n")[0]!).samples).toBe(20_000)
  })
})
