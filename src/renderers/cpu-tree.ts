import type { CpuEvidence, Measurement, ProfileDocument } from "../ir/types.ts";
import type { RenderResult, VizOptions } from "./types.ts";

type CpuRun = Measurement & { cpu: CpuEvidence };

function hasCpu(m: Measurement): m is CpuRun {
  return m.cpu !== undefined;
}

export function selectCpuRuns(
  doc: ProfileDocument,
  measurementId?: string,
): CpuRun[] {
  if (measurementId) {
    const run = doc.measurements.find((r) => r.id === measurementId);
    return run && hasCpu(run) ? [run] : [];
  }
  return doc.measurements.filter(
    (r): r is CpuRun => r.phase === "cpu" && hasCpu(r),
  );
}

export function renderCpuFiles(
  doc: ProfileDocument,
  options: VizOptions,
  ext: string,
  build: (run: CpuRun) => string,
): RenderResult {
  return {
    files: selectCpuRuns(doc, options.measurementId).map((run) => ({
      path: `${run.id}.${ext}`,
      content: build(run),
    })),
  };
}

export function buildParentMap(cpu: CpuEvidence): Map<number, number> {
  const parentOf = new Map<number, number>();
  for (const node of cpu.nodes) {
    for (const childId of node.children) parentOf.set(childId, node.id);
  }
  return parentOf;
}

export function findRootId(cpu: CpuEvidence): number | undefined {
  const tree = buildDenseTree(cpu);
  const rootIx = tree.roots[0];
  return rootIx === undefined ? undefined : cpu.nodes[rootIx]?.id;
}

export function pathToRoot(
  nodeId: number,
  parentOf: Map<number, number>,
): number[] {
  const path = [nodeId];
  for (
    let parent = parentOf.get(nodeId);
    parent !== undefined;
    parent = parentOf.get(parent)
  ) {
    path.push(parent);
  }
  return path.reverse();
}

interface NodeTimes {
  selfUs: number;
  totalUs: number;
  samples: number;
}

interface DenseTree {
  count: number;
  indexOf: (id: number) => number;
  parentIx: Int32Array;
  roots: number[];
  order: number[];
}

export function buildDenseTree(cpu: CpuEvidence): DenseTree {
  const nodes = cpu.nodes;
  const count = nodes.length;
  const indexOf = makeIndexer(cpu);

  const parentIx = new Int32Array(count).fill(-1);
  let ix = 0;
  for (const node of nodes) {
    for (const childId of node.children) {
      const c = indexOf(childId);
      if (c !== -1) parentIx[c] = ix;
    }
    ix++;
  }

  const roots: number[] = [];
  for (let i = 0; i < count; i++) if (parentIx[i] === -1) roots.push(i);

  const order: number[] = [];
  const stack = roots.toReversed();
  for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
    order.push(i);
    for (const childId of nodes[i]?.children ?? []) {
      const c = indexOf(childId);
      if (c !== -1 && parentIx[c] === i) stack.push(c);
    }
  }

  return { count, indexOf, parentIx, roots, order };
}

function makeIndexer(cpu: CpuEvidence): (id: number) => number {
  const nodes = cpu.nodes;
  const count = nodes.length;
  let min = Infinity;
  let max = -Infinity;
  let integral = true;
  for (const { id } of nodes) {
    if (!Number.isInteger(id)) {
      integral = false;
      break;
    }
    if (id < min) min = id;
    if (id > max) max = id;
  }
  if (integral && count > 0 && max - min < count * 4 + 64) {
    const span = max - min + 1;
    const table = new Int32Array(span).fill(-1);
    let ix = 0;
    for (const node of nodes) table[node.id - min] = ix++;
    return (id) => {
      const k = id - min;
      return k >= 0 && k < span ? (table[k] ?? -1) : -1;
    };
  }
  const byId = new Map<number, number>();
  let ix = 0;
  for (const node of nodes) byId.set(node.id, ix++);
  return (id) => byId.get(id) ?? -1;
}

interface DenseNodeTimes {
  selfUs: Float64Array;
  totalUs: Float64Array;
  samples: Float64Array;
}

export function computeDenseNodeTimes(
  cpu: CpuEvidence,
  tree: DenseTree,
): DenseNodeTimes {
  const { count, indexOf, parentIx, order } = tree;
  const selfUs = new Float64Array(count);
  const samples = new Float64Array(count);
  const nodeIds = cpu.samples?.nodeIds ?? [];
  const deltas = cpu.samples?.timeDeltasUs ?? [];
  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i];
    if (id === undefined) continue;
    const ix = indexOf(id);
    if (ix === -1) continue;
    selfUs[ix] = (selfUs[ix] ?? 0) + (deltas[i] ?? 0);
    samples[ix] = (samples[ix] ?? 0) + 1;
  }

  const totalUs = new Float64Array(count);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    if (i === undefined) continue;
    const total = (totalUs[i] ?? 0) + (selfUs[i] ?? 0);
    totalUs[i] = total;
    const p = parentIx[i] ?? -1;
    if (p >= 0) totalUs[p] = (totalUs[p] ?? 0) + total;
  }
  return { selfUs, totalUs, samples };
}

export function computeNodeTimes(cpu: CpuEvidence): Map<number, NodeTimes> {
  const tree = buildDenseTree(cpu);
  const { selfUs, totalUs, samples } = computeDenseNodeTimes(cpu, tree);
  const times = new Map<number, NodeTimes>();
  let i = 0;
  for (const node of cpu.nodes) {
    times.set(node.id, {
      selfUs: selfUs[i] ?? 0,
      totalUs: totalUs[i] ?? 0,
      samples: samples[i] ?? 0,
    });
    i++;
  }
  return times;
}
