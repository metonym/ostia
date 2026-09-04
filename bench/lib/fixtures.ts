import type { RawCpuProfile } from "../../src/capture/cpu/parse.ts"
import { parseCpuProfile } from "../../src/capture/cpu/parse.ts"
import type { RawHeapSnapshot } from "../../src/capture/heap/parse.ts"
import type {
  RawJscFrame,
  RawStackTraces,
} from "../../src/capture/jsc/parse.ts"
import {
  makeInstrumentedRun,
  makeSubprocessWorkload,
  makeTimingRun,
  newDocument,
} from "../../src/ir/document.ts"
import type { CpuEvidence, ProfileDocument, Trial } from "../../src/ir/types.ts"
import { computeTimingStats } from "../../src/stats/index.ts"

export function syntheticSamples(n: number): number[] {
  const samples: number[] = []
  for (let i = 0; i < n; i++)
    samples.push(1_000_000 + ((i * 2654435761) % 500_000))
  return samples
}

export interface TreeSpec {
  breadth: number
  depth: number
  leafIndices: number[]
  parentOf: Map<number, number>
  names: string[]
  urls: string[]
  lines: number[]
}

function buildTree(breadth: number, depth: number): TreeSpec {
  const names: string[] = ["(root)"]
  const urls: string[] = [""]
  const lines: number[] = [0]
  const parentOf = new Map<number, number>()
  const leafIndices: number[] = []

  function grow(index: number, level: number): void {
    if (level >= depth) {
      leafIndices.push(index)
      return
    }
    for (let b = 0; b < breadth; b++) {
      const childIndex = names.length
      names.push(`fn_${level}_${b}`)
      urls.push(`file:///synthetic/level${level}.ts`)
      lines.push(level * 10 + b)
      parentOf.set(childIndex, index)
      grow(childIndex, level + 1)
    }
  }
  grow(0, 0)

  return { breadth, depth, leafIndices, parentOf, names, urls, lines }
}

function pathFromRoot(tree: TreeSpec, leaf: number): number[] {
  const path = [leaf]
  let current = leaf
  while (tree.parentOf.has(current)) {
    current = tree.parentOf.get(current)!
    path.push(current)
  }
  return path.reverse()
}

export function syntheticCpuProfile(
  tree: TreeSpec,
  sampleCount: number,
): RawCpuProfile {
  const nodes: RawCpuProfile["nodes"] = tree.names.map((name, i) => ({
    id: i + 1,
    callFrame: {
      functionName: name,
      url: tree.urls[i]!,
      lineNumber: i === 0 ? -1 : tree.lines[i]!,
      columnNumber: i === 0 ? -1 : 1,
    },
    children: [...tree.parentOf.entries()]
      .filter(([, p]) => p === i)
      .map(([c]) => c + 1),
  }))
  const samples: number[] = []
  const timeDeltas: number[] = []
  for (let i = 0; i < sampleCount; i++) {
    const leaf = tree.leafIndices[i % tree.leafIndices.length]!
    samples.push(leaf + 1)
    timeDeltas.push(1000)
  }
  return {
    nodes,
    startTime: 0,
    endTime: sampleCount * 1000,
    samples,
    timeDeltas,
  }
}

export function syntheticJscTraces(
  tree: TreeSpec,
  sampleCount: number,
): RawStackTraces {
  const traces: RawStackTraces["traces"] = []
  for (let i = 0; i < sampleCount; i++) {
    const leaf = tree.leafIndices[i % tree.leafIndices.length]!
    const rootFirst = pathFromRoot(tree, leaf)
    const frames: RawJscFrame[] = rootFirst
      .map((idx) => ({
        sourceID: idx,
        name: tree.names[idx]!,
        location: "",
        sourceURL: idx === 0 ? undefined : tree.urls[idx],
        line: idx === 0 ? 4294967295 : tree.lines[idx]! + 1, // jsc is 1-based; root uses the uint32 sentinel
        column: idx === 0 ? 4294967295 : 1,
        category: idx === rootFirst.length - 1 ? "FTL" : "Baseline",
        flags: 0,
      }))
      .reverse() // jsc traces are leaf-first
    traces.push({ timestamp: i, frames })
  }
  return { interval: 0.001, traces }
}

export function syntheticHeapSnapshot(nodeCount: number): RawHeapSnapshot {
  const nodeFields = [
    "type",
    "name",
    "id",
    "self_size",
    "edge_count",
    "trace_node_id",
    "detachedness",
  ]
  const typeNames = [
    "hidden",
    "array",
    "string",
    "object",
    "code",
    "closure",
    "regexp",
    "number",
    "native",
    "synthetic",
    "concatenated string",
    "sliced string",
    "symbol",
    "bigint",
    "object shape",
  ]
  const nodes: number[] = []
  for (let i = 0; i < nodeCount; i++) {
    const typeIdx = i % typeNames.length
    nodes.push(typeIdx, 0, i, 16 + (i % 64), 0, 0, 0)
  }
  return {
    snapshot: {
      meta: {
        node_fields: nodeFields,
        node_types: [
          typeNames,
          "string",
          "number",
          "number",
          "number",
          "number",
          "number",
        ],
      },
      node_count: nodeCount,
    },
    nodes,
    strings: [],
  }
}

export function cpuEvidenceFromTree(
  tree: TreeSpec,
  sampleCount: number,
): CpuEvidence {
  const raw = syntheticCpuProfile(tree, sampleCount)
  return parseCpuProfile(raw, "cpu-prof", 1000)
}

export function syntheticDocument(
  n: number,
  cpu?: CpuEvidence,
): ProfileDocument {
  const workload = makeSubprocessWorkload(
    ["bun", `synthetic-${n}.ts`],
    `synthetic-${n}`,
  )
  const trials: Trial[] = syntheticSamples(n).map((wallNs, i) => ({
    i,
    wallNs,
    exitCode: 0,
  }))
  const timingRun = makeTimingRun({
    workload,
    configFingerprint: "cfg_dogfood",
    trials,
    timing: computeTimingStats(trials.map((t) => t.wallNs)),
    warnings: [],
  })
  const runs = [timingRun]
  if (cpu) {
    runs.push(
      makeInstrumentedRun({
        workload,
        phase: "cpu",
        configFingerprint: "cfg_dogfood",
        diagnosticWallNs: 1_000_000,
        cpu,
        warnings: [],
        artifacts: [],
      }),
    )
  }
  return newDocument([workload], runs)
}

export const SMALL_TREE = buildTree(4, 4)
export const LARGE_TREE = buildTree(6, 5)
