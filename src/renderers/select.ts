import type {
  Comparison,
  Measurement,
  ProfileDocument,
  Warning,
  Workload,
} from "../ir/types.ts"
import { formatBytes } from "./format.ts"

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
export function comparisonResolver(doc: ProfileDocument) {
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
