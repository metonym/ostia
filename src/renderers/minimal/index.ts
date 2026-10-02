import type {
  Comparison,
  GitMetadata,
  Measurement,
  ProfileDocument,
  Warning,
  Workload,
} from "../../ir/types.ts"
import { cpuTimes, labelOrId } from "../format.ts"
import { pairedRuns } from "../paired.ts"
import { relativeRatios } from "../relative.ts"
import {
  memoryReadings,
  noSampleRuns,
  skippedWorkloads,
  timingRuns,
  workloadsById,
} from "../select.ts"
import type { Renderer, RenderResult } from "../types.ts"

/** Bumped only on a breaking change to the event shapes (a key renamed or
 * removed); new keys are additive. Every line carries it. */
export const MINIMAL_PROTOCOL_VERSION = 2 as const

interface MinimalWarning {
  code: string
  data?: Record<string, unknown>
}

interface MinimalDelta {
  medianPct: number
  meanPct: number
  verdict: "improved" | "regressed" | "unchanged"
  pass: boolean
  /** 95% bootstrap CI on the difference of medians; absent (with `pValue`)
   * on a thin (<5 samples/side) comparison. */
  ci95?: [number, number]
  pValue?: number
  /** The threshold actually tested against, after machine noise widened it. */
  effectiveTimingPct: number
  matched: true
}

/** `ab` only: the base side and per-round candidate/base ratios behind a
 * `run` line whose stats are the candidate's. Ratios above 1 mean slower. */
interface MinimalPaired {
  /** Base side's median per-call time, ns. */
  baseMedian: number
  medianRatio: number
  ratioP25: number
  ratioP75: number
  rounds: number
  /** `flagged` when fresh processes confirmed it, else `"unchanged"`. */
  verdict: "regressed" | "improved" | "unchanged"
  /** What the first process saw, before confirmation. */
  flagged?: "regressed" | "improved"
  confirmed?: boolean
  /** Median ratio of each fresh-process repeat. */
  repeats?: number[]
  sameOutput: boolean
}

/** One per timing run, for piping into an agent's context in place of the full
 * `ProfileDocument`. Numbers stay in the IR's units (ns). */
interface MinimalRunLine {
  event: "run"
  protocolVersion: typeof MINIMAL_PROTOCOL_VERSION
  schemaVersion: ProfileDocument["schemaVersion"]
  /** Join key to `Workload.id` / `Comparison.candidateMeasurementId`; unlike
   * `task`, stable across invocations. */
  workloadId: string
  task: string
  group?: string
  description?: string
  groupDescription?: string
  params?: Record<string, string | number | boolean>
  /** `task.skip()` / `group.skip()`: no measurement, so every stats field is absent. */
  skipped?: true
  unit?: "ns"
  /** 0, with every stats field absent, when no trial produced a sample (all
   * timed out or missed the `timeSource` pattern); see `warnings`. */
  samples?: number
  /** In-process trials batched into one timed block; 1 when never batched. */
  batch: number
  mean?: number
  median?: number
  stddev?: number
  stddevPct?: number
  min?: number
  max?: number
  /** 75th/99th percentile and median absolute deviation, ns. */
  p75?: number
  p99?: number
  mad?: number
  /** Median user / system CPU time per trial, ns: subprocess commands only. */
  userNs?: number
  systemNs?: number
  /** `--alloc`: heap each call keeps alive after a full GC, bytes. */
  retainedBytesPerOp?: number
  /** `--peak-mem`: how far the task's first call raised RSS, bytes. */
  peakBytes?: number
  /** Median over the group's reference median (its baseline task, else its
   * fastest); only when the document has more than one timing run. */
  relative?: number
  baseline?: true
  /** The machine's noise floor from `document.environment`; absent when the
   * noise check was skipped. */
  noiseFloorPct?: number
  warnings: MinimalWarning[]
  /** The change against the baseline document (`compare` / `ci`). */
  delta?: MinimalDelta
  paired?: MinimalPaired
}

/** A workload present on only one side of a `compare`/`ci` run. */
interface MinimalUnmatchedLine {
  event: "unmatched"
  protocolVersion: typeof MINIMAL_PROTOCOL_VERSION
  workloadId: string
  task: string
  side: "base" | "cand"
}

