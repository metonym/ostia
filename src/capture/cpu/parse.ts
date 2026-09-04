import { fp } from "../../ir/fp.ts"
import type {
  CallNode,
  CpuEvidence,
  Frame,
  FrameTotal,
} from "../../ir/types.ts"

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

// cpu-prof/inspector: sourcemapped file:// URLs, 0-based lines (jsc is 1-based; see capture/jsc/parse.ts).
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

  const frameIxByName = new Map<string, Map<string, number>>()
  const frames: Frame[] = []
  const indexById = new Map<number, number>()
  const frameIxOf = new Int32Array(count)

  for (let i = 0; i < count; i++) {
    const node = rawNodes[i]!
    const cf = node.callFrame
    const url = normalizeUrl(cf.url)
    let byUrl = frameIxByName.get(cf.functionName)
    if (byUrl === undefined) {
      byUrl = new Map()
      frameIxByName.set(cf.functionName, byUrl)
    }
    let ix = byUrl.get(url)
    if (ix === undefined) {
      ix = frames.length
      byUrl.set(url, ix)
      frames.push({
        key: fp("fr", cf.functionName, url),
        name: cf.functionName,
        url: url || undefined,
        line: cf.lineNumber >= 0 ? cf.lineNumber : undefined,
        col: cf.columnNumber >= 0 ? cf.columnNumber : undefined,
      })
    }
    frameIxOf[i] = ix
    indexById.set(node.id, i)
  }

  const nodes: CallNode[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const n = rawNodes[i]!
    nodes[i] = {
      id: n.id,
      frameIx: frameIxOf[indexById.get(n.id)!]!,
      children: n.children ?? [],
    }
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

  const totalsByFrameIx: (FrameTotal | undefined)[] = new Array(frames.length)
  const totals: FrameTotal[] = []
  for (let i = 0; i < count; i++) {
    const frameIx = nodes[i]!.frameIx
    const existing = totalsByFrameIx[frameIx]
    if (existing) {
      existing.selfUs += selfUs[i]!
      existing.totalUs += totalUs[i]!
      existing.samples += sampleCount[i]!
    } else {
      const t = {
        frameIx,
        selfUs: selfUs[i]!,
        totalUs: totalUs[i]!,
        samples: sampleCount[i]!,
      }
      totalsByFrameIx[frameIx] = t
      totals.push(t)
    }
  }

  return {
    origin,
    samplingIntervalUs,
    frames,
    nodes,
    totals: totals.sort((a, b) => b.selfUs - a.selfUs),
    samples: { nodeIds: raw.samples, timeDeltasUs: raw.timeDeltas },
  }
}
