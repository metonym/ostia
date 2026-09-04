import type { CpuEvidence, ProfileDocument, Run } from "../ir/types.ts"

export function selectCpuRuns(doc: ProfileDocument, runId?: string): Run[] {
  if (runId) {
    const run = doc.runs.find((r) => r.id === runId)
    return run?.cpu ? [run] : []
  }
  return doc.runs.filter((r) => r.phase === "cpu" && r.cpu)
}

export function buildParentMap(cpu: CpuEvidence): Map<number, number> {
  const parentOf = new Map<number, number>()
  for (const node of cpu.nodes) {
    for (const childId of node.children) parentOf.set(childId, node.id)
  }
  return parentOf
}

export function findRootId(cpu: CpuEvidence): number | undefined {
  const tree = buildDenseTree(cpu)
  const rootIx = tree.roots[0]
  return rootIx === undefined ? undefined : cpu.nodes[rootIx]!.id
}

export function pathToRoot(
  nodeId: number,
  parentOf: Map<number, number>,
): number[] {
  const path = [nodeId]
  let current = nodeId
  while (parentOf.has(current)) {
    current = parentOf.get(current)!
    path.push(current)
  }
  return path.reverse()
}

export interface NodeTimes {
  selfUs: number
  totalUs: number
  samples: number
}

export interface DenseTree {
  count: number
  indexOf: (id: number) => number
  parentIx: Int32Array
  roots: number[]
  order: number[]
}

export function buildDenseTree(cpu: CpuEvidence): DenseTree {
  const nodes = cpu.nodes
  const count = nodes.length
  const indexOf = makeIndexer(cpu)

  const parentIx = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i++) {
    for (const childId of nodes[i]!.children) {
      const c = indexOf(childId)
      if (c !== -1) parentIx[c] = i
    }
  }

  const roots: number[] = []
  for (let i = 0; i < count; i++) if (parentIx[i] === -1) roots.push(i)

  const order: number[] = []
  const stack: number[] = []
  for (let r = roots.length - 1; r >= 0; r--) stack.push(roots[r]!)
  while (stack.length > 0) {
    const i = stack.pop()!
    order.push(i)
    for (const childId of nodes[i]!.children) {
      const c = indexOf(childId)
      if (c !== -1 && parentIx[c] === i) stack.push(c)
    }
  }

  return { count, indexOf, parentIx, roots, order }
}

function makeIndexer(cpu: CpuEvidence): (id: number) => number {
  const nodes = cpu.nodes
  const count = nodes.length
  let min = Infinity
  let max = -Infinity
  let integral = true
  for (let i = 0; i < count; i++) {
    const id = nodes[i]!.id
    if (!Number.isInteger(id)) {
      integral = false
      break
    }
    if (id < min) min = id
    if (id > max) max = id
  }
  if (integral && count > 0 && max - min < count * 4 + 64) {
    const span = max - min + 1
    const table = new Int32Array(span).fill(-1)
    for (let i = 0; i < count; i++) table[nodes[i]!.id - min] = i
    return (id) => {
      const k = id - min
      return k >= 0 && k < span ? table[k]! : -1
    }
  }
  const byId = new Map<number, number>()
  for (let i = 0; i < count; i++) byId.set(nodes[i]!.id, i)
  return (id) => byId.get(id) ?? -1
}

export interface DenseNodeTimes {
  selfUs: Float64Array
  totalUs: Float64Array
  samples: Float64Array
}

export function computeDenseNodeTimes(
  cpu: CpuEvidence,
  tree: DenseTree,
): DenseNodeTimes {
  const { count, indexOf, parentIx, order } = tree
  const selfUs = new Float64Array(count)
  const samples = new Float64Array(count)
  const nodeIds = cpu.samples?.nodeIds ?? []
  const deltas = cpu.samples?.timeDeltasUs ?? []
  for (let i = 0; i < nodeIds.length; i++) {
    const ix = indexOf(nodeIds[i]!)
    if (ix === -1) continue
    selfUs[ix]! += deltas[i] ?? 0
    samples[ix]! += 1
  }

  const totalUs = new Float64Array(count)
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]!
    totalUs[i]! += selfUs[i]!
    const p = parentIx[i]!
    if (p >= 0) totalUs[p]! += totalUs[i]!
  }
  return { selfUs, totalUs, samples }
}

export function computeNodeTimes(cpu: CpuEvidence): Map<number, NodeTimes> {
  const tree = buildDenseTree(cpu)
  const { selfUs, totalUs, samples } = computeDenseNodeTimes(cpu, tree)
  const times = new Map<number, NodeTimes>()
  for (let i = 0; i < tree.count; i++) {
    times.set(cpu.nodes[i]!.id, {
      selfUs: selfUs[i]!,
      totalUs: totalUs[i]!,
      samples: samples[i]!,
    })
  }
  return times
}
