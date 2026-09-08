import type {
  Comparison,
  GitMetadata,
  Measurement,
  ProfileDocument,
  Workload,
} from "../../ir/types.ts"
import { relativeReferences } from "../relative.ts"
import type { Renderer, RenderResult } from "../types.ts"

/** Bumped only on a breaking change to the event shapes below (a key
 * renamed or removed) - new keys are always additive and don't require a
 * bump. Every `minimal` line carries this, so a consumer can branch on it
 * instead of guessing from the keys present. */
export const MINIMAL_PROTOCOL_VERSION = 1 as const

interface MinimalWarning {
  code: string
  data?: Record<string, unknown>
}

export interface MinimalDelta {
  medianPct: number
  meanPct: number
  verdict: "improved" | "regressed" | "unchanged"
  pass: boolean
  /** 95% bootstrap CI on the difference of medians and the Mann-Whitney
   * p-value behind the verdict. Absent on a thin (<5 samples/side)
   * comparison, which falls back to a point-estimate threshold. */
  ci95?: [number, number]
  pValue?: number
  /** The threshold this delta was actually tested against, once machine
   * noise widened it past `thresholds.timingPct` - see
   * `Comparison.thresholds.effectiveTimingPct`. */
  effectiveTimingPct: number
  matched: true
}

/** One JSON object per timing run, nothing else: no header, no raw sample
 * array, no prose. Built for piping into an LLM agent's context, where the full
 * `ProfileDocument` (tens of thousands of samples per fast task) is mostly
 * tokens a reviewer never reads. Numbers stay in the IR's unit (ns) so they
 * line up with `compare` deltas and the JSON document without conversion. */
export interface MinimalRunLine {
  event: "run"
  protocolVersion: typeof MINIMAL_PROTOCOL_VERSION
  schemaVersion: ProfileDocument["schemaVersion"]
  /** Join key back to `Workload.id` / `Comparison.candidateMeasurementId` -
   * stable across a `time`/`compare`/`ci` invocation of the same command,
   * unlike `task` (a label, not an identity). */
  workloadId: string
  task: string
  group?: string
  description?: string
  groupDescription?: string
  /** From `task(name, fn, { params })` or a `sweep()` point. */
  params?: Record<string, string | number | boolean>
  /** From `task.skip()` / `group.skip()`: no measurement was taken, so every
   * stats field below is absent on this line. */
  skipped?: true
  unit?: "ns"
  samples?: number
  /** In-process trials batched into one timed block (see
   * `measure/inprocess.ts`'s `sizeBatch`) so the timer's own resolution
   * doesn't dominate a sub-microsecond task's reading. 1 when the timing
   * engine never batched (every subprocess run, and any in-process run
   * whose single call already clears the batching threshold). */
  batch: number
  mean?: number
  median?: number
  stddev?: number
  stddevPct?: number
  min?: number
  max?: number
  /** 75th/99th percentile and median absolute deviation, ns. Absent on
   * documents saved before these fields existed. */
  p75?: number
  p99?: number
  mad?: number
  /** Median over the group's reference median (its baseline task, else its
   * fastest). Only present when the document has more than one timing run. */
  relative?: number
  baseline?: true
  /** `mad / median` of the machine's ~200ms reference measurement - how
   * noisy this machine is right now, independent of what's being measured.
   * From `document.environment`; absent when `noiseCheck: false` skipped it. */
  noiseFloorPct?: number
  warnings: MinimalWarning[]
  /** From `comparisons` when present (ostia compare / ci): the change against
   * the baseline document for this task. */
  delta?: MinimalDelta
}

/** One per workload present on only one side of a `compare`/`ci` run - a
 * baseline row whose candidate went away, or a new candidate workload with
 * no baseline to compare against. */
export interface MinimalUnmatchedLine {
  event: "unmatched"
  protocolVersion: typeof MINIMAL_PROTOCOL_VERSION
  workloadId: string
  task: string
  side: "base" | "cand"
}

/** Exactly one, always the last line, for `compare`/`ci` (never for a bare
 * `time`/`bench` document, which has no baseline to summarize against). */
export interface MinimalSummaryLine {
  event: "summary"
  protocolVersion: typeof MINIMAL_PROTOCOL_VERSION
  command: "compare" | "ci"
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
  git?: { base?: GitMetadata; cand?: GitMetadata }
  exportedTo?: string
  verdict: "pass" | "fail"
  exitCode: number
}

export type MinimalEvent =
  | MinimalRunLine
  | MinimalUnmatchedLine
  | MinimalSummaryLine

/** Data no single `ProfileDocument` carries that the `unmatched`/`summary`
 * events need: the *other* document's `git`, `ci`'s baseline name and
 * cached/executed/failed/missingBaseline counts, `--export-json`'s path, and
 * the process's actual exit code (decided by the CLI after this render, for
 * every format but `minimal` - `minimal` needs it inline instead). The CLI
 * builds this for `ostia compare`/`ostia ci`; every other caller (`time`,
 * `bench`, `report`) renders with no `protocol`, which keeps `minimal` to
 * plain `run` lines with no trailing summary. */
