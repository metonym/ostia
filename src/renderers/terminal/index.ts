import type { Measurement, ProfileDocument, Workload } from "../../ir/types.ts"
import {
  formatDuration,
  formatEnvironmentLine,
  pickDurationUnit,
} from "../format.ts"
import { relativeReferences } from "../relative.ts"
import type { Renderer, RenderResult } from "../types.ts"

function fmtMs(ns: number): string {
  return (ns / 1e6).toFixed(3)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}

function commandLabel(w: Workload): string {
  return w.label ?? w.command?.join(" ") ?? w.entry?.task ?? w.id
}

/** Prefers the explicit `entry.group` the bench runner records over
 * splitting the "group/name" id, so task names may themselves contain "/". */
function groupOf(workload: Workload | undefined): string | undefined {
  if (!workload?.entry) return undefined
  if (workload.entry.group !== undefined) return workload.entry.group
  const id = workload.entry.task
  const idx = id.lastIndexOf("/")
  return idx === -1 ? undefined : id.slice(0, idx)
}

interface TimingRow {
  run: Measurement & { timing: NonNullable<Measurement["timing"]> }
  workload: Workload | undefined
  label: string
}

interface SkippedRow {
  workload: Workload
  label: string
}

type TableRow =
  | ({ kind: "measured" } & TimingRow)
  | ({ kind: "skipped" } & SkippedRow)

