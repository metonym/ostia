import type { CallNode, CpuEvidence, FrameTotal } from "../ir/types.ts";
import { addFrameTotal, createFrameTable, sortedTotals } from "./frames.ts";

interface RawCallFrame {
  functionName: string;
  scriptId?: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface RawCpuNode {
  id: number;
  callFrame: RawCallFrame;
  hitCount?: number;
  children?: number[];
}

export interface RawCpuProfile {
  nodes: RawCpuNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

// The parse step for a profile from JSON or the inspector: checks the
// arrays `parseCpuProfile` walks, not each node.
export function isRawCpuProfile(value: unknown): value is RawCpuProfile {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodes" in value &&
    Array.isArray(value.nodes) &&
    "samples" in value &&
    Array.isArray(value.samples) &&
    "timeDeltas" in value &&
    Array.isArray(value.timeDeltas)
  );
}

// cpu-prof/inspector: sourcemapped file:// URLs, 0-based lines (jsc is
// 1-based).
function normalizeUrl(url: string): string {
  return url.startsWith("file://") ? url.slice("file://".length) : url;
}

export function parseCpuProfile(
  raw: RawCpuProfile,
  origin: CpuEvidence["origin"],
  samplingIntervalUs: number,
): CpuEvidence {
  const rawNodes = raw.nodes;
  const count = rawNodes.length;

  const { frames, intern } = createFrameTable();
  const indexById = new Map<number, number>();
  const nodes = new Array<CallNode>(count);

  for (const [i, node] of rawNodes.entries()) {
    const cf = node.callFrame;
    const frameIx = intern(
      cf.functionName,
      normalizeUrl(cf.url) || undefined,
      cf.lineNumber >= 0 ? cf.lineNumber : undefined,
      cf.columnNumber >= 0 ? cf.columnNumber : undefined,
    );
    nodes[i] = { id: node.id, frameIx, children: node.children ?? [] };
    indexById.set(node.id, i);
  }

  const selfUs = new Float64Array(count);
  const sampleCount = new Float64Array(count);
  const sampleIds = raw.samples;
  const deltas = raw.timeDeltas;
  for (const [i, id] of sampleIds.entries()) {
    const ix = indexById.get(id);
    if (ix === undefined) continue;
    selfUs[ix] = (selfUs[ix] ?? 0) + (deltas[i] ?? 0);
    sampleCount[ix] = (sampleCount[ix] ?? 0) + 1;
  }

  const parentIx = new Int32Array(count).fill(-1);
  for (const [i, node] of rawNodes.entries()) {
    const children = node.children;
    if (!children) continue;
    for (const childId of children) {
      const c = indexById.get(childId);
      if (c !== undefined) parentIx[c] = i;
    }
  }
  // Parents-before-children order, so walking it backwards rolls totals up.
  const order: number[] = [];
  const stack: number[] = [];
  for (let i = count - 1; i >= 0; i--) if (parentIx[i] === -1) stack.push(i);
  for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
    order.push(i);
    const children = rawNodes[i]?.children;
    if (!children) continue;
    for (const childId of children) {
      const c = indexById.get(childId);
      if (c !== undefined && parentIx[c] === i) stack.push(c);
    }
  }
  const totalUs = new Float64Array(count);
  for (const i of order.toReversed()) {
    const total = (totalUs[i] ?? 0) + (selfUs[i] ?? 0);
    totalUs[i] = total;
    const p = parentIx[i] ?? -1;
    if (p >= 0) totalUs[p] = (totalUs[p] ?? 0) + total;
  }

  const totals = new Map<number, FrameTotal>();
  for (const [i, node] of nodes.entries()) {
    addFrameTotal(
      totals,
      node.frameIx,
      selfUs[i] ?? 0,
      totalUs[i] ?? 0,
      sampleCount[i] ?? 0,
    );
  }

  return {
    origin,
    samplingIntervalUs,
    frames,
    nodes,
    totals: sortedTotals(totals),
    samples: { nodeIds: raw.samples, timeDeltasUs: raw.timeDeltas },
  };
}
