import { describe, expect, test } from "bun:test"
import {
  makeEntryWorkload,
  makeInstrumentedMeasurement,
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

  test("table renderer shows Task/Median/Spread/Range columns, not the hyperfine-shaped Command/Mean table", async () => {
    const doc = fixedDoc()
    const result = await renderers.table.render(doc, {})
    expect(result.text).toMatch(/Task\s+Median\s+Spread\s+Range/)
    expect(result.text).not.toContain("Mean [ms]")
  })

  test("table and markdown renderers print an environment header line when the document carries one", async () => {
    const doc = fixedDoc()
    doc.environment = {
      cpuModel: "Apple M2 Pro",
      cores: 12,
      loadAvg1: 2.1,
      loadAvg5: 1.8,
      noise: { floorPct: 1.8, referenceMedianNs: 500, samples: 1000 },
    }
    const table = await renderers.table.render(doc, {})
    const markdown = await renderers.markdown.render(doc, {})
    const expectedLine = "Apple M2 Pro · 12 cores · load 2.1 · noise floor 1.8%"
    expect(table.text).toContain(expectedLine)
    expect(markdown.text).toContain(expectedLine)
  })

  test("table renderer omits the environment line when the document carries none", async () => {
    const doc = fixedDoc()
    const result = await renderers.table.render(doc, {})
    expect(result.text).not.toContain("noise floor")
  })

  test("table renderer's Spread column is p75...p99, computed from TimingStats", async () => {
    const doc = fixedDoc()
    const t = doc.measurements[0]!.timing!
    const result = await renderers.table.render(doc, {})
    const line = result.text!.split("\n").find((l) => l.includes("bun a.ts"))!
    expect(line).toContain((t.p75! / 1e6).toFixed(1))
    expect(line).toContain((t.p99! / 1e6).toFixed(1))
  })

  test("table renderer falls back to median/max when p75/p99 are absent (a document saved before item 5)", async () => {
    const doc = fixedDoc()
    doc.measurements[0]!.timing!.p75 = undefined
    doc.measurements[0]!.timing!.p99 = undefined
    const result = await renderers.table.render(doc, {})
    expect(result.text).toBeDefined()
    expect(result.text!.length).toBeGreaterThan(0)
  })

  test("table renderer reads nanosecond-scale medians instead of collapsing to 0.000ms (the tiny/add defect)", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))
    // task("add", () => 1 + 2): sub-microsecond, used to render
    // "0.000 ± 0.000    0.000...0.000" when everything was formatted as ms.
    const samples = [3, 4, 3, 5, 3]
    const w = makeEntryWorkload("suite.ts", "add", { label: "add" })
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
    const result = await renderers.table.render(doc, {})
    expect(result.text).toMatch(/\d(\.\d+)? ns/)
    expect(result.text).not.toContain("0.000")
  })

  test("table renderer prints a group header once and indents its tasks; ungrouped rows stay flat", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))
    const wGrouped = makeEntryWorkload("suite.ts", "parse/small", {
      label: "parse/small",
      group: "parse",
    })
    const wFlat = makeSubprocessWorkload(["bun", "x.ts"], "bun x.ts")
    const samples = [1_000_000, 1_100_000, 900_000]
    const doc = newDocument(
      [wGrouped, wFlat],
      [
        makeTimingMeasurement({
          workload: wGrouped,
          configFingerprint: "cfg",
          trials: trials(samples),
          timing: computeTimingStats(samples),
          warnings: [],
        }),
        makeTimingMeasurement({
          workload: wFlat,
          configFingerprint: "cfg",
          trials: trials(samples),
          timing: computeTimingStats(samples),
          warnings: [],
        }),
      ],
    )
    const result = await renderers.table.render(doc, {})
    const lines = result.text!.split("\n")
    expect(lines.some((l) => l.trim() === "parse:")).toBe(true)
    expect(lines.some((l) => l.startsWith("  parse/small"))).toBe(true)
    expect(lines.some((l) => l.startsWith("bun x.ts"))).toBe(true)
  })

  test("table renderer collapses per-row warnings to a code list, with full messages in a footnote", async () => {
    const doc = fixedDoc()
    doc.measurements[1]!.warnings.push(
      { code: "outliers-detected", message: "3 outlier(s) detected." },
      { code: "below-timer-resolution", message: "Close to timer resolution." },
    )
    const result = await renderers.table.render(doc, {})
    const lines = result.text!.split("\n")
    const warningLine = lines.find((l) => l.trim().startsWith("!"))
    expect(warningLine).toContain("outliers-detected, below-timer-resolution")
    expect(result.text).toContain("Warnings:")
    expect(result.text).toContain("3 outlier(s) detected.")
    expect(result.text).toContain("Close to timer resolution.")
  })

  test("table renderer prints a task.skip()'d workload as '- skipped', still under its group header", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))
    const wMeasured = makeEntryWorkload("suite.ts", "g/measured", {
      label: "g/measured",
      group: "g",
    })
    const wSkipped = makeEntryWorkload("suite.ts", "g/skipped", {
      label: "g/skipped",
      group: "g",
      skipped: true,
    })
    const samples = [1_000_000, 1_100_000, 900_000]
    const doc = newDocument(
      [wMeasured, wSkipped],
      [
        makeTimingMeasurement({
          workload: wMeasured,
          configFingerprint: "cfg",
          trials: trials(samples),
          timing: computeTimingStats(samples),
          warnings: [],
        }),
      ],
    )
    const result = await renderers.table.render(doc, {})
    const lines = result.text!.split("\n")
    expect(lines.some((l) => l.trim() === "g:")).toBe(true)
    const skippedLine = lines.find((l) => l.includes("g/skipped"))
    expect(skippedLine).toContain("- skipped")
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
    expect(result.text).toMatch(/\|\s*Task\s*\|/)
  })

  test("markdown renderer's Timing table includes a Spread (p75...p99) column and MAD", async () => {
    const doc = fixedDoc()
    const result = await renderers.markdown.render(doc, {})
    expect(result.text).toMatch(/\|\s*Spread \(p75…p99\)\s*\|/)
    expect(result.text).toMatch(/\|\s*MAD\s*\|/)
  })

  test("markdown renderer is deterministic for the same document", async () => {
    const doc = fixedDoc()
    const a = await renderers.markdown.render(doc, {})
    const b = await renderers.markdown.render(doc, {})
    expect(a.text).toBe(b.text)
  })

  test("markdown renderer appends git sha/branch to the header line when present (item 17)", async () => {
    const doc = fixedDoc()
    doc.git = { sha: "a1b2c3d", branch: "main", dirty: false }
    const result = await renderers.markdown.render(doc, {})
    expect(result.text).toContain("a1b2c3d (main)")
  })

  test("markdown renderer marks a dirty working tree in the header line", async () => {
    const doc = fixedDoc()
    doc.git = { sha: "a1b2c3d", branch: "my-opt", dirty: true }
    const result = await renderers.markdown.render(doc, {})
    expect(result.text).toContain("a1b2c3d (my-opt, dirty)")
  })

  test("markdown renderer omits git info from the header line when absent", async () => {
    const doc = fixedDoc()
    delete doc.git
    const result = await renderers.markdown.render(doc, {})
    const headerLine = result.text!.split("\n")[2]
    expect(headerLine).toMatch(/^Bun .* ostia .* \d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
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

describe("table renderer - Alloc/op column (item 12)", () => {
  test("prints an Alloc/op column only when a memstats measurement is present", async () => {
    const doc = fixedDoc()
    const withoutAlloc = await renderers.table.render(doc, {})
    expect(withoutAlloc.text).not.toContain("Alloc/op")

    const workload = doc.workloads[0]!
    const allocRun = makeInstrumentedMeasurement({
      workload,
      phase: "memstats",
      configFingerprint: "cfg_alloc",
      diagnosticWallNs: 1_000_000,
      memory: { origin: "heapStats", bytesPerOp: 2048 },
      warnings: [],
      artifacts: [],
    })
    doc.measurements.push(allocRun)

    const withAlloc = await renderers.table.render(doc, {})
    expect(withAlloc.text).toContain("Alloc/op")
    expect(withAlloc.text).toContain("2.00KB")
  })
})

describe("jit-cold warning surfaces from a cpu measurement (item 13)", () => {
  function docWithJitColdCpuRun() {
    const doc = fixedDoc()
    const workload = doc.workloads[0]!
    const cpuRun = makeInstrumentedMeasurement({
      workload,
      phase: "cpu",
      configFingerprint: "cfg_cpu",
      diagnosticWallNs: 200_000_000,
      cpu: {
        origin: "jsc-profile",
        samplingIntervalUs: 1000,
        frames: [],
        nodes: [],
        totals: [],
      },
      jit: {
        origin: "jsc-profile",
        tiers: { llint: 40, baseline: 20, dfg: 20, ftl: 20 },
      },
      warnings: [
        {
          code: "jit-cold",
          message:
            "60.0% of CPU samples were in the llint/baseline tiers: the JIT never warmed this task up.",
          data: { llintPct: 40, baselinePct: 20, dfgPct: 20, ftlPct: 20 },
        },
      ],
      artifacts: [],
    })
    doc.measurements.push(cpuRun)
    return doc
  }

  test("table renderer prints the jit-cold message alongside the CPU capture", async () => {
    const result = await renderers.table.render(docWithJitColdCpuRun(), {})
    expect(result.text).toContain("the JIT never warmed this task up")
  })

  test("minimal renderer merges the jit-cold warning into the matching timing line", async () => {
    const result = await renderers.minimal.render(docWithJitColdCpuRun(), {})
    const lines = result
      .text!.trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    const line = lines.find((l) => l.task === "bun a.ts")
    expect(line.warnings).toEqual(
      expect.arrayContaining([
        {
          code: "jit-cold",
          data: { llintPct: 40, baselinePct: 20, dfgPct: 20, ftlPct: 20 },
        },
      ]),
    )
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

  test("exposes p75/p99/mad from TimingStats", async () => {
    const doc = fixedDoc()
    const result = await renderers.minimal.render(doc, {})
    const lines = result
      .text!.trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    for (const line of lines) {
      expect(typeof line.p75).toBe("number")
      expect(typeof line.p99).toBe("number")
      expect(typeof line.mad).toBe("number")
    }
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
          effectPct: 12.5,
          ci95: [9.1, 15.8],
          pValue: 0.0005,
          seed: 42,
          verdict: "regressed",
        },
        thresholds: {
          timingPct: 5,
          frameSelfPct: 10,
          heapTypePct: 10,
          minFrameSelfUs: 1000,
          alpha: 0.01,
          bootstrapIterations: 2000,
          effectiveTimingPct: 5,
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
      ci95: [9.1, 15.8],
      pValue: 0.0005,
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

  test("exposes params from task(name, fn, { params }) / a sweep() point", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))
    const w = makeEntryWorkload("suite.ts", "current", {
      label: "current",
      group: "parse",
      params: { size: 800, impl: "current" },
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
    expect(line.params).toEqual({ size: 800, impl: "current" })
  })

  test("emits a skipped: true line for a task.skip()'d workload, with no stats fields", async () => {
    const wMeasured = makeEntryWorkload("suite.ts", "g/measured", {
      label: "g/measured",
      group: "g",
    })
    const wSkipped = makeEntryWorkload("suite.ts", "g/skipped", {
      label: "g/skipped",
      group: "g",
      skipped: true,
    })
    const samples = [1_000_000, 1_100_000, 900_000]
    const doc = newDocument(
      [wMeasured, wSkipped],
      [
        makeTimingMeasurement({
          workload: wMeasured,
          configFingerprint: "cfg",
          trials: samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 })),
          timing: computeTimingStats(samples),
          warnings: [],
        }),
      ],
    )
    const lines = (await renderers.minimal.render(doc, {}))
      .text!.trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    const skipped = lines.find((l) => l.task === "g/skipped")
    expect(skipped).toBeDefined()
    expect(skipped.skipped).toBe(true)
    expect(skipped.group).toBe("g")
    expect(skipped.median).toBeUndefined()
    expect(skipped.samples).toBeUndefined()
  })
})

describe("markdown renderer - params: pivot table or key=value suffix", () => {
  function sweepDoc(points: { size: number; impl: string }[]) {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))
    const workloads = points.map((p) =>
      makeEntryWorkload("suite.ts", p.impl, {
        label: p.impl,
        group: "parse",
        params: { size: p.size, impl: p.impl },
      }),
    )
    const measurements = workloads.map((w, i) =>
      makeTimingMeasurement({
        workload: w,
        configFingerprint: "cfg",
        trials: trials([1_000 + i * 100, 1_050 + i * 100, 950 + i * 100]),
        timing: computeTimingStats([
          1_000 + i * 100,
          1_050 + i * 100,
          950 + i * 100,
        ]),
        warnings: [],
      }),
    )
    return newDocument(workloads, measurements)
  }

  test("a group where every task shares the same two param keys renders as a pivot table", async () => {
    const doc = sweepDoc([
      { size: 100, impl: "current" },
      { size: 100, impl: "fast" },
      { size: 800, impl: "current" },
      { size: 800, impl: "fast" },
    ])
    const result = await renderers.markdown.render(doc, {})
    expect(result.text).toContain("### parse (size × impl)")
    expect(result.text).toMatch(
      /\|\s*size \\ impl\s*\|\s*current\s*\|\s*fast\s*\|/,
    )
    // Every task went into the pivot, so no separate flat "| Task | Median | ..." table.
    expect(result.text).not.toContain("| Task | Median |")
  })

  test("params on an otherwise-flat task render as a key=value suffix instead of a pivot", async () => {
    const trials = (samples: number[]) =>
      samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 }))
    const w = makeEntryWorkload("suite.ts", "solo", {
      label: "solo",
      params: { size: 100 },
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
    const result = await renderers.markdown.render(doc, {})
    expect(result.text).toContain("solo (size=100)")
  })
})

describe("markdown renderer - task.skip() (item 10)", () => {
  test("a skipped workload renders as a '- skipped' row in the Timing table", async () => {
    const w = makeEntryWorkload("suite.ts", "solo", {
      label: "solo",
      skipped: true,
    })
    const doc = newDocument([w], [])
    const result = await renderers.markdown.render(doc, {})
    expect(result.text).toContain("## Timing")
    expect(result.text).toContain("| solo | - skipped | - | - | - | - |")
  })
})