/** The last line of a `compare`/`ci`/`ab` run; never emitted for a bare
 * `time`/`bench` document. */
interface MinimalSummaryLine {
  event: "summary"
  protocolVersion: typeof MINIMAL_PROTOCOL_VERSION
  command: "compare" | "ci" | "ab"
  matched: number
  regressed: number
  improved: number
  unchanged: number
  unmatched: number
  /** `ci` only. */
  cached?: number
  executed?: number
  failed?: number
  missingBaseline?: number
  geomeanPct: number | null
  effectiveTimingPct: number
  noiseFloorPct?: number
  /** `ci` only. */
  baseline?: { name: string; path: string }
  /** `ab` only: the git ref the working tree was paired against. */
  base?: { ref: string; sha: string }
  /** `ab` only: the gate on `geomeanPct`. */
  geomeanThresholdPct?: number
  /** `ab` only: flagged in the first process but not reproduced; counted in `unchanged`. */
  unconfirmed?: number
  /** `ab` only: workloads whose first call returned different values on the two sides. */
  outputDiffers?: number
  git?: { base?: GitMetadata; cand?: GitMetadata }
  exportedTo?: string
  /** `pass` (exit 0), `fail` (exit 1: a regression), else `error` (exit 2, or
   * 130 when cancelled): no verdict was reached. */
  verdict: "pass" | "fail" | "error"
  exitCode: number
}

export type MinimalEvent =
  | MinimalRunLine
  | MinimalUnmatchedLine
  | MinimalSummaryLine

/** What the `unmatched`/`summary` events need beyond one `ProfileDocument`.
 * The CLI builds it for `compare`/`ci`/`ab`; without it `minimal` emits only
 * `run` lines. `exitCode` is inline because the CLI decides it after rendering. */
export interface MinimalProtocolContext {
  command: "compare" | "ci" | "ab"
  exitCode: number
  unmatched?: { baseOnly: Workload[]; candOnly: Workload[] }
  baseGit?: GitMetadata
  candGit?: GitMetadata
  baseline?: { name: string; path: string }
  cached?: number
  executed?: number
  failed?: number
  missingBaseline?: number
  exportedTo?: string
}

export interface MinimalRenderOptions {
  protocol?: MinimalProtocolContext
}

function sig(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(6)) : n
}

function minimalWarnings(warnings: Warning[]): MinimalWarning[] {
  return warnings.map((w) =>
    w.data ? { code: w.code, data: w.data } : { code: w.code },
  )
}

function addWorkloadFields(
  line: MinimalRunLine,
  w: Workload | undefined,
): void {
  if (w?.entry?.group !== undefined) line.group = w.entry.group
  if (w?.description !== undefined) line.description = w.description
  if (w?.groupDescription !== undefined)
    line.groupDescription = w.groupDescription
  if (w?.params !== undefined) line.params = w.params
}

function deltaFrom(cmp: Comparison | undefined): MinimalDelta | undefined {
  if (!cmp?.timing) return undefined
  const delta: MinimalDelta = {
    medianPct: sig(cmp.timing.medianDeltaPct),
    meanPct: sig(cmp.timing.meanDeltaPct),
    verdict: cmp.timing.verdict,
    pass: cmp.verdict === "pass",
    effectiveTimingPct: sig(cmp.thresholds.effectiveTimingPct),
    matched: true,
  }
  if (cmp.timing.ci95) {
    delta.ci95 = [sig(cmp.timing.ci95[0]), sig(cmp.timing.ci95[1])]
  }
  if (cmp.timing.pValue !== undefined) delta.pValue = sig(cmp.timing.pValue)
  return delta
}

/** A `run` line with no stats: a `task.skip()`'d workload, or one whose trials
 * produced no samples (`samples: 0`). */
function statlessLine(
  doc: ProfileDocument,
  workload: Workload,
  kind: Pick<MinimalRunLine, "skipped" | "samples">,
  warnings: Warning[],
  cmp: Comparison | undefined,
  noiseFloorPct: number | undefined,
): MinimalRunLine {
  const line: MinimalRunLine = {
    event: "run",
    protocolVersion: MINIMAL_PROTOCOL_VERSION,
    schemaVersion: doc.schemaVersion,
    workloadId: workload.id,
    task: labelOrId(workload, workload.id),
    ...kind,
    batch: 1,
    warnings: minimalWarnings(warnings),
  }
  addWorkloadFields(line, workload)
  if (noiseFloorPct !== undefined) line.noiseFloorPct = sig(noiseFloorPct)
  const delta = deltaFrom(cmp)
  if (delta) line.delta = delta
  return line
}

