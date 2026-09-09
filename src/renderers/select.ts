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
