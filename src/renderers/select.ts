import type {
  Measurement,
  ProfileDocument,
  Warning,
  Workload,
} from "../ir/types.ts"

export type TimingRun = Measurement & {
  timing: NonNullable<Measurement["timing"]>
}

/** The measurements a timing table is made of. */
export function timingRuns(doc: ProfileDocument): TimingRun[] {
  return doc.measurements.filter(
    (r): r is TimingRun => r.phase === "timing" && r.timing !== undefined,
  )
}

/** `task.skip()`'d workloads with no measurement to render, shown as their
 * own "- skipped" rows. */
export function skippedWorkloads(
  doc: ProfileDocument,
  runs: { workloadId: string }[],
): Workload[] {
  const measured = new Set(runs.map((r) => r.workloadId))
  return doc.workloads.filter((w) => w.skipped && !measured.has(w.id))
}

/** `environment-mismatch` is identical on every comparison in a document
 * (it's about the base/cand pair, not one workload): renderers print it
 * once, from here, and filter it out of per-row warnings. */
export function environmentMismatch(doc: ProfileDocument): Warning | undefined {
  for (const c of doc.comparisons ?? []) {
    const w = c.warnings?.find((w) => w.code === "environment-mismatch")
    if (w) return w
  }
  return undefined
}

export interface MemoryReadings {
  /** `--alloc`: heap each call retains, bytes. */
  retained?: number
  /** `--peak-mem`: peak-RSS rise of one call, bytes, or `"hidden"` when the
   * measurement ran but earlier work in its processes peaked higher. */
  peak?: number | "hidden"
  /** The `memstats` measurements' warnings (e.g. `peak-hidden`). */
  warnings: Warning[]
}

/** Each workload's `--alloc`/`--peak-mem` readings, for the memory columns
 * and warnings every document renderer shows next to its timing row. */
export function memoryReadings(
  doc: ProfileDocument,
): Map<string, MemoryReadings> {
  const byWorkload = new Map<string, MemoryReadings>()
  for (const m of doc.measurements) {
    if (m.phase !== "memstats" || !m.memory) continue
    const readings = byWorkload.get(m.workloadId) ?? { warnings: [] }
    if (m.memory.bytesPerOp !== undefined)
      readings.retained = m.memory.bytesPerOp
    if (m.memory.kind === "peak") readings.peak = m.memory.peakBytes ?? "hidden"
    readings.warnings.push(...m.warnings)
    byWorkload.set(m.workloadId, readings)
  }
  return byWorkload
}
