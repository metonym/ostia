import { fp } from "../../ir/fp.ts"
import type {
  CallNode,
  CpuEvidence,
  Frame,
  FrameTotal,
  JitTierBreakdown,
} from "../../ir/types.ts"

export interface RawJscFrame {
  sourceID: number
  name: string
  location: string
  sourceURL?: string
  line: number
  column: number
  category: string
  flags: number
}

interface RawJscTrace {
  timestamp: number
  frames: RawJscFrame[] // leaf-first: index 0 is the innermost currently-executing frame
}

export interface RawStackTraces {
  interval: number // seconds
  traces: RawJscTrace[]
  sources?: unknown
}

const TIER_BUCKET = new Map<string, keyof JitTierBreakdown["tiers"]>([
  ["LLInt", "llint"],
  ["Baseline", "baseline"],
  ["DFG", "dfg"],
  ["FTL", "ftl"],
])
const UINT32_SENTINEL = 4294967295 // JSC's "no line/column" marker (observed on synthetic/native frames)

interface MutableNode {
  id: number
  frameIx: number
  children: Map<number, MutableNode>
  selfUs: number
  samples: number
  totalUs: number
}

export function parseJscProfile(
  raw: RawStackTraces,
  intervalUsOverride?: number,
): { cpu: CpuEvidence; jit: JitTierBreakdown } {
  const samplingIntervalUs = intervalUsOverride ?? raw.interval * 1e6

  const frameIxByName = new Map<string, Map<string, number>>()
  const frames: Frame[] = []
  function internFrame(
    name: string,
    url: string | undefined,
    line: number | undefined,
    col: number | undefined,
  ): number {
    let byUrl = frameIxByName.get(name)
    if (byUrl === undefined) {
      byUrl = new Map()
      frameIxByName.set(name, byUrl)
    }
    const urlKey = url ?? ""
    let ix = byUrl.get(urlKey)
    if (ix === undefined) {
      ix = frames.length
      byUrl.set(urlKey, ix)
      frames.push({ key: fp("fr", name, urlKey), name, url, line, col })
    }
    return ix
  }
  function frameIxFromRaw(rf: RawJscFrame): number {
    const isSentinel = rf.line === UINT32_SENTINEL
    // jsc lines/columns are 1-based; store 0-based to match the cpu-prof/inspector convention.
    const line = isSentinel ? undefined : rf.line - 1
    const col =
      isSentinel || rf.column === UINT32_SENTINEL ? undefined : rf.column - 1
    return internFrame(rf.name, rf.sourceURL, line, col)
  }

  const rootFrameIx = internFrame("(root)", undefined, undefined, undefined)
  let nextId = 1
  const rootNode: MutableNode = {
    id: 0,
    frameIx: rootFrameIx,
    children: new Map(),
    selfUs: 0,
    samples: 0,
    totalUs: 0,
  }
  const nodesById = new Map<number, MutableNode>([[0, rootNode]])

  const tiers = { llint: 0, baseline: 0, dfg: 0, ftl: 0 }
  const tierFrameSamples = new Map<string, Map<number, number>>()

  const nodeIds: number[] = []
  const timeDeltasUs: number[] = []

  for (const trace of raw.traces) {
    const traceFrames = trace.frames
    let current = rootNode
    for (let f = traceFrames.length - 1; f >= 0; f--) {
      const frameIx = frameIxFromRaw(traceFrames[f]!)
      let child = current.children.get(frameIx)
      if (!child) {
        child = {
          id: nextId++,
          frameIx,
          children: new Map(),
          selfUs: 0,
          samples: 0,
          totalUs: 0,
        }
        current.children.set(frameIx, child)
        nodesById.set(child.id, child)
      }
      current = child
    }

    current.selfUs += samplingIntervalUs
    current.samples += 1
    nodeIds.push(current.id)
    timeDeltasUs.push(samplingIntervalUs)

    const leafRaw = traceFrames[0]
    const bucket = leafRaw && TIER_BUCKET.get(leafRaw.category)
    if (bucket) {
      tiers[bucket]++
      const byFrame = tierFrameSamples.get(bucket) ?? new Map<number, number>()
      byFrame.set(current.frameIx, (byFrame.get(current.frameIx) ?? 0) + 1)
      tierFrameSamples.set(bucket, byFrame)
    }
  }

  function computeTotalUs(node: MutableNode): number {
    let total = node.selfUs
    for (const child of node.children.values()) total += computeTotalUs(child)
    node.totalUs = total
    return total
  }
  computeTotalUs(rootNode)

  const totalsByFrameIx = new Map<number, FrameTotal>()
  function accumulate(node: MutableNode): void {
    const existing = totalsByFrameIx.get(node.frameIx)
    if (existing) {
      existing.selfUs += node.selfUs
      existing.totalUs += node.totalUs
      existing.samples += node.samples
    } else {
      totalsByFrameIx.set(node.frameIx, {
        frameIx: node.frameIx,
        selfUs: node.selfUs,
        totalUs: node.totalUs,
        samples: node.samples,
      })
    }
    for (const child of node.children.values()) accumulate(child)
  }
  accumulate(rootNode)

  const nodes: CallNode[] = [...nodesById.values()].map((n) => ({
    id: n.id,
    frameIx: n.frameIx,
    children: [...n.children.values()].map((c) => c.id),
  }))

  const cpu: CpuEvidence = {
    origin: "jsc-profile",
    samplingIntervalUs,
    frames,
    nodes,
    totals: [...totalsByFrameIx.values()].sort((a, b) => b.selfUs - a.selfUs),
    samples: { nodeIds, timeDeltasUs },
  }

  const topFramesByTier = [...tierFrameSamples.entries()].flatMap(
    ([tier, byFrame]) =>
      [...byFrame.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([frameIx, samples]) => ({
          tier,
          frameKey: frames[frameIx]!.key,
          samples,
        })),
  )

  const jit: JitTierBreakdown = {
    origin: "jsc-profile",
    tiers,
    topFramesByTier,
  }

  return { cpu, jit }
}