export interface MinimalProtocolContext {
  command: "compare" | "ci"
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

function taskLabel(w: Workload | undefined, fallbackId: string): string {
  return w?.entry?.task ?? w?.label ?? w?.command?.join(" ") ?? fallbackId
}

/** Copies the workload's descriptive fields onto `line`, only when set, so
 * the JSON line stays free of `undefined`-valued keys. */
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

function skippedLine(
  doc: ProfileDocument,
  workload: Workload,
  cmp: Comparison | undefined,
  noiseFloorPct: number | undefined,
): MinimalRunLine {
  const line: MinimalRunLine = {
    event: "run",
    protocolVersion: MINIMAL_PROTOCOL_VERSION,
    schemaVersion: doc.schemaVersion,
    workloadId: workload.id,
    task: taskLabel(workload, workload.id),
    skipped: true,
    batch: 1,
    warnings: (cmp?.warnings ?? []).map((w) =>
      w.data ? { code: w.code, data: w.data } : { code: w.code },
    ),
  }
  addWorkloadFields(line, workload)
  if (noiseFloorPct !== undefined) line.noiseFloorPct = sig(noiseFloorPct)
  const delta = deltaFrom(cmp)
  if (delta) line.delta = delta
  return line
}

function runLines(doc: ProfileDocument): MinimalRunLine[] {
  const byWorkload = new Map(doc.workloads.map((w) => [w.id, w]))
  const noiseFloorPct = doc.environment?.noise.floorPct
  const rows = doc.measurements
    .filter(
      (r): r is Measurement & { timing: NonNullable<Measurement["timing"]> } =>
        r.phase === "timing" && r.timing !== undefined,
    )
    .map((run) => ({ run, workload: byWorkload.get(run.workloadId) }))
  const refs = rows.length > 1 ? relativeReferences(rows) : undefined
  const comparisonByRun = new Map(
    (doc.comparisons ?? []).map((c) => [c.candidateMeasurementId, c]),
  )
  const measuredWorkloadIds = new Set(rows.map((r) => r.run.workloadId))
  const cpuWarningsByWorkloadId = new Map<string, Measurement["warnings"]>()
  for (const m of doc.measurements) {
    if (m.phase !== "cpu" || m.warnings.length === 0) continue
    const existing = cpuWarningsByWorkloadId.get(m.workloadId) ?? []
    cpuWarningsByWorkloadId.set(m.workloadId, [...existing, ...m.warnings])
  }
  const skippedLines = doc.workloads
    .filter((w) => w.skipped && !measuredWorkloadIds.has(w.id))
    .map((w) => skippedLine(doc, w, comparisonByRun.get(w.id), noiseFloorPct))

  const measuredLines = rows.map((row) => {
    const { run, workload } = row
    const t = run.timing
    const comparison = comparisonByRun.get(run.id)
    const line: MinimalRunLine = {
      event: "run",
      protocolVersion: MINIMAL_PROTOCOL_VERSION,
      schemaVersion: doc.schemaVersion,
      workloadId: run.workloadId,
      task: taskLabel(workload, run.workloadId),
      unit: "ns",
      samples: t.samples.length,
      batch: t.batch ?? 1,
      mean: sig(t.mean),
      median: sig(t.median),
      stddev: sig(t.stddev),
      stddevPct: sig(t.mean === 0 ? 0 : (t.stddev / t.mean) * 100),
      min: sig(t.min),
      max: sig(t.max),
      warnings: [
        ...run.warnings,
        ...(cpuWarningsByWorkloadId.get(run.workloadId) ?? []),
        ...(comparison?.warnings ?? []),
      ].map((w) =>
        w.data ? { code: w.code, data: w.data } : { code: w.code },
      ),
    }
    if (t.p75 !== undefined) line.p75 = sig(t.p75)
    if (t.p99 !== undefined) line.p99 = sig(t.p99)
    if (t.mad !== undefined) line.mad = sig(t.mad)
    addWorkloadFields(line, workload)
    if (refs) line.relative = sig(t.median / (refs.get(row) ?? t.median))
    if (workload?.baseline) line.baseline = true
    if (noiseFloorPct !== undefined) line.noiseFloorPct = sig(noiseFloorPct)
    const delta = deltaFrom(comparison)
    if (delta) line.delta = delta
    return line
  })

  return [...measuredLines, ...skippedLines]
}

function unmatchedLines(
  protocol: MinimalProtocolContext,
): MinimalUnmatchedLine[] {
  if (!protocol.unmatched) return []
  const line = (w: Workload, side: "base" | "cand"): MinimalUnmatchedLine => ({
    event: "unmatched",
    protocolVersion: MINIMAL_PROTOCOL_VERSION,
    workloadId: w.id,
    task: taskLabel(w, w.id),
    side,
  })
  return [
    ...protocol.unmatched.baseOnly.map((w) => line(w, "base")),
    ...protocol.unmatched.candOnly.map((w) => line(w, "cand")),
  ]
}

function summaryLine(
  doc: ProfileDocument,
  protocol: MinimalProtocolContext,
): MinimalSummaryLine {
  const s = doc.comparisonSummary
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
    verdict: protocol.exitCode === 0 ? "pass" : "fail",
    exitCode: protocol.exitCode,
  }
  if (protocol.command === "ci") {
    line.cached = protocol.cached ?? 0
    line.executed = protocol.executed ?? 0
    line.failed = protocol.failed ?? 0
    line.missingBaseline = protocol.missingBaseline ?? 0
    if (protocol.baseline) line.baseline = protocol.baseline
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
