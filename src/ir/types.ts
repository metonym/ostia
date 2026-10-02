// Profile IR schema v2. Units: ns (time), bytes (memory), µs (sampling interval).

export interface ProfileDocument {
  schemaVersion: 2
  toolVersion: string
  bunVersion: string
  platform: { os: string; arch: string }
  /** ISO timestamp; metadata only, never part of an id. */
  createdAt: string
  workloads: Workload[]
  measurements: Measurement[]
  comparisons?: Comparison[]
  /** Aggregate across `comparisons`; present wherever `comparisons` is. */
  comparisonSummary?: ComparisonSummary
  /** Workload ids on only one side of the comparison; present wherever
   * `comparisons` is. */
  unmatched?: { baseOnly: string[]; candOnly: string[] }
  /** Machine conditions at measurement time; absent when the noise check was
   * skipped. */
  environment?: Environment
  /** Run-level result of `ostia ab` / `ab()`, whose measurements are
   * `phase: "paired"`. */
  ab?: AbSummary
  /** Repo state of the process's cwd; absent outside a git repo. Never part of
   * an id or fingerprint, so a commit or dirty tree doesn't orphan a baseline. */
  git?: GitMetadata
}

export interface GitMetadata {
  sha: string
  branch: string
  dirty: boolean
}

export interface NoiseFloor {
  /** `mad / median` of a reference workload, percent: how noisy the machine is
   * right now, independent of what's measured. */
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
  /** Identifies what is measured, not where or when. Subprocess: a hash of
   * argv, `prepare` and `timeSource`, excluding `process.cwd()`. In-process: a
   * hash of the function source, or for a registry entry the file, task name
   * and `params`. Annotations (`label`, `description`, `baseline`) never
   * affect it. */
  id: string
  kind: "subprocess" | "inprocess"
  label?: string
  command?: string[]
  /** Command-form `prepare` hook run before every trial; part of the id. A
   * function-form hook isn't serializable and is omitted (its source is still
   * hashed into the id). */
  prepare?: string[]
  /** Takes samples from a number in the command's own output instead of the
   * wall clock; part of the id. */
  timeSource?: {
    pattern: string
    group?: number
    unit?: "ns" | "us" | "ms" | "s"
  }
  /** `task` is the registry's "group/name" id; `group` is the enclosing
   * `group()` name. Renderers prefer `group` over splitting `task` on "/". */
  entry?: { file: string; task: string; group?: string }
  /** The Relative reference for its group; renderers use the first one found. */
  baseline?: boolean
  /** What this task measures and why, from `task(..., { description })`. */
  description?: string
  /** The enclosing group's description, repeated on every workload in it. */
  groupDescription?: string
  /** Ran in a subprocess of its own rather than sharing its suite file's. */
  isolated?: boolean
  /** From `task(..., { params })` or a `sweep()` point. Part of the id, so
   * points sharing a task name don't collide. */
  params?: Record<string, string | number | boolean>
  /** From `task.skip()` / `group.skip()`: never measured, so no `Measurement`.
   * Renderers print a "- skipped" row; `compare` treats it as `unchanged` with
   * a `skipped` warning. */
  skipped?: boolean
}

export type Phase = "timing" | "cpu" | "heap" | "memstats" | "paired"

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
  /** `phase: "paired"` only; `timing` is then the candidate side. */
  paired?: PairedEvidence
  warnings: Warning[]
  artifacts: ArtifactRef[]
  /** Trials ran round-robin with the other commands of the same `time()` call,
   * so drift over the run hits every command equally. */
  interleaved?: boolean
}

export interface Trial {
  i: number
  wallNs: number
  /** The command's self-reported time (ns) under a `timeSource`; these, not
   * `wallNs`, are then the `timing.samples`. */
  reportedNs?: number
  exitCode?: number
  userNs?: number
  systemNs?: number
  maxRssBytes?: number
  /** Killed by `timeoutMs`; `exitCode` is absent. Contributes no sample. */
  timedOut?: true
  /** Output didn't match the `timeSource` pattern; `reportedNs` is absent
   * (never a `wallNs` fallback). Contributes no sample. */
  timeSourceNoMatch?: true
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
  /** 25th percentile, ns. */
  p25: number
  /** 75th percentile, ns. */
  p75: number
  /** 99th percentile, ns. */
  p99: number
  /** Median absolute deviation, ns: a spread measure that, unlike stddev, the
   * long right tail of wall-clock timings doesn't skew. */
  mad: number
  /** Calls batched into one timed block; absent (read as 1) unless batching
   * occurred, and always absent for subprocess timing. */
  batch?: number
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
  origin: "heap-prof"
  heapSizeBytes?: number
  objectCount?: number
  typeCounts: { type: string; count: number; retainedBytes?: number }[]
}

