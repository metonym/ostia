import type {
  ComparedTask,
  Comparison,
  Measurement,
  MemoryDelta,
  ProfileDocument,
  Warning,
  Workload,
} from "../ir/types.ts"
import {
  formatBytes,
  formatSignedPct,
  labelOrId,
  workloadLabel,
} from "./format.ts"

// Below this absolute percent a frame/heap-type delta is noise, not a row.
const MIN_DISPLAY_DELTA_PCT = 0.5

export type TimingRun = Measurement & {
  timing: NonNullable<Measurement["timing"]>
}

export type FrameDelta = NonNullable<Comparison["frames"]>[number]
export type HeapTypeDelta = NonNullable<Comparison["heapTypes"]>[number]

export function workloadsById(doc: ProfileDocument): Map<string, Workload> {
  return new Map(doc.workloads.map((w) => [w.id, w]))
}

export function timingRuns(doc: ProfileDocument): TimingRun[] {
  return doc.measurements.filter(
    (r): r is TimingRun => r.phase === "timing" && r.timing !== undefined,
  )
}

/** Timing measurements that produced no samples (every trial timed out or
 * missed the `timeSource` pattern). Renderers show them as "no samples" rows
 * so their warnings stay visible. */
export function noSampleRuns(doc: ProfileDocument): Measurement[] {
  return doc.measurements.filter(
    (r) => r.phase === "timing" && r.timing === undefined,
  )
}

/** `task.skip()`'d workloads with no measurement, rendered as "- skipped" rows. */
export function skippedWorkloads(
  doc: ProfileDocument,
  runs: { workloadId: string }[],
): Workload[] {
  const measured = new Set(runs.map((r) => r.workloadId))
  return doc.workloads.filter((w) => w.skipped && !measured.has(w.id))
}

/** `environment-mismatch` is the same on every comparison (it concerns the
 * base/cand pair): renderers print it once, from here, and drop it per row. */
export function environmentMismatch(doc: ProfileDocument): Warning | undefined {
  for (const c of doc.comparisons ?? []) {
    const w = c.warnings?.find((w) => w.code === "environment-mismatch")
    if (w) return w
  }
  return undefined
}

export function rowComparisonWarnings(cmp: Comparison): Warning[] {
  return (cmp.warnings ?? []).filter((w) => w.code !== "environment-mismatch")
}

/** Resolves a comparison to its candidate measurement and workload, plus the
 * workload id (the display fallback when the document lacks the workload). A
 * skipped candidate has no measurement, so `candidateMeasurementId` then holds
 * the workload id itself. */
function comparisonResolver(doc: ProfileDocument) {
  const workloads = workloadsById(doc)
  const runs = new Map(doc.measurements.map((m) => [m.id, m]))
  return (cmp: Comparison) => {
    const run = runs.get(cmp.candidateMeasurementId)
    const workloadId = run?.workloadId ?? cmp.candidateMeasurementId
    return { run, workloadId, workload: workloads.get(workloadId) }
  }
}

export function shownFrameDeltas(cmp: Comparison, limit: number): FrameDelta[] {
  return (cmp.frames ?? [])
    .slice(0, limit)
    .filter((f) => Math.abs(f.deltaPct) >= MIN_DISPLAY_DELTA_PCT)
}

export function shownHeapDeltas(
  cmp: Comparison,
  limit: number,
): HeapTypeDelta[] {
  return (cmp.heapTypes ?? [])
    .slice(0, limit)
    .filter((h) => Math.abs(h.deltaPct) >= MIN_DISPLAY_DELTA_PCT)
}

export interface MemoryReadings {
  /** `--alloc`: heap each call retains, bytes. */
  retained?: number
  /** `--peak-mem`: RSS rise of one call, bytes. */
  peak?: number
  /** The `memstats` measurements' warnings (e.g. `peak-hidden`). */
  warnings: Warning[]
}

export function memoryReadings(
  doc: ProfileDocument,
): Map<string, MemoryReadings> {
  const byWorkload = new Map<string, MemoryReadings>()
  for (const m of doc.measurements) {
    if (m.phase !== "memstats" || !m.memory) continue
    const readings = byWorkload.get(m.workloadId) ?? { warnings: [] }
    if (m.memory.bytesPerOp !== undefined)
      readings.retained = m.memory.bytesPerOp
    if (m.memory.peakBytes !== undefined) readings.peak = m.memory.peakBytes
    readings.warnings.push(...m.warnings)
    byWorkload.set(m.workloadId, readings)
  }
  return byWorkload
}

/** A timing run's warnings plus its workload's `memstats` warnings. */
export function runWarnings(
  run: Measurement,
  memory: Map<string, MemoryReadings>,
): Warning[] {
  const extra = memory.get(run.workloadId)?.warnings
  return extra?.length ? [...run.warnings, ...extra] : run.warnings
}

export interface MemoryColumn {
  header: string
  /** Formatted bytes, or undefined when this workload has no reading. */
  cell: (workloadId: string) => string | undefined
}