function runLines(doc: ProfileDocument): MinimalRunLine[] {
  const byWorkload = workloadsById(doc)
  const noiseFloorPct = doc.environment?.noise.floorPct
  const withWorkload = <R extends { workloadId: string }>(run: R) => ({
    run,
    workload: byWorkload.get(run.workloadId),
  })
  const timingRows = timingRuns(doc).map(withWorkload)
  const ratios = relativeRatios(timingRows)
  const rows = [...timingRows, ...pairedRuns(doc).map(withWorkload)]
  const comparisonByRun = new Map(
    (doc.comparisons ?? []).map((c) => [c.candidateMeasurementId, c]),
  )
  const memory = memoryReadings(doc)
  const cpuWarningsByWorkloadId = new Map<string, Warning[]>()
  for (const m of doc.measurements) {
    if (m.phase !== "cpu" || m.warnings.length === 0) continue
    const existing = cpuWarningsByWorkloadId.get(m.workloadId) ?? []
    cpuWarningsByWorkloadId.set(m.workloadId, [...existing, ...m.warnings])
  }
  const warningsOf = (run: Measurement, comparison: Comparison | undefined) => [
    ...run.warnings,
    ...(cpuWarningsByWorkloadId.get(run.workloadId) ?? []),
    ...(memory.get(run.workloadId)?.warnings ?? []),
    ...(comparison?.warnings ?? []),
  ]
  const skippedLines = skippedWorkloads(
    doc,
    rows.map((r) => r.run),
  ).map((w) =>
    statlessLine(
      doc,
      w,
      { skipped: true },
      comparisonByRun.get(w.id)?.warnings ?? [],
      comparisonByRun.get(w.id),
      noiseFloorPct,
    ),
  )
  const noSampleLines = noSampleRuns(doc).flatMap((run) => {
    const workload = byWorkload.get(run.workloadId)
    if (!workload) return []
    const comparison = comparisonByRun.get(run.id)
    return statlessLine(
      doc,
      workload,
      { samples: 0 },
      warningsOf(run, comparison),
      comparison,
      noiseFloorPct,
    )
  })

  const measuredLines = rows.map((row) => {
    const { run, workload } = row
    const t = run.timing
    const comparison = comparisonByRun.get(run.id)
    const line: MinimalRunLine = {
      event: "run",
      protocolVersion: MINIMAL_PROTOCOL_VERSION,
      schemaVersion: doc.schemaVersion,
      workloadId: run.workloadId,
      task: labelOrId(workload, run.workloadId),
      unit: "ns",
      samples: t.samples.length,
      batch: t.batch ?? 1,
      mean: sig(t.mean),
      median: sig(t.median),
      stddev: sig(t.stddev),
      stddevPct: sig(t.mean === 0 ? 0 : (t.stddev / t.mean) * 100),
      min: sig(t.min),
      max: sig(t.max),
      warnings: minimalWarnings(warningsOf(run, comparison)),
    }
    line.p75 = sig(t.p75)
    line.p99 = sig(t.p99)
    line.mad = sig(t.mad)
    const times = cpuTimes(run)
    if (times) {
      line.userNs = sig(times.userNs)
      line.systemNs = sig(times.systemNs)
    }
    const readings = memory.get(run.workloadId)
    if (readings?.retained !== undefined) {
      line.retainedBytesPerOp = Math.round(readings.retained)
    }
    if (readings?.peak !== undefined) {
      line.peakBytes = Math.round(readings.peak)
    }
    addWorkloadFields(line, workload)
    const ratio = ratios?.get(row)
    if (ratio !== undefined) line.relative = sig(ratio)
    if (workload?.baseline) line.baseline = true
    if (noiseFloorPct !== undefined) line.noiseFloorPct = sig(noiseFloorPct)
    const delta = deltaFrom(comparison)
    if (delta) line.delta = delta
    const p = run.paired
    if (p) {
      line.paired = {
        baseMedian: sig(p.baseMedianNs),
        medianRatio: sig(p.medianRatio),
        ratioP25: sig(p.ratioP25),
        ratioP75: sig(p.ratioP75),
        rounds: p.rounds,
        verdict: p.verdict,
        ...(p.flagged && { flagged: p.flagged }),
        ...(p.confirmed !== undefined && { confirmed: p.confirmed }),
        ...(p.repeats && { repeats: p.repeats.map((r) => sig(r.medianRatio)) }),
        sameOutput: p.sameOutput,
      }
    }
    return line
  })

  return [...measuredLines, ...noSampleLines, ...skippedLines]
}

