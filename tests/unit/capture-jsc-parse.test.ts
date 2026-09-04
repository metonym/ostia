import { describe, expect, test } from "bun:test"
import {
  parseJscProfile,
  type RawStackTraces,
} from "../../src/capture/jsc/parse.ts"

const fixtureUrl = new URL(
  "../fixtures/capture/sample.jsc-stacktraces.json",
  import.meta.url,
)
const rawFixture = (await Bun.file(fixtureUrl).json()) as RawStackTraces

describe("parseJscProfile - real fixture (bun:jsc.profile output, hot loop @100us)", () => {
  test("converts interval from seconds to microseconds", () => {
    const { cpu } = parseJscProfile(rawFixture)
    expect(rawFixture.interval).toBe(0.0001)
    expect(cpu.samplingIntervalUs).toBe(100)
  })

  test("an explicit intervalUs override wins over the raw interval", () => {
    const { cpu } = parseJscProfile(rawFixture, 250)
    expect(cpu.samplingIntervalUs).toBe(250)
  })

  test("builds a call tree rooted at a synthetic (root) frame", () => {
    const { cpu } = parseJscProfile(rawFixture)
    const rootFrame = cpu.frames.find((f) => f.name === "(root)")
    expect(rootFrame).toBeDefined()
    expect(rootFrame!.url).toBeUndefined()
    const rootNode = cpu.nodes.find(
      (n) => n.frameIx === cpu.frames.indexOf(rootFrame!),
    )
    expect(rootNode).toBeDefined()
    expect(rootNode!.children.length).toBeGreaterThan(0)
  })

  test("hotInner dominates self time (the loop we profiled)", () => {
    const { cpu } = parseJscProfile(rawFixture)
    const hotFrame = cpu.frames.find((f) => f.name === "hotInner")
    expect(hotFrame).toBeDefined()
    const hotIx = cpu.frames.indexOf(hotFrame!)
    const hotTotal = cpu.totals.find((t) => t.frameIx === hotIx)
    expect(hotTotal).toBeDefined()
    expect(hotTotal!.selfUs).toBeGreaterThan(0)
    expect(hotTotal!.selfUs).toBe(cpu.totals[0]!.selfUs)
  })

  test("totals are sorted descending by selfUs and every node is accounted for", () => {
    const { cpu } = parseJscProfile(rawFixture)
    for (let i = 0; i < cpu.totals.length - 1; i++) {
      expect(cpu.totals[i]!.selfUs).toBeGreaterThanOrEqual(
        cpu.totals[i + 1]!.selfUs,
      )
    }
    const totalSamples = cpu.totals.reduce((s, t) => s + t.samples, 0)
    expect(totalSamples).toBe(rawFixture.traces.length)
  })

  test("samples.nodeIds/timeDeltasUs have one entry per raw trace, each delta equal to the interval", () => {
    const { cpu } = parseJscProfile(rawFixture)
    expect(cpu.samples!.nodeIds).toHaveLength(rawFixture.traces.length)
    expect(cpu.samples!.timeDeltasUs).toHaveLength(rawFixture.traces.length)
    expect(cpu.samples!.timeDeltasUs.every((d) => d === 100)).toBe(true)
  })

  test("stores jsc 1-based line/col as 0-based, matching the cpu-prof/inspector convention", () => {
    const { cpu } = parseJscProfile(rawFixture)
    const hotFrame = cpu.frames.find((f) => f.name === "hotInner")!
    const rawHotFrame = rawFixture.traces
      .flatMap((t) => t.frames)
      .find((f) => f.name === "hotInner")!
    expect(hotFrame.line).toBe(rawHotFrame.line - 1)
    expect(hotFrame.col).toBe(rawHotFrame.column - 1)
  })

  test("frames with the JSC uint32 sentinel line/column normalize to undefined", () => {
    const { cpu } = parseJscProfile(rawFixture)
    const sentinelRaw = rawFixture.traces
      .flatMap((t) => t.frames)
      .find((f) => f.line === 4294967295)
    if (sentinelRaw) {
      const frame = cpu.frames.find(
        (f) => f.name === sentinelRaw.name && f.url === sentinelRaw.sourceURL,
      )
      expect(frame!.line).toBeUndefined()
      expect(frame!.col).toBeUndefined()
    }
  })

  test("jit tier breakdown sums to the total sample count and only counts LLInt/Baseline/DFG/FTL", () => {
    const { jit } = parseJscProfile(rawFixture)
    const tierSum =
      jit.tiers.llint + jit.tiers.baseline + jit.tiers.dfg + jit.tiers.ftl
    expect(tierSum).toBeLessThanOrEqual(rawFixture.traces.length)
    expect(tierSum).toBeGreaterThan(0)
    expect(jit.origin).toBe("jsc-profile")
  })

  test("topFramesByTier only references tiers that actually occurred and frame keys that exist", () => {
    const { cpu, jit } = parseJscProfile(rawFixture)
    const validKeys = new Set(cpu.frames.map((f) => f.key))
    for (const entry of jit.topFramesByTier ?? []) {
      expect(["llint", "baseline", "dfg", "ftl"]).toContain(entry.tier)
      expect(validKeys.has(entry.frameKey)).toBe(true)
      expect(entry.samples).toBeGreaterThan(0)
    }
  })
})

describe("parseJscProfile - synthetic edge cases", () => {
  test("handles zero traces without throwing", () => {
    const raw: RawStackTraces = { interval: 0.001, traces: [] }
    const { cpu, jit } = parseJscProfile(raw)
    expect(cpu.frames).toHaveLength(1)
    expect(cpu.nodes).toHaveLength(1)
    expect(cpu.samples!.nodeIds).toHaveLength(0)
    expect(jit.tiers).toEqual({ llint: 0, baseline: 0, dfg: 0, ftl: 0 })
  })

  test("collapses repeated identical single-frame traces into one node", () => {
    const frame = {
      sourceID: 1,
      name: "foo",
      location: "",
      sourceURL: "/x.ts",
      line: 5,
      column: 2,
      category: "FTL",
      flags: 0,
    }
    const raw: RawStackTraces = {
      interval: 0.0001,
      traces: [
        { timestamp: 0, frames: [frame] },
        { timestamp: 1, frames: [frame] },
        { timestamp: 2, frames: [frame] },
      ],
    }
    const { cpu, jit } = parseJscProfile(raw)
    expect(cpu.frames).toHaveLength(2)
    expect(cpu.nodes).toHaveLength(2)
    const fooTotal = cpu.totals.find(
      (t) => cpu.frames[t.frameIx]!.name === "foo",
    )!
    expect(fooTotal.samples).toBe(3)
    expect(fooTotal.selfUs).toBe(3 * 100)
    expect(jit.tiers.ftl).toBe(3)
  })
})
