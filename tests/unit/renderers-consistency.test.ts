import { describe, expect, test } from "bun:test"
import { compareDocuments } from "../../src/compare/index.ts"
import {
  createDocument,
  makeEntryWorkload,
  makeSubprocessWorkload,
  makeTimingMeasurement,
} from "../../src/ir/document.ts"
import type { ProfileDocument } from "../../src/ir/types.ts"
import {
  formatBytes,
  formatHeapSummary,
  formatSignedPct,
} from "../../src/renderers/format.ts"
import { renderers } from "../../src/renderers/index.ts"
import { computeTimingStats } from "../../src/stats/index.ts"

function timing(workload: ReturnType<typeof makeEntryWorkload>, ns: number[]) {
  return makeTimingMeasurement({
    workload,
    configFingerprint: "cfg",
    trials: ns.map((wallNs, i) => ({ i, wallNs, exitCode: 0 })),
    timing: computeTimingStats(ns),
    warnings: [],
  })
}

describe("formatSignedPct", () => {
  test("signs non-zero deltas and leaves zero unsigned", () => {
    expect(formatSignedPct(3.24)).toBe("+3.2%")
    expect(formatSignedPct(-1.5)).toBe("-1.5%")
    expect(formatSignedPct(0)).toBe("0.0%")
    expect(formatSignedPct(-0)).toBe("0.0%")
    expect(formatSignedPct(0.04)).toBe("0.0%")
    expect(formatSignedPct(-0.04)).toBe("0.0%")
  })
})

describe("byte formatting", () => {
  test("formatBytes and the heap summary share 1024-based IEC units", () => {
    expect(formatBytes(512)).toBe("512B")
    expect(formatBytes(2048)).toBe("2.00KiB")
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00MiB")
    expect(
      formatHeapSummary({
        origin: "heap-prof",
        objectCount: 1200,
        heapSizeBytes: 3 * 1024 * 1024,
        typeCounts: [],
      }),
    ).toBe("1200 objects, 3.00MiB")
  })
})

describe("grouping is shared by the table and markdown renderers", () => {
  test("markdown pivots a legacy (no entry.group) 'group/name' id like the table groups it", async () => {
    // No explicit `group`: both renderers derive "g" by splitting the id.
    const a = makeEntryWorkload("s.ts", "g/a", { params: { n: 1, m: 2 } })
    const b = makeEntryWorkload("s.ts", "g/b", { params: { n: 1, m: 3 } })
    const doc = createDocument(
      [a, b],
      [timing(a, [1000, 1100, 1050]), timing(b, [2000, 2100, 2050])],
    )
    const md = (await renderers.markdown.render(doc, {})).text!
    expect(md).toContain("### g (n × m)")
    const table = (await renderers.table.render(doc, {})).text!
    expect(table).toContain("g:")
  })
})

describe("a comparison whose workload is missing from the document", () => {
  async function renderBoth() {
    const w = makeSubprocessWorkload(["bun", "a.ts"], "bun a.ts")
    const samples = [1_000_000, 1_010_000, 990_000, 1_005_000, 995_000]
    const make = (): ProfileDocument =>
      createDocument(
        [w],
        [
          makeTimingMeasurement({
            workload: w,
            configFingerprint: "cfg",
            trials: samples.map((wallNs, i) => ({ i, wallNs, exitCode: 0 })),
            timing: computeTimingStats(samples),
            warnings: [],
          }),
        ],
      )
    const base = make()
    const cand = make()
    cand.comparisons = compareDocuments(base, cand).comparisons
    cand.workloads = []
    return {
      id: w.id,
      table: (await renderers.table.render(cand, {})).text!,
      markdown: (await renderers.markdown.render(cand, {})).text!,
    }
  }

  test("is labelled by its raw workload id in both, not 'unknown'", async () => {
    const { id, table, markdown } = await renderBoth()
    expect(table).toContain(`✓ ${id}`)
    expect(markdown).toContain(`### ✓ ${id}`)
    expect(markdown).not.toContain("unknown")
  })

  test("a zero delta prints unsigned in both", async () => {
    const { table, markdown } = await renderBoth()
    expect(table).toMatch(/timing: 0\.0% median/)
    expect(markdown).toMatch(/- timing: ~?0\.0% median/)
  })
})

describe("minimal summary verdict follows the documented exit codes", () => {
  async function verdict(exitCode: number) {
    const w = makeSubprocessWorkload(["bun", "a.ts"], "bun a.ts")
    const doc = createDocument([w], [])
    const text = (
      await renderers.minimal.render(doc, {
        protocol: { command: "ci", exitCode },
      })
    ).text!
    return JSON.parse(text.trim().split("\n").at(-1)!).verdict
  }

  test("0 is pass, 1 is fail, anything else (harness error, cancelled) is error", async () => {
    expect(await verdict(0)).toBe("pass")
    expect(await verdict(1)).toBe("fail")
    expect(await verdict(2)).toBe("error")
    expect(await verdict(130)).toBe("error")
  })
})