function unmatchedLines(
  protocol: MinimalProtocolContext,
): MinimalUnmatchedLine[] {
  if (!protocol.unmatched) return []
  const line = (w: Workload, side: "base" | "cand"): MinimalUnmatchedLine => ({
    event: "unmatched",
    protocolVersion: MINIMAL_PROTOCOL_VERSION,
    workloadId: w.id,
    task: labelOrId(w, w.id),
    side,
  })
  return [
    ...protocol.unmatched.baseOnly.map((w) => line(w, "base")),
    ...protocol.unmatched.candOnly.map((w) => line(w, "cand")),
  ]
}

function verdictOf(exitCode: number): MinimalSummaryLine["verdict"] {
  return exitCode === 0 ? "pass" : exitCode === 1 ? "fail" : "error"
}

function summaryLine(
  doc: ProfileDocument,
  protocol: MinimalProtocolContext,
): MinimalSummaryLine {
  const s =
    protocol.command === "ab" && doc.ab
      ? { ...doc.ab, effectiveTimingPct: doc.ab.thresholdPct }
      : doc.comparisonSummary
  const unmatchedCount =
    (protocol.unmatched?.baseOnly.length ?? 0) +
    (protocol.unmatched?.candOnly.length ?? 0)
  const line: MinimalSummaryLine = {
    event: "summary",
    protocolVersion: MINIMAL_PROTOCOL_VERSION,
    command: protocol.command,
    matched: s?.matched ?? 0,
    regressed: s?.regressed ?? 0,
    improved: s?.improved ?? 0,
    unchanged: s?.unchanged ?? 0,
    unmatched: unmatchedCount,
    geomeanPct: s?.geomeanPct !== undefined ? s.geomeanPct : null,
    effectiveTimingPct: sig(s?.effectiveTimingPct ?? 0),
    verdict: verdictOf(protocol.exitCode),
    exitCode: protocol.exitCode,
  }
  if (protocol.command === "ci") {
    line.cached = protocol.cached ?? 0
    line.executed = protocol.executed ?? 0
    line.failed = protocol.failed ?? 0
    line.missingBaseline = protocol.missingBaseline ?? 0
    if (protocol.baseline) line.baseline = protocol.baseline
  }
  if (protocol.command === "ab" && doc.ab) {
    line.base = doc.ab.base
    line.geomeanThresholdPct = doc.ab.geomeanThresholdPct
    line.unconfirmed = doc.ab.unconfirmed
    line.outputDiffers = doc.ab.outputDiffers
  }
  if (doc.environment) line.noiseFloorPct = sig(doc.environment.noise.floorPct)
  if (protocol.baseGit || protocol.candGit) {
    line.git = {
      ...(protocol.baseGit && { base: protocol.baseGit }),
      ...(protocol.candGit && { cand: protocol.candGit }),
    }
  }
  if (protocol.exportedTo) line.exportedTo = protocol.exportedTo
  return line
}

export const minimalRenderer: Renderer<MinimalRenderOptions> = {
  name: "minimal",
  async render(
    doc: ProfileDocument,
    options: MinimalRenderOptions = {},
  ): Promise<RenderResult> {
    const events: MinimalEvent[] = [...runLines(doc)]
    if (options.protocol) {
      events.push(...unmatchedLines(options.protocol))
      events.push(summaryLine(doc, options.protocol))
    }
    const lines = events.map((l) => JSON.stringify(l))
    return { text: lines.length > 0 ? `${lines.join("\n")}\n` : "" }
  },
}