export interface MemoryEvidence {
  origin: "resourceUsage" | "heapStats"
  /** `memstats` only: `"retained"` (`--alloc`, `bytesPerOp`) or `"peak"`
   * (`--peak-mem`, `peakBytes`). Absent means `"retained"` on older documents. */
  kind?: "retained" | "peak"
  /** Largest `Trial.maxRssBytes` across a timing measurement's trials. */
  maxRssBytes?: number
  /** `--alloc`: heap growth per call across one batch bracketed by full GCs,
   * so what the calls keep alive (a leak check), not what they allocate. */
  bytesPerOp?: number
  /** `--peak-mem`: how far one call raised RSS, garbage included; median over
   * 3 fresh processes. A `peak-hidden` warning says when it may read low. */
  peakBytes?: number
}

export interface JitTierBreakdown {
  origin: "jsc-profile"
  tiers: { llint: number; baseline: number; dfg: number; ftl: number }
  topFramesByTier?: { tier: string; frameKey: string; samples: number }[]
}

/** Evidence of a `phase: "paired"` measurement: base and candidate alternate
 * in batches in one process, so drift cancels in the ratio. */
export interface PairedEvidence {
  /** One base batch and one candidate batch per round, alternating order. */
  rounds: number
  /** Calls per side per round. */
  batch: number
  /** Base per-call time for each round, ns; `ratios[i]` pairs with
   * `baseSamples[i]` and the candidate's `timing.samples[i]`. */
  baseSamples: number[]
  baseMedianNs: number
  /** Candidate/base time per round. */
  ratios: number[]
  medianRatio: number
  /** 25th/75th percentile of `ratios`. */
  ratioP25: number
  ratioP75: number
  /** Median ratio past `1 ± threshold` and on the same side of 1 in at least
   * three quarters of rounds. */
  flagged?: "regressed" | "improved"
  /** Each fresh-process re-measurement of a flagged workload. */
  repeats?: {
    medianRatio: number
    ratioP25: number
    ratioP75: number
    flagged?: "regressed" | "improved"
  }[]
  /** Set when `flagged` is: whether every repeat flagged the same way. */
  confirmed?: boolean
  /** `flagged` when confirmed, else `"unchanged"`. */
  verdict: "regressed" | "improved" | "unchanged"
  /** First call's return values were deep-equal on both sides; informational,
   * never a failure. */
  sameOutput: boolean
}

/** Run-level result of `ab()`, stamped on the document as `ab`. */
export interface AbSummary {
  base: { ref: string; sha: string }
  rounds: number
  thresholdPct: number
  geomeanThresholdPct: number
  /** Workloads measured on both sides. */
  matched: number
  /** Confirmed verdicts. */
  regressed: number
  improved: number
  unchanged: number
  /** Flagged in-process, but a fresh-process repeat disagreed; counted in
   * `unchanged`. */
  unconfirmed: number
  /** Workloads whose first call returned different values on each side. */
  outputDiffers: number
  /** Geometric mean of the workloads' median ratios, signed percent (negative:
   * candidate faster); a flagged workload contributes its median over its main
   * run and repeats. `null` when nothing was paired. */
  geomeanPct: number | null
  /** `"fail"` when any workload regressed (confirmed) or `geomeanPct`
   * exceeds `geomeanThresholdPct`. */
  verdict: "pass" | "fail"
}

/** Every `Warning.code`. A runtime array so a test can assert each is emitted. */
export const WARNING_CODES = [
  "slow-first-run",
  "outliers-detected",
  "fast-command",
  "nonzero-exit",
  "artifact-missing",
  "empty-profile",
  "low-sample-count",
  "thin-comparison",
  "noisy-machine",
  "skipped",
  "jit-cold",
  "timeout",
  "aborted",
  "time-source-no-match",
  "environment-mismatch",
  "peak-hidden",
] as const

export type WarningCode = (typeof WARNING_CODES)[number]

export interface Warning {
  code: WarningCode
  message: string
  data?: Record<string, unknown>
}

export interface ArtifactRef {
  id: string
  kind: "cpuprofile" | "heapsnapshot"
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
    /** 95% bootstrap CI on the difference of medians, percent of the baseline
     * median. Absent below 5 samples a side (`thin-comparison`). */
    ci95?: [number, number]
    /** Two-sided Mann-Whitney U p-value; absent whenever `ci95` is. */
    pValue?: number
    /** Bootstrap PRNG seed, so `ci95` is reproducible. */
    seed?: number
    verdict: "improved" | "regressed" | "unchanged"
  }
  /** Caveats about this comparison, e.g. a thin-sample point-estimate verdict. */
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
    /** `max(timingPct, both documents' noise floors)`: what timing was tested against. */
    effectiveTimingPct: number
  }
  verdict: "pass" | "fail"
}

/** Aggregate view over a `compareDocuments` call's `Comparison[]`. */
export interface ComparisonSummary {
  /** `comparisons.length`. */
  matched: number
  regressed: number
  improved: number
  unchanged: number
  /** Geometric mean of `cand/base` median ratios, signed percent (negative:
   * candidate faster). `null` when no comparison had a finite ratio. */
  geomeanPct: number | null
  /** `Comparison.thresholds.effectiveTimingPct`, which is the same for the
   * whole document pair. */
  effectiveTimingPct: number
  /** `"fail"` when any comparison's verdict is `"fail"`. */
  verdict: "pass" | "fail"
}
