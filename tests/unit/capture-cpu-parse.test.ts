import { describe, expect, test } from "bun:test"
import {
  parseCpuProfile,
  type RawCpuProfile,
} from "../../src/capture/cpu/parse.ts"

const fixtureUrl = new URL(
  "../fixtures/capture/sample.cpuprofile.json",
  import.meta.url,
)
const rawFixture = (await Bun.file(fixtureUrl).json()) as RawCpuProfile

describe("parseCpuProfile", () => {
  test("parses real fixture with correct metadata and frame deduplication", () => {
    const result = parseCpuProfile(rawFixture, "cpu-prof", 100)

    expect(result.origin).toBe("cpu-prof")
    expect(result.samplingIntervalUs).toBe(100)

    expect(result.frames.length).toBe(rawFixture.nodes.length)

    const keys = new Set<string>()
    for (const frame of result.frames) {
      expect(frame.key).toBeTruthy()
      expect(typeof frame.key).toBe("string")
      keys.add(frame.key)
    }
    expect(keys.size).toBe(result.frames.length)

    expect(result.nodes.length).toBe(rawFixture.nodes.length)
    for (const node of result.nodes) {
      expect(node.frameIx).toBeGreaterThanOrEqual(0)
      expect(node.frameIx).toBeLessThan(result.frames.length)
    }

    expect(result.samples).toBeDefined()
    expect(result.samples!.nodeIds).toEqual(rawFixture.samples)
    expect(result.samples!.timeDeltasUs).toEqual(rawFixture.timeDeltas)
  })

  test("frame with empty url has undefined url property and no negative line/col", () => {
    const result = parseCpuProfile(rawFixture, "cpu-prof", 100)

    const rootFrame = result.frames.find((f) => f.name === "(root)")
    expect(rootFrame).toBeDefined()
    expect(rootFrame!.url).toBeUndefined()
    expect(rootFrame!.line).toBeUndefined()
    expect(rootFrame!.col).toBeUndefined()
  })

  test("totals are sorted descending by selfUs", () => {
    const result = parseCpuProfile(rawFixture, "cpu-prof", 100)

    for (let i = 0; i < result.totals.length - 1; i++) {
      expect(result.totals[i]!.selfUs).toBeGreaterThanOrEqual(
        result.totals[i + 1]!.selfUs,
      )
    }
  })

  test("sum of all samples in totals equals raw.samples.length", () => {
    const result = parseCpuProfile(rawFixture, "cpu-prof", 100)

    const totalSamples = result.totals.reduce((sum, t) => sum + t.samples, 0)
    expect(totalSamples).toBe(rawFixture.samples.length)
  })

  test("hotInner frame has positive selfUs and samples", () => {
    const result = parseCpuProfile(rawFixture, "cpu-prof", 100)

    const hotInnerFrame = result.frames.find((f) => f.name === "hotInner")
    expect(hotInnerFrame).toBeDefined()

    const hotInnerTotal = result.totals.find(
      (t) => result.frames[t.frameIx]!.name === "hotInner",
    )
    expect(hotInnerTotal).toBeDefined()
    expect(hotInnerTotal!.selfUs).toBeGreaterThan(0)
    expect(hotInnerTotal!.samples).toBeGreaterThan(0)
  })

  test("frame deduplication: two nodes with same functionName+url deduplicate to one frame", () => {
    const raw: RawCpuProfile = {
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "foo",
            scriptId: "1",
            url: "file:///x.ts",
            lineNumber: 1,
            columnNumber: 0,
          },
          children: [],
        },
        {
          id: 2,
          callFrame: {
            functionName: "foo",
            scriptId: "1",
            url: "file:///x.ts",
            lineNumber: 1,
            columnNumber: 0,
          },
          children: [],
        },
      ],
      samples: [1, 2],
      timeDeltas: [100, 200],
      startTime: 0,
      endTime: 300,
    }

    const result = parseCpuProfile(raw, "cpu-prof", 100)

    expect(result.frames.length).toBe(1)
    expect(result.nodes.length).toBe(2)
    expect(result.nodes[0]!.frameIx).toBe(result.nodes[1]!.frameIx)

    const total = result.totals[0]!
    expect(total.selfUs).toBe(300)
    expect(total.samples).toBe(2)
  })

  test("handles empty samples array without throwing", () => {
    const raw: RawCpuProfile = {
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "foo",
            scriptId: "1",
            url: "file:///x.ts",
            lineNumber: 0,
            columnNumber: 0,
          },
          children: [],
        },
      ],
      samples: [],
      timeDeltas: [],
      startTime: 0,
      endTime: 0,
    }

    const result = parseCpuProfile(raw, "cpu-prof", 100)

    expect(result.totals.length).toBe(1)
    expect(result.totals[0]!.selfUs).toBe(0)
    expect(result.totals[0]!.samples).toBe(0)
  })
})
