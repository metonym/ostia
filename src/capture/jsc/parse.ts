import type {
  CallNode,
  CpuEvidence,
  FrameTotal,
  JitTierBreakdown,
} from "../../ir/types.ts"
import { addFrameTotal, createFrameTable, sortedTotals } from "../frames.ts"

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
  frames: RawJscFrame[] // leaf-first
}

export interface RawStackTraces {
  interval: number // seconds
  traces: RawJscTrace[]
}

const TIER_BUCKET = new Map<string, keyof JitTierBreakdown["tiers"]>([
  ["LLInt", "llint"],
  ["Baseline", "baseline"],
  ["DFG", "dfg"],
  ["FTL", "ftl"],
])
const UINT32_SENTINEL = 4294967295 // JSC's "no line/column" marker on synthetic/native frames

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

  const { frames, intern } = createFrameTable()
  function frameIxFromRaw(rf: RawJscFrame): number {
    const isSentinel = rf.line === UINT32_SENTINEL
    // jsc lines/columns are 1-based; stored 0-based like cpu-prof/inspector.
    const line = isSentinel ? undefined : rf.line - 1
    const col =
      isSentinel || rf.column === UINT32_SENTINEL ? undefined : rf.column - 1
    return intern(rf.name, rf.sourceURL, line, col)
  }

  const allNodes: MutableNode[] = []
  function newNode(frameIx: number): MutableNode {
    const node: MutableNode = {
      id: allNodes.length,
      frameIx,
      children: new Map(),
      selfUs: 0,
      samples: 0,
      totalUs: 0,
    }
    allNodes.push(node)
    return node
  }
  const rootNode = newNode(intern("(root)", undefined, undefined, undefined))

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
        child = newNode(frameIx)
        current.children.set(frameIx, child)
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

  const totals = new Map<number, FrameTotal>()
  function accumulate(node: MutableNode): void {
    addFrameTotal(totals, node.frameIx, node.selfUs, node.totalUs, node.samples)
    for (const child of node.children.values()) accumulate(child)
  }
  accumulate(rootNode)

  const nodes: CallNode[] = allNodes.map((n) => ({
    id: n.id,
    frameIx: n.frameIx,
    children: [...n.children.values()].map((c) => c.id),
  }))

  const cpu: CpuEvidence = {
    origin: "jsc-profile",
    samplingIntervalUs,
    frames,
    nodes,
    totals: sortedTotals(totals),
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