/** `Retained/op` and `Peak mem` columns, each only when some workload has it. */
export function memoryColumns(
  memory: Map<string, MemoryReadings>,
): MemoryColumn[] {
  const candidates = [
    { header: "Retained/op", read: (r: MemoryReadings) => r.retained },
    { header: "Peak mem", read: (r: MemoryReadings) => r.peak },
  ]
  return candidates
    .filter((c) => {
      for (const r of memory.values()) if (c.read(r) !== undefined) return true
      return false
    })
    .map((c) => ({
      header: c.header,
      cell: (id) => {
        const readings = memory.get(id)
        const bytes = readings && c.read(readings)
        return bytes === undefined ? undefined : formatBytes(bytes)
      },
    }))
}

/** The document's `compared` rows, each with its `Comparison` (absent on a
 * one-sided task). A document compared before `compared` existed gets rows
 * rebuilt from `comparisons` and `unmatched`: no sample counts or memory,
 * the base median derived from the change, base-only tasks named by id. */
export function comparedRows(
  doc: ProfileDocument,
): { row: ComparedTask; cmp: Comparison | undefined }[] {
  // Most documents were never compared: skip building the lookups.
  if (!doc.compared && !doc.comparisons?.length && !doc.unmatched) return []
  const byId = new Map((doc.comparisons ?? []).map((c) => [c.id, c]))
  const rows = doc.compared ?? rebuildCompared(doc)
  return rows.map((row) => ({
    row,
    cmp:
      row.comparisonId === undefined ? undefined : byId.get(row.comparisonId),
  }))
}

function rebuildCompared(doc: ProfileDocument): ComparedTask[] {
  const resolve = comparisonResolver(doc)
  const workloads = workloadsById(doc)
  const oneSided = (
    id: string,
    verdict: "missing-base" | "missing-cand",
  ): ComparedTask => {
    const w = workloads.get(id)
    return {
      workloadId: id,
      task: labelOrId(w, id),
      ...(w?.entry?.group !== undefined && { group: w.entry.group }),
      verdict,
    }
  }
  return [
    ...(doc.comparisons ?? []).map((cmp): ComparedTask => {
      const { run, workload, workloadId } = resolve(cmp)
      const row: ComparedTask = {
        workloadId,
        task: workload ? workloadLabel(workload) : workloadId,
        ...(workload?.entry?.group !== undefined && {
          group: workload.entry.group,
        }),
        verdict: cmp.timing?.verdict ?? "unchanged",
        comparisonId: cmp.id,
        pass: cmp.verdict === "pass",
      }
      if (cmp.timing && run?.timing) {
        const { medianDeltaPct, ci95, pValue } = cmp.timing
        row.timing = {
          unit: "ns",
          baseMedian: run.timing.median / (1 + medianDeltaPct / 100),
          candMedian: run.timing.median,
          candSamples: run.timing.samples.length,
          medianDeltaPct,
          ...(ci95 && { ci95 }),
          ...(pValue !== undefined && { pValue }),
          thresholdPct: cmp.thresholds.effectiveTimingPct,
        }
      }
      return row
    }),
    ...(doc.unmatched?.candOnly ?? []).map((id) =>
      oneSided(id, "missing-base"),
    ),
    ...(doc.unmatched?.baseOnly ?? []).map((id) =>
      oneSided(id, "missing-cand"),
    ),
  ]
}

// Heap readings move with GC timing, so a small change is noise, not a line.
const MIN_MEMORY_DISPLAY_PCT = 10

const MEMORY_READING_LABELS: Record<MemoryDelta["reading"], string> = {
  heapUsedBefore: "heap used before",
  heapUsedAfter: "heap used after",
  retained: "retained/op",
  peak: "peak",
  maxRss: "max RSS",
}

/** `heap used before 12.00MiB → 16.80MiB (+40.0%)` for each memory reading
 * that moved at least 10%. */
export function shownMemoryDeltas(row: ComparedTask, arrow = "→"): string[] {
  return (row.memory ?? [])
    .filter((m) => !(Math.abs(m.deltaPct) < MIN_MEMORY_DISPLAY_PCT))
    .map(
      (m) =>
        `${MEMORY_READING_LABELS[m.reading]} ${formatBytes(m.baseBytes)} ${arrow} ${formatBytes(m.candBytes)} (${Number.isFinite(m.deltaPct) ? formatSignedPct(m.deltaPct) : "new"})`,
    )
}

/** `Timing threshold 5.0%, widened to 17.3% by machine noise and drift
 * (12.3%)`, when noise or drift widened it; else undefined. */
export function thresholdNote(doc: ProfileDocument): string | undefined {
  const summary = doc.comparisonSummary
  const base = doc.comparisons?.[0]?.thresholds.timingPct
  if (!summary || base === undefined) return undefined
  if (!(summary.effectiveTimingPct > base)) return undefined
  const drift =
    summary.driftPct !== undefined && summary.driftPct > 0
      ? ` and drift (${summary.driftPct.toFixed(1)}%); \`ostia ab\` alternates base and candidate in one process, so drift can't favor either`
      : ""
  return `Timing threshold ${base.toFixed(1)}%, widened to ${summary.effectiveTimingPct.toFixed(1)}% by machine noise${drift}`
}

/** "base only" / "candidate only", and what that usually means. */
export function oneSidedNote(verdict: "missing-base" | "missing-cand"): string {
  return verdict === "missing-base"
    ? "candidate only (new, or renamed without `aliases`)"
    : "base only (removed, or renamed without `aliases`)"
}