export const terminalRenderer: Renderer<Record<string, never>> = {
  name: "table",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const timingRuns = doc.measurements.filter(
      (r): r is Measurement & { timing: NonNullable<Measurement["timing"]> } =>
        r.phase === "timing" && r.timing !== undefined,
    )
    const byWorkload = new Map(doc.workloads.map((w) => [w.id, w]))

    const envLine = doc.environment
      ? [formatEnvironmentLine(doc.environment), ""]
      : []

    const skippedWorkloads = doc.workloads.filter(
      (w) => w.skipped && !timingRuns.some((r) => r.workloadId === w.id),
    )
    if (timingRuns.length === 0 && skippedWorkloads.length === 0) {
      const comparisonLines = renderComparisons(doc, byWorkload)
      return {
        text:
          comparisonLines.length > 0
            ? `${[...envLine, ...comparisonLines].join("\n")}\n`
            : "(no timing runs)\n",
      }
    }

    // Ordered by doc.workloads (registration order), a measured row where a
    // timing measurement exists, else a skipped row for a task.skip()'d
    // workload, so a skipped task prints in its natural place in its group.
    const measurementByWorkloadId = new Map(
      timingRuns.map((r) => [r.workloadId, r]),
    )
    const rows: TableRow[] = []
    for (const workload of doc.workloads) {
      const run = measurementByWorkloadId.get(workload.id)
      if (run) {
        rows.push({
          kind: "measured",
          run,
          workload,
          label: commandLabel(workload),
        })
      } else if (workload.skipped) {
        rows.push({ kind: "skipped", workload, label: commandLabel(workload) })
      }
    }
    const measuredRows = rows.filter(
      (r): r is { kind: "measured" } & TimingRow => r.kind === "measured",
    )

    const allocByWorkloadId = new Map(
      doc.measurements
        .filter(
          (m): m is Measurement & { memory: { bytesPerOp: number } } =>
            m.phase === "memstats" && m.memory?.bytesPerOp !== undefined,
        )
        .map((m) => [m.workloadId, m.memory.bytesPerOp]),
    )
    const showAlloc = allocByWorkloadId.size > 0

    const showRelative = measuredRows.length > 1
    // Grouped tasks get their own Relative baseline (see relative.ts);
    // ungrouped tasks fall back to the whole-run fastest.
    const references = relativeReferences(measuredRows)

    // Group rows visually: a row's group header prints once, right before
    // its first row, and its rows indent under it. Ungrouped rows (and
    // subprocess commands, which never carry entry.group) print flat.
    const indents = new Map<TableRow, string>()
    const groupHeaderBefore = new Map<TableRow, string>()
    let lastGroup: string | undefined
    for (const row of rows) {
      const group = groupOf(row.workload)
      if (group !== lastGroup) {
        if (group !== undefined) groupHeaderBefore.set(row, group)
        lastGroup = group
      }
      indents.set(row, group !== undefined ? "  " : "")
    }

    const labelWidth = Math.max(
      4,
      ...rows.map((r) => indents.get(r)!.length + r.label.length),
    )
    const medianWidth = 10
    const spreadWidth = 18
    const rangeWidth = 18
    const allocWidth = 10

    const lines: string[] = [...envLine]
    const allocHeader = showAlloc ? ` ${"Alloc/op".padEnd(allocWidth)}` : ""
    const header = `${"Task".padEnd(labelWidth)}   ${"Median".padEnd(medianWidth)} ${"Spread".padEnd(spreadWidth)} ${"Range".padEnd(rangeWidth)}${allocHeader}${showRelative ? " Relative" : ""}`
    lines.push(header)
    lines.push("-".repeat(header.length))

    const rowsWithWarnings: ({ kind: "measured" } & TimingRow)[] = []

    for (const row of rows) {
      const groupHeader = groupHeaderBefore.get(row)
      if (groupHeader !== undefined) lines.push(`${groupHeader}:`)
      const indent = indents.get(row)!

      if (row.kind === "skipped") {
        lines.push(`${(indent + row.label).padEnd(labelWidth)}   - skipped`)
        continue
      }

      const { run, label, workload } = row
      const t = run.timing
      const unit = pickDurationUnit(t.median)
      // p75/p99 are absent only on documents saved before this field existed;
      // fall back to the range so an old baseline still renders sensibly.
      const p75 = t.p75 ?? t.median
      const p99 = t.p99 ?? t.max
      const medianCell = formatDuration(t.median, unit)
      const spreadCell = `${formatDuration(p75, unit)}…${formatDuration(p99, unit)}`
      const rangeCell = `${formatDuration(t.min, unit)}…${formatDuration(t.max, unit)}`

      let line = `${(indent + label).padEnd(labelWidth)}   ${medianCell.padEnd(medianWidth)} ${spreadCell.padEnd(spreadWidth)} ${rangeCell.padEnd(rangeWidth)}`
      if (showAlloc) {
        const bytesPerOp = workload
          ? allocByWorkloadId.get(workload.id)
          : undefined
        const allocCell =
          bytesPerOp !== undefined ? formatBytes(bytesPerOp) : ""
        line += ` ${allocCell.padEnd(allocWidth)}`
      }
      if (showRelative) {
        const relative = t.median / (references.get(row) ?? t.median)
        if (relative === 1) {
          line += workload?.baseline ? " 1.00× (baseline)" : " 1.00×"
        } else if (relative > 1) {
          line += ` ${relative.toFixed(2)}× slower`
        } else {
          line += ` ${(1 / relative).toFixed(2)}× faster`
        }
      }
      lines.push(line)
      if (run.warnings.length > 0) {
        lines.push(
          `${" ".repeat(indent.length)}  ! ${run.warnings.map((w) => w.code).join(", ")}`,
        )
        rowsWithWarnings.push(row)
      }
    }

    if (rowsWithWarnings.length > 0) {
      lines.push("")
      lines.push("Warnings:")
      for (const row of rowsWithWarnings) {
        for (const w of row.run.warnings) {
          lines.push(`  ${row.label}: ${w.message}`)
        }
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

    return { text: `${lines.map((l) => l.trimEnd()).join("\n")}\n` }
  },
}

function runLabelFor(
  doc: ProfileDocument,
  byWorkload: Map<string, Workload>,
  measurementId: string,
): string {
  const run = doc.measurements.find((r) => r.id === measurementId)
  // A skipped candidate has no measurement, so `compareWorkload` falls back
  // to the workload's own id for `candidateMeasurementId` - resolve that too.
  const workload = run
    ? byWorkload.get(run.workloadId)
    : byWorkload.get(measurementId)
  return workload ? commandLabel(workload) : measurementId
}

function renderComparisons(
  doc: ProfileDocument,
  byWorkload: Map<string, Workload>,
): string[] {
  if (!doc.comparisons || doc.comparisons.length === 0) return []
  const lines: string[] = []

  for (const cmp of doc.comparisons) {
    const label = runLabelFor(doc, byWorkload, cmp.candidateMeasurementId)
    const verdictMark = cmp.verdict === "pass" ? "✓" : "✗"
    lines.push(`${verdictMark} ${label}`)

    if (cmp.timing) {
      const withSign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`
      if (cmp.timing.ci95 && cmp.timing.pValue !== undefined) {
        const p =
          cmp.timing.pValue < 0.001
            ? "p<0.001"
            : `p=${cmp.timing.pValue.toFixed(3)}`
        lines.push(
          `  timing: ${withSign(cmp.timing.medianDeltaPct)} median, 95% CI [${withSign(cmp.timing.ci95[0])}, ${withSign(cmp.timing.ci95[1])}], ${p} (${cmp.timing.verdict})`,
        )
      } else {
        lines.push(
          `  timing: ${withSign(cmp.timing.medianDeltaPct)} median (${cmp.timing.verdict})`,
        )
      }
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

  for (const run of doc.measurements) {
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
