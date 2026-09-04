import type { ProfileDocument, Run, Workload } from "../../ir/types.ts"
import { relativeReferences } from "../relative.ts"
import type { Renderer, RenderResult } from "../types.ts"

function fmtMs(ns: number): string {
  return (ns / 1e6).toFixed(3)
}

function commandLabel(w: Workload): string {
  return w.label ?? w.command?.join(" ") ?? w.entry?.task ?? w.id
}

export const terminalRenderer: Renderer<Record<string, never>> = {
  name: "table",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const timingRuns = doc.runs.filter(
      (r): r is Run & { timing: NonNullable<Run["timing"]> } =>
        r.phase === "timing" && r.timing !== undefined,
    )
    const byWorkload = new Map(doc.workloads.map((w) => [w.id, w]))

    if (timingRuns.length === 0) {
      const comparisonLines = renderComparisons(doc, byWorkload)
      return {
        text:
          comparisonLines.length > 0
            ? `${comparisonLines.join("\n")}\n`
            : "(no timing runs)\n",
      }
    }
    const rows = timingRuns.map((run) => {
      const workload = byWorkload.get(run.workloadId)
      return {
        run,
        workload,
        label: workload ? commandLabel(workload) : run.workloadId,
      }
    })

    const showRelative = rows.length > 1
    // Grouped tasks get their own Relative baseline (see relative.ts);
    // ungrouped tasks fall back to the whole-run fastest.
    const references = relativeReferences(rows)

    const lines: string[] = []
    const labelWidth = Math.max(7, ...rows.map((r) => r.label.length))
    const header = showRelative
      ? `${"Command".padEnd(labelWidth)}   Mean [ms]        Min…Max [ms]        Relative`
      : `${"Command".padEnd(labelWidth)}   Mean [ms]        Min…Max [ms]`
    lines.push(header)
    lines.push("-".repeat(header.length))

    for (const row of rows) {
      const { run, label, workload } = row
      const t = run.timing
      const meanCell = `${fmtMs(t.mean)} ± ${fmtMs(t.stddev)}`
      const rangeCell = `${fmtMs(t.min)}…${fmtMs(t.max)}`
      let line = `${label.padEnd(labelWidth)}   ${meanCell.padEnd(15)}  ${rangeCell.padEnd(18)}`
      if (showRelative) {
        const relative = t.median / (references.get(row) ?? t.median)
        if (relative === 1) {
          line += workload?.baseline ? "  1.00× (baseline)" : "  1.00×"
        } else if (relative > 1) {
          line += `  ${relative.toFixed(2)}× slower`
        } else {
          line += `  ${(1 / relative).toFixed(2)}× faster`
        }
      }
      lines.push(line)
      for (const w of run.warnings) {
        lines.push(`  ! ${w.message}`)
      }
    }

    const instrumentedLines = renderInstrumentedRuns(doc, byWorkload)
    if (instrumentedLines.length > 0) {
      lines.push("")
      lines.push(...instrumentedLines)
    }

    const comparisonLines = renderComparisons(doc, byWorkload)
    if (comparisonLines.length > 0) {
      lines.push("")
      lines.push(...comparisonLines)
    }

    return { text: `${lines.join("\n")}\n` }
  },
}

function runLabelFor(
  doc: ProfileDocument,
  byWorkload: Map<string, Workload>,
  runId: string,
): string {
  const run = doc.runs.find((r) => r.id === runId)
  const workload = run ? byWorkload.get(run.workloadId) : undefined
  return workload ? commandLabel(workload) : runId
}

function renderComparisons(
  doc: ProfileDocument,
  byWorkload: Map<string, Workload>,
): string[] {
  if (!doc.comparisons || doc.comparisons.length === 0) return []
  const lines: string[] = []

  for (const cmp of doc.comparisons) {
    const label = runLabelFor(doc, byWorkload, cmp.candidateRunId)
    const verdictMark = cmp.verdict === "pass" ? "✓" : "✗"
    lines.push(`${verdictMark} ${label}`)

    if (cmp.timing) {
      const sign = cmp.timing.medianDeltaPct > 0 ? "+" : ""
      lines.push(
        `  timing: ${sign}${cmp.timing.medianDeltaPct.toFixed(1)}% median (${cmp.timing.verdict})`,
      )
    }
    if (cmp.frames) {
      for (const f of cmp.frames.slice(0, TOP_FRAMES)) {
        if (Math.abs(f.deltaPct) < 0.5) continue
        const sign = f.deltaPct > 0 ? "+" : ""
        lines.push(
          `  frame ${f.name}: ${sign}${f.deltaPct.toFixed(1)}% self-time (${(f.baseSelfUs / 1000).toFixed(2)}ms -> ${(f.candSelfUs / 1000).toFixed(2)}ms)`,
        )
      }
    }
    if (cmp.heapTypes) {
      for (const h of cmp.heapTypes.slice(0, TOP_TYPES)) {
        if (Math.abs(h.deltaPct) < 0.5) continue
        const sign = h.deltaPct > 0 ? "+" : ""
        lines.push(
          `  heap ${h.type}: ${sign}${h.deltaPct.toFixed(1)}% count (${h.baseCount} -> ${h.candCount})`,
        )
      }
    }
  }

  return lines
}

const TOP_FRAMES = 5
const TOP_TYPES = 5

function renderInstrumentedRuns(
  doc: ProfileDocument,
  byWorkload: Map<string, Workload>,
): string[] {
  const lines: string[] = []

  for (const run of doc.runs) {
    if (run.phase !== "cpu" && run.phase !== "heap") continue
    const workload = byWorkload.get(run.workloadId)
    const label = workload ? commandLabel(workload) : run.workloadId

    if (run.phase === "cpu") {
      if (run.cpu) {
        lines.push(
          `CPU capture - ${label} (instrumented, ${run.cpu.samplingIntervalUs}µs interval, diagnostic wall ${fmtMs(run.diagnosticWallNs ?? 0)}ms)`,
        )
        const totalUs = run.cpu.totals.reduce((s, t) => s + t.selfUs, 0) || 1
        for (const t of run.cpu.totals.slice(0, TOP_FRAMES)) {
          const frame = run.cpu.frames[t.frameIx]
          const pct = ((t.selfUs / totalUs) * 100).toFixed(1)
          lines.push(
            `  ${pct.padStart(5)}%  ${(t.selfUs / 1000).toFixed(2).padStart(8)}ms self  ${frame?.name ?? "?"}`,
          )
        }
      } else {
        lines.push(
          `CPU capture - ${label} (instrumented, no evidence captured)`,
        )
      }
    } else {
      if (run.heap) {
        const sizeMb = ((run.heap.heapSizeBytes ?? 0) / 1e6).toFixed(2)
        lines.push(
          `Heap snapshot - ${label} (instrumented, ${run.heap.objectCount ?? "?"} objects, ${sizeMb}MB)`,
        )
        for (const tc of run.heap.typeCounts.slice(0, TOP_TYPES)) {
          lines.push(`  ${String(tc.count).padStart(6)}  ${tc.type}`)
        }
      } else {
        lines.push(
          `Heap snapshot - ${label} (instrumented, no evidence captured)`,
        )
      }
    }

    for (const a of run.artifacts) lines.push(`  artifact: ${a.path}`)
    for (const w of run.warnings) lines.push(`  ! ${w.message}`)
  }

  return lines
}
