// Profile IR schema v2. Base units: ns (time), bytes (memory), µs (sampling interval).

export interface ProfileDocument {
  schemaVersion: 2
  toolVersion: string
  bunVersion: string
  platform: { os: string; arch: string }
  createdAt: string // ISO; metadata only, never used in IDs
  workloads: Workload[]
  measurements: Measurement[]
  comparisons?: Comparison[]
  /** Machine conditions when this document was measured. Additive, no
   * schema bump. Absent when `noiseCheck: false` (or `--no-noise-check`)
   * skipped the reference measurement. */
  environment?: Environment
  /** Repo state when this document was measured, from `git rev-parse` /
   * `git status --porcelain` in the process's cwd. Additive, no schema
   * bump. Absent outside a git repo (or when `git` itself isn't
   * available). Metadata only: never part of any fingerprint or id, so a
   * commit or a dirty working tree never orphans a cached run or baseline. */
  git?: GitMetadata
}

export interface GitMetadata {
  sha: string
  branch: string
  dirty: boolean
}

export interface NoiseFloor {
  /** `mad / median` of the reference workload's trial times, as a percent -
   * how noisy this machine is right now, independent of what's being
   * measured. */
  floorPct: number
  referenceMedianNs: number
  samples: number
}

export interface Environment {
  cpuModel: string
  cores: number
  loadAvg1: number
  loadAvg5: number
  noise: NoiseFloor
}

export interface Workload {
  id: string
  kind: "subprocess" | "inprocess"
  label?: string
  command?: string[]
  shell?: string
  /** Command form of the `prepare` hook that ran before every trial of this
   * command (`ostia time --prepare`, `time({ prepare })`, config `prepare`).
   * Part of the workload id: the same command with and without a prepare
   * step measures different things. A function-form hook isn't
   * serializable and is omitted here (its source text is still hashed into
   * the id). */
  prepare?: string[]
  /** Where this command's timing samples came from when not the subprocess
   * wall clock: a regex over the command's own output and the unit of the
   * number it captures. Part of the workload id, so the same command timed
   * by wall clock and by its own report are two workloads. */
  timeSource?: {
    pattern: string
    group?: number
    unit?: "ns" | "us" | "ms" | "s"
  }
  /** `task` is the "group/name" id the bench registry assigns; `group` is the
   * enclosing `group()` name when there is one. Renderers prefer `group` over
   * splitting `task` on "/", so task names may contain slashes. */
  entry?: { file: string; task: string; group?: string }
  /** Marks this task as the in-run Relative reference for its group (see
   * `task(name, fn, { baseline: true })`). At most one per group is
   * meaningful; renderers use the first they encounter. */
  baseline?: boolean
  /** What this task measures and why, from `task(name, fn, { description })`.
   * Travels with the data so a reader of the document has intent, not just
   * numbers. */
  description?: string
  /** The enclosing group's `group(name, fn, { description })`. Repeated on every
   * workload in the group so each record is self-contained. */
  groupDescription?: string
  /** Whether this task ran in a subprocess dedicated to it alone (`isolate`
   * on the task, its group, or the suite), vs. sharing its suite file's
   * subprocess with other tasks. */
  isolated?: boolean
  /** Structured parameters this task point represents (e.g. `{ size: 800,
   * impl: "fast" }`), from `task(name, fn, { params })` or a `sweep()` point.
   * Lets renderers pivot and `compare` match on them instead of only on the
   * task name. Part of the workload id when present, so two points that
   * share a task name (a `sweep()`'s whole point) don't collide. */
  params?: Record<string, string | number | boolean>
  /** From `task.skip()` or a `group.skip()` this task was inside. The runner
   * never measures it, so this workload has no matching `Measurement`; a
   * renderer prints it as a "- skipped" row instead of omitting it, and
   * `compare` treats it as `unchanged` (with a `skipped` warning) rather
   * than silently passing or failing to match it. */
  skipped?: boolean
}

export type Phase = "timing" | "cpu" | "heap" | "memstats"

export interface Measurement {
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
  baselineMeasurementId?: string
  /** True when this timing measurement's trials were run round-robin against
   * the other commands in the same `time()` call (`--interleave`, default on
   * for 2+ commands) rather than run to completion before the next command
   * started, so drift over the run's wall-clock span (thermal throttling, a
   * noisy neighbor process) lands on every command equally instead of
   * favoring whichever ran first or last. */
  interleaved?: boolean
}

export interface Trial {
  i: number
  wallNs: number
  /** The command's self-reported time (ns) when the workload has a
   * `timeSource`; `timing.samples` are these, not `wallNs`, in that case.
   * `wallNs` stays alongside so a document keeps both. */
  reportedNs?: number
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
  /** 75th percentile, ns. Optional: absent on documents saved before this
   * field existed (`loadDocument` never backfills it). */
  p75?: number
  /** 99th percentile, ns. Same caveat as `p75`. */
  p99?: number
  /** Median absolute deviation, ns: the median of `|sample - median|` across
   * all samples. A robust spread measure that (unlike stddev) isn't skewed
   * by the long right tail typical of wall-clock timings. */
  mad?: number
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
  /** Bytes allocated per call, from `ostia bench --alloc`: heap size delta
   * (`bun:jsc`'s `heapStats().heapSize`, falling back to
   * `process.memoryUsage().heapUsed`) around one `Bun.gc(true)`-bracketed
   * batch, divided by the batch size. */
  bytesPerOp?: number
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
  | "thin-comparison"
  | "noisy-machine"
  | "skipped"
  | "jit-cold"

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
  baselineMeasurementId: string
  candidateMeasurementId: string
  timing?: {
    medianDeltaPct: number
    meanDeltaPct: number
    /** Same value as `medianDeltaPct`, named for what it is used for: the
     * effect size the verdict rule tests against `thresholds.timingPct`. */
    effectPct: number
    /** 95% bootstrap confidence interval on the difference of medians,
     * percent of the baseline median. Absent when either side had fewer
     * than 5 samples (see the `thin-comparison` warning). */
    ci95?: [number, number]
    /** Two-sided Mann-Whitney U p-value, tie-corrected normal approximation.
     * Same absence condition as `ci95`. */
    pValue?: number
    /** Seed for the bootstrap's PRNG, so `ci95` is reproducible. */
    seed?: number
    verdict: "improved" | "regressed" | "unchanged"
  }
  /** Attached when timing fell back to the point-estimate rule (thin
   * samples) or otherwise carries a caveat about this comparison. */
  warnings?: Warning[]
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
    alpha: number
    bootstrapIterations: number
    /** `max(timingPct, base.environment.noise.floorPct,
     * cand.environment.noise.floorPct)` - the threshold timing was actually
     * tested against, once machine noise widens it past `timingPct`. */
    effectiveTimingPct: number
  }
  verdict: "pass" | "fail"
}
