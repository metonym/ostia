import { describe, expect, test } from "bun:test"
import {
  makeArtifactRef,
  makeInstrumentedMeasurement,
  makeSubprocessWorkload,
  newDocument,
} from "../../src/ir/document.ts"
import type { CallNode, CpuEvidence, Frame } from "../../src/ir/types.ts"
import {
  buildParentMap,
  computeNodeTimes,
  findRootId,
  pathToRoot,
  selectCpuRuns,
} from "../../src/renderers/cpu-tree.ts"
import { renderers } from "../../src/renderers/index.ts"

function fixedCpu(): CpuEvidence {
  const frames: Frame[] = [
    { key: "fr_root", name: "(root)" },
    { key: "fr_module", name: "(module)", url: "/x.ts", line: 0 },
    { key: "fr_a", name: "a", url: "/x.ts", line: 1 },
    { key: "fr_b", name: "b", url: "/x.ts", line: 2 },
    { key: "fr_c", name: "c", url: "/x.ts", line: 3 },
  ]
  const nodes: CallNode[] = [
    { id: 1, frameIx: 0, children: [2] },
    { id: 2, frameIx: 1, children: [3, 5] },
    { id: 3, frameIx: 2, children: [4] },
    { id: 4, frameIx: 3, children: [] },
    { id: 5, frameIx: 4, children: [] },
  ]
  return {
    origin: "cpu-prof",
    samplingIntervalUs: 1000,
    frames,
    nodes,
    totals: [
      { frameIx: 3, selfUs: 3000, totalUs: 3000, samples: 3 },
      { frameIx: 4, selfUs: 1000, totalUs: 1000, samples: 2 },
      { frameIx: 2, selfUs: 0, totalUs: 3000, samples: 0 },
      { frameIx: 1, selfUs: 0, totalUs: 4000, samples: 0 },
      { frameIx: 0, selfUs: 0, totalUs: 4000, samples: 0 },
    ],
    samples: {
      nodeIds: [4, 4, 4, 5, 5],
      timeDeltasUs: [1000, 1000, 1000, 500, 500],
    },
  }
}

function fixedDocWithCpu() {
  const workload = makeSubprocessWorkload(["bun", "a.ts"], "bun a.ts")
  const run = makeInstrumentedMeasurement({
    workload,
    phase: "cpu",
    configFingerprint: "cfg_fixed",
    diagnosticWallNs: 5_000_000,
    cpu: fixedCpu(),
    warnings: [],
    artifacts: [],
  })
  return { doc: newDocument([workload], [run]), workload, run }
}

describe("cpu-tree helpers", () => {
  test("buildParentMap inverts every children edge", () => {
    const cpu = fixedCpu()
    const parentOf = buildParentMap(cpu)
    expect(parentOf.get(2)).toBe(1)
    expect(parentOf.get(3)).toBe(2)
    expect(parentOf.get(5)).toBe(2)
    expect(parentOf.get(4)).toBe(3)
    expect(parentOf.has(1)).toBe(false)
  })

  test("findRootId finds the one node never listed as a child", () => {
    expect(findRootId(fixedCpu())).toBe(1)
  })

  test("pathToRoot returns root-first order including the target node", () => {
    const parentOf = buildParentMap(fixedCpu())
    expect(pathToRoot(4, parentOf)).toEqual([1, 2, 3, 4])
    expect(pathToRoot(1, parentOf)).toEqual([1])
  })

  test("computeNodeTimes attributes self time to leaves only and propagates totals upward", () => {
    const times = computeNodeTimes(fixedCpu())
    expect(times.get(4)).toEqual({ selfUs: 3000, totalUs: 3000, samples: 3 })
    expect(times.get(5)).toEqual({ selfUs: 1000, totalUs: 1000, samples: 2 })
    expect(times.get(3)!.selfUs).toBe(0)
    expect(times.get(3)!.totalUs).toBe(3000)
    expect(times.get(2)!.totalUs).toBe(4000)
    expect(times.get(1)!.totalUs).toBe(4000)
  })

  test("selectCpuRuns with an explicit runId returns only that run; without, returns all CPU runs", () => {
    const { doc, run } = fixedDocWithCpu()
    expect(selectCpuRuns(doc, run.id)).toHaveLength(1)
    expect(selectCpuRuns(doc, "run_does_not_exist")).toHaveLength(0)
    expect(selectCpuRuns(doc)).toHaveLength(1)
  })
})

describe("collapsed renderer", () => {
  test("emits one line per distinct sampled leaf path, root-first, semicolon-joined", async () => {
    const { doc } = fixedDocWithCpu()
    const result = await renderers.collapsed.render(doc, {})
    expect(result.files).toHaveLength(1)
    const lines = result.files![0]!.content.trim().split("\n").sort()
    expect(lines).toEqual(
      ["(root);(module);a;b 3", "(root);(module);c 2"].sort(),
    )
  })
})

describe("mermaid renderer", () => {
  test("produces a connected graph TD with self/total time labels", async () => {
    const { doc } = fixedDocWithCpu()
    const result = await renderers.mermaid.render(doc, {})
    const content = result.files![0]!.content
    expect(content).toStartWith("graph TD")
    expect(content).toContain('"b (self 3.00ms, total 3.00ms)"')
    expect(content).toContain('"c (self 1.00ms, total 1.00ms)"')
    expect(content).toMatch(/n1 --> n2/)
  })

  test("topN limits how many frames are included, always keeping ancestors connected", async () => {
    const { doc } = fixedDocWithCpu()
    const result = await renderers.mermaid.render(doc, { topN: 1 })
    const content = result.files![0]!.content
    expect(content).toContain("b (self")
    expect(content).not.toContain("c (self")
  })
})

describe("speedscope renderer", () => {
  test("produces a valid sampled profile with root-to-leaf stacks and matching weights", async () => {
    const { doc } = fixedDocWithCpu()
    const result = await renderers.speedscope.render(doc, {})
    const parsed = JSON.parse(result.files![0]!.content)

    expect(parsed.shared.frames).toHaveLength(5)
    expect(parsed.profiles[0].samples).toHaveLength(5)
    expect(parsed.profiles[0].weights).toEqual([1000, 1000, 1000, 500, 500])
    expect(parsed.profiles[0].endValue).toBe(4000)

    const frameNames = parsed.shared.frames.map((f: { name: string }) => f.name)
    const leafStack = parsed.profiles[0].samples[0].map(
      (ix: number) => frameNames[ix],
    )
    expect(leafStack).toEqual(["(root)", "(module)", "a", "b"])
  })
})

describe("cpuprofile pass-through renderer", () => {
  test("copies the artifact file verbatim when present", async () => {
    const { doc, run } = fixedDocWithCpu()
    const artifactPath = `${import.meta.dir}/../fixtures/capture/sample.cpuprofile.json`
    const artifact = await makeArtifactRef(run.id, "cpuprofile", artifactPath)
    run.artifacts.push(artifact)

    const result = await renderers.cpuprofile.render(doc, {})
    expect(result.files).toHaveLength(1)
    expect(result.files![0]!.content).toBe(await Bun.file(artifactPath).text())
  })

  test("skips runs with no cpuprofile artifact and explains why instead of failing silently", async () => {
    const { doc } = fixedDocWithCpu()
    const result = await renderers.cpuprofile.render(doc, {})
    expect(result.files ?? []).toHaveLength(0)
    expect(result.text).toContain("no cpuprofile artifact recorded")
  })
})
