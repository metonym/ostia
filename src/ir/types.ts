// Profile IR schema v1. Base units: ns (time), bytes (memory), µs (sampling interval).

export interface ProfileDocument {
  schemaVersion: 1
  toolVersion: string
  bunVersion: string
  platform: { os: string; arch: string }
  createdAt: string // ISO; metadata only, never used in IDs
  workloads: Workload[]
  runs: Run[]
  comparisons?: Comparison[]
}

export interface Workload {
  id: string
  kind: "subprocess" | "inprocess"
  label?: string
  command?: string[]
  shell?: string
  entry?: { file: string; task: string }
  /** Marks this task as the in-run Relative reference for its group (see
   * `task(name, fn, { baseline: true })`). At most one per group is
   * meaningful; renderers use the first they encounter. */
  baseline?: boolean
}

export type Phase = "timing" | "cpu" | "heap" | "memstats"

export interface Run {
  id: string
  workloadId: string
  phase: Phase
  instrumented: boolean
  configFingerprint: string
  trials: Trial[]
  timing?: TimingStats
  diagnosticWallNs?: number
  cpu?: CpuEvidence
  heap?: HeapEvidence
  memory?: MemoryEvidence
  jit?: JitTierBreakdown
  warnings: Warning[]
  artifacts: ArtifactRef[]
  baselineRunId?: string
}

export interface Trial {
  i: number
  wallNs: number
  exitCode?: number
  userNs?: number
  systemNs?: number
  maxRssBytes?: number
}

export interface TimingStats {
  unit: "ns"
  samples: number[]
  mean: number
  median: number
  stddev: number
  min: number
  max: number
  outliers: { mild: number; severe: number }
}

export interface Frame {
  key: string
  name: string
  url?: string
  line?: number
  col?: number
}

export interface CallNode {
  id: number
  frameIx: number
  children: number[]
}

export interface FrameTotal {
  frameIx: number
  selfUs: number
  totalUs: number
  samples: number
}

export interface CpuEvidence {
  origin: "cpu-prof" | "inspector" | "jsc-profile"
  samplingIntervalUs: number
  frames: Frame[]
  nodes: CallNode[]
  totals: FrameTotal[]
  samples?: { nodeIds: number[]; timeDeltasUs: number[] }
}

export interface HeapEvidence {
  origin: "heap-prof" | "generateHeapSnapshot" | "heapStats"
  heapSizeBytes?: number
  objectCount?: number
  typeCounts: { type: string; count: number; retainedBytes?: number }[]
  snapshotArtifactId?: string
}

export interface MemoryEvidence {
  origin: "resourceUsage" | "memoryUsage" | "heapStats"
  perTrial?: { rssBytes?: number; heapSizeBytes?: number }[]
  maxRssBytes?: number
  peakCommitBytes?: number
  pageFaults?: number
}

export interface JitTierBreakdown {
  origin: "jsc-profile"
  tiers: { llint: number; baseline: number; dfg: number; ftl: number }
  topFramesByTier?: { tier: string; frameKey: string; samples: number }[]
}

export type WarningCode =
  | "slow-first-run"
  | "outliers-detected"
  | "fast-command"
  | "nonzero-exit"
  | "instrumented-timing"
  | "artifact-missing"
  | "empty-profile"
  | "below-timer-resolution"
  | "cache-fallback-rerun"
  | "low-sample-count"

export interface Warning {
  code: WarningCode
  message: string
  data?: Record<string, unknown>
}

export interface ArtifactRef {
  id: string
  kind:
    | "cpuprofile"
    | "cpu-md"
    | "heapsnapshot"
    | "heap-md"
    | "speedscope"
    | "collapsed"
    | "mermaid"
    | "other"
  path: string
  sha256: string
  bytes: number
}

export interface Comparison {
  id: string
  baselineRunId: string
  candidateRunId: string
  timing?: {
    medianDeltaPct: number
    meanDeltaPct: number
    verdict: "improved" | "regressed" | "unchanged"
  }
  frames?: {
    frameKey: string
    name: string
    baseSelfUs: number
    candSelfUs: number
    deltaPct: number
  }[]
  heapTypes?: {
    type: string
    baseCount: number
    candCount: number
    baseBytes?: number
    candBytes?: number
    deltaPct: number
  }[]
  thresholds: {
    timingPct: number
    frameSelfPct: number
    heapTypePct: number
    minFrameSelfUs: number
  }
  verdict: "pass" | "fail"
}
