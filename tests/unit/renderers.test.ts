import { describe, expect, test } from "bun:test"
import {
  makeEntryWorkload,
  makeSubprocessWorkload,
  makeTimingRun,
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

  const runA = makeTimingRun({
    workload: wa,
    configFingerprint: "cfg_fixed",
    trials: trialsA,
    timing: computeTimingStats(samplesA),
    warnings: [],
  })
  const runB = makeTimingRun({
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
    doc.runs = [doc.runs[0]!]
    const result = await renderers.table.render(doc, {})
    expect(result.text).not.toContain("Relative")
  })

  test("table renderer scopes Relative to siblings within the same group", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))

    // Group "css": a ~41ms task and a ~20ms sibling (~2.05x apart).
    const wSlow = makeEntryWorkload(
      "suite.ts",
      "css/optimizeCssWithReport",
      "css/optimizeCssWithReport",
    )
    const wFast = makeEntryWorkload(
      "suite.ts",
      "css/optimizeCssFast",
      "css/optimizeCssFast",
    )
    // Group "strings" (alone): a ~1µs task, unrelated to group "css".
    const wTiny = makeEntryWorkload(
      "suite.ts",
      "strings/noSubstring",
      "strings/noSubstring",
    )

    const samplesSlow = [
      41_000_000, 41_200_000, 40_800_000, 41_100_000, 40_900_000,
    ]
    const samplesFast = [
      20_000_000, 20_200_000, 19_800_000, 20_100_000, 19_900_000,
    ]
    const samplesTiny = [1_000, 1_200, 800, 1_100, 900]

    const runSlow = makeTimingRun({
      workload: wSlow,
      configFingerprint: "cfg",
      trials: trials(samplesSlow),
      timing: computeTimingStats(samplesSlow),
      warnings: [],
    })
    const runFast = makeTimingRun({
      workload: wFast,
      configFingerprint: "cfg",
      trials: trials(samplesFast),
      timing: computeTimingStats(samplesFast),
      warnings: [],
    })
    const runTiny = makeTimingRun({
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

    // ~41ms is ~2.05x its group sibling (~20ms), not ~40000x the unrelated
    // near-zero task in the other group.
    expect(slowLine).toContain("2.05× slower")
  })

  test("json renderer round-trips schema-critical fields and is deterministic", async () => {
    const doc = fixedDoc()
    const result1 = await renderers.json.render(doc, {})
    const result2 = await renderers.json.render(doc, {})
    expect(result1.text).toBe(result2.text)

    const parsed = JSON.parse(result1.text!)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.workloads).toHaveLength(2)
    expect(parsed.runs).toHaveLength(2)
    expect(parsed.runs[0].instrumented).toBe(false)
    expect(parsed.runs[0].phase).toBe("timing")
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
    expect(lines).toHaveLength(1 + doc.runs.length)

    const header = JSON.parse(lines[0]!)
    expect(header.schemaVersion).toBe(1)
    expect(header.workloads).toHaveLength(2)
    expect(header.runs).toBeUndefined()

    for (let i = 0; i < doc.runs.length; i++) {
      const run = JSON.parse(lines[i + 1]!)
      expect(run.id).toBe(doc.runs[i]!.id)
      expect(run.phase).toBe("timing")
    }
  })
})
