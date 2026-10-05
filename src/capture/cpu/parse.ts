import type { CallNode, CpuEvidence, FrameTotal } from "../../ir/types.ts"
import { addFrameTotal, createFrameTable, sortedTotals } from "../frames.ts"

interface RawCallFrame {
  functionName: string
  scriptId?: string
  url: string
  lineNumber: number
  columnNumber: number
}

interface RawCpuNode {
  id: number
  callFrame: RawCallFrame
  hitCount?: number
  children?: number[]
}

export interface RawCpuProfile {
  nodes: RawCpuNode[]
  startTime: number
  endTime: number
  samples: number[]
  timeDeltas: number[]
}

// cpu-prof/inspector: sourcemapped file:// URLs, 0-based lines (jsc is 1-based).
function normalizeUrl(url: string): string {
  return url.startsWith("file://") ? url.slice("file://".length) : url
}

export function parseCpuProfile(
  raw: RawCpuProfile,
  origin: CpuEvidence["origin"],
  samplingIntervalUs: number,
): CpuEvidence {
  const rawNodes = raw.nodes
  const count = rawNodes.length

  const { frames, intern } = createFrameTable()
  const indexById = new Map<number, number>()
  const nodes: CallNode[] = new Array(count)

  for (let i = 0; i < count; i++) {
    const node = rawNodes[i]!
    const cf = node.callFrame
    const frameIx = intern(
      cf.functionName,
      normalizeUrl(cf.url) || undefined,
      cf.lineNumber >= 0 ? cf.lineNumber : undefined,
      cf.columnNumber >= 0 ? cf.columnNumber : undefined,
    )
    nodes[i] = { id: node.id, frameIx, children: node.children ?? [] }
    indexById.set(node.id, i)
  }

  const selfUs = new Float64Array(count)
  const sampleCount = new Float64Array(count)
  const sampleIds = raw.samples
  const deltas = raw.timeDeltas
  for (let i = 0; i < sampleIds.length; i++) {
    const ix = indexById.get(sampleIds[i]!)
    if (ix === undefined) continue
    selfUs[ix]! += deltas[i] ?? 0
    sampleCount[ix]! += 1
  }

  const parentIx = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i++) {
    const children = rawNodes[i]!.children
    if (!children) continue
    for (const childId of children) {
      const c = indexById.get(childId)
      if (c !== undefined) parentIx[c] = i
    }
  }
  // Parents-before-children order, so walking it backwards rolls totals up.
  const order: number[] = []
  const stack: number[] = []
  for (let i = count - 1; i >= 0; i--) if (parentIx[i] === -1) stack.push(i)
  while (stack.length > 0) {
    const i = stack.pop()!
    order.push(i)
    const children = rawNodes[i]!.children
    if (!children) continue
    for (const childId of children) {
      const c = indexById.get(childId)
      if (c !== undefined && parentIx[c] === i) stack.push(c)
    }
  }
  const totalUs = new Float64Array(count)
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]!
    totalUs[i]! += selfUs[i]!
    const p = parentIx[i]!
    if (p >= 0) totalUs[p]! += totalUs[i]!
  }

  const totals = new Map<number, FrameTotal>()
  for (let i = 0; i < count; i++) {
    addFrameTotal(
      totals,
      nodes[i]!.frameIx,
      selfUs[i]!,
      totalUs[i]!,
      sampleCount[i]!,
    )
  }

  return {
    origin,
    samplingIntervalUs,
    frames,
    nodes,
    totals: sortedTotals(totals),
    samples: { nodeIds: raw.samples, timeDeltasUs: raw.timeDeltas },
  }
}
