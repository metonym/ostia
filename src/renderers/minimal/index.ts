import type { Measurement, ProfileDocument, Workload } from "../../ir/types.ts"
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
  unit: "ns"
  samples: number
  mean: number
  median: number
  stddev: number
  stddevPct: number
  min: number
  max: number
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
  }
}

function sig(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(6)) : n
}

function taskLabel(w: Workload | undefined, run: Measurement): string {
  return w?.entry?.task ?? w?.label ?? w?.command?.join(" ") ?? run.workloadId
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

  return rows.map((row) => {
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
      warnings: run.warnings.map((w) =>
        w.data ? { code: w.code, data: w.data } : { code: w.code },
      ),
    }
    if (t.p75 !== undefined) line.p75 = sig(t.p75)
    if (t.p99 !== undefined) line.p99 = sig(t.p99)
    if (t.mad !== undefined) line.mad = sig(t.mad)
    if (workload?.entry?.group !== undefined) line.group = workload.entry.group
    if (workload?.description !== undefined)
      line.description = workload.description
    if (workload?.groupDescription !== undefined)
      line.groupDescription = workload.groupDescription
    if (refs) line.relative = sig(t.median / (refs.get(row) ?? t.median))
    if (workload?.baseline) line.baseline = true
    const cmp = comparisonByRun.get(run.id)
    if (cmp?.timing) {
      line.delta = {
        medianPct: sig(cmp.timing.medianDeltaPct),
        meanPct: sig(cmp.timing.meanDeltaPct),
        verdict: cmp.timing.verdict,
        pass: cmp.verdict === "pass",
      }
    }
    return line
  })
}

export const minimalRenderer: Renderer<Record<string, never>> = {
  name: "minimal",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const lines = minimalLines(doc).map((l) => JSON.stringify(l))
    return { text: lines.length > 0 ? `${lines.join("\n")}\n` : "" }
  },
}
