import type {
  Comparison,
  Measurement,
  ProfileDocument,
  Workload,
} from "../../ir/types.ts"
import { relativeReferences } from "../relative.ts"
import type { Renderer, RenderResult } from "../types.ts"

/** One JSON object per timing run, nothing else: no header, no raw sample
 * array, no prose. Built for piping into an LLM agent's context, where the full
 * `ProfileDocument` (tens of thousands of samples per fast task) is mostly
 * tokens a reviewer never reads. Numbers stay in the IR's unit (ns) so they
 * line up with `compare` deltas and the JSON document without conversion. */
export interface MinimalLine {
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
  warnings: { code: string; data?: Record<string, unknown> }[]
  /** From `comparisons` when present (ostia compare / ci): the change against
   * the baseline document for this task. */
  delta?: {
    medianPct: number
    meanPct: number
    verdict: "improved" | "regressed" | "unchanged"
    pass: boolean
    /** 95% bootstrap CI on the difference of medians and the Mann-Whitney
     * p-value behind the verdict. Absent on a thin (<5 samples/side)
     * comparison, which falls back to a point-estimate threshold. */
    ci95?: [number, number]
    pValue?: number
  }
}

function sig(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(6)) : n
}

function taskLabel(w: Workload | undefined, run: Measurement): string {
  return w?.entry?.task ?? w?.label ?? w?.command?.join(" ") ?? run.workloadId
}

/** Copies the workload's descriptive fields onto `line`, only when set, so
 * the JSON line stays free of `undefined`-valued keys. */
function addWorkloadFields(line: MinimalLine, w: Workload | undefined): void {
  if (w?.entry?.group !== undefined) line.group = w.entry.group
  if (w?.description !== undefined) line.description = w.description
  if (w?.groupDescription !== undefined)
    line.groupDescription = w.groupDescription
  if (w?.params !== undefined) line.params = w.params
}

function deltaFrom(cmp: Comparison | undefined): MinimalLine["delta"] {
  if (!cmp?.timing) return undefined
  const delta: NonNullable<MinimalLine["delta"]> = {
    medianPct: sig(cmp.timing.medianDeltaPct),
    meanPct: sig(cmp.timing.meanDeltaPct),
    verdict: cmp.timing.verdict,
    pass: cmp.verdict === "pass",
  }
  if (cmp.timing.ci95) {
    delta.ci95 = [sig(cmp.timing.ci95[0]), sig(cmp.timing.ci95[1])]
  }
  if (cmp.timing.pValue !== undefined) delta.pValue = sig(cmp.timing.pValue)
  return delta
}

function skippedLine(
  workload: Workload,
  cmp: Comparison | undefined,
): MinimalLine {
  const line: MinimalLine = {
    task: workload.entry?.task ?? workload.label ?? workload.id,
    skipped: true,
    warnings: [],
  }
  addWorkloadFields(line, workload)
  const delta = deltaFrom(cmp)
  if (delta) line.delta = delta
  return line
}

function minimalLines(doc: ProfileDocument): MinimalLine[] {
  const byWorkload = new Map(doc.workloads.map((w) => [w.id, w]))
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
    .map((w) => skippedLine(w, comparisonByRun.get(w.id)))

  const measuredLines = rows.map((row) => {
    const { run, workload } = row
    const t = run.timing
    const line: MinimalLine = {
      task: taskLabel(workload, run),
      unit: "ns",
      samples: t.samples.length,
      mean: sig(t.mean),
      median: sig(t.median),
      stddev: sig(t.stddev),
      stddevPct: sig(t.mean === 0 ? 0 : (t.stddev / t.mean) * 100),
      min: sig(t.min),
      max: sig(t.max),
      warnings: [
        ...run.warnings,
        ...(cpuWarningsByWorkloadId.get(run.workloadId) ?? []),
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
    const delta = deltaFrom(comparisonByRun.get(run.id))
    if (delta) line.delta = delta
    return line
  })

  return [...measuredLines, ...skippedLines]
}

export const minimalRenderer: Renderer<Record<string, never>> = {
  name: "minimal",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const lines = minimalLines(doc).map((l) => JSON.stringify(l))
    return { text: lines.length > 0 ? `${lines.join("\n")}\n` : "" }
  },
}
