import type { Measurement, ProfileDocument, Workload } from "../../ir/types.ts"
import {
  cpuSampleCount,
  cpuTimes,
  formatBytes,
  formatCpuTimes,
  formatDuration,
  formatEnvironmentLine,
  formatRelative,
  MIN_DISPLAY_DELTA_PCT,
  pickDurationUnit,
  workloadLabel,
} from "../format.ts"
import {
  abNotes,
  formatAbHeader,
  formatAbSummary,
  formatRatio,
  type PairedRun,
  pairedRuns,
  pairedVerdict,
} from "../paired.ts"
import { groupOf, relativeReferences } from "../relative.ts"
import {
  environmentMismatch,
  memoryReadings,
  skippedWorkloads,
  timingRuns,
} from "../select.ts"
import type { Renderer, RenderResult } from "../types.ts"

function fmtMs(ns: number): string {
  return (ns / 1e6).toFixed(3)
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
    const runs = timingRuns(doc)
    const byWorkload = new Map(doc.workloads.map((w) => [w.id, w]))

    const envLine = doc.environment
      ? [formatEnvironmentLine(doc.environment), ""]
      : []

    const paired = pairedRuns(doc)
    if (paired.length > 0 || doc.ab) {
      return { text: renderPaired(doc, paired, envLine) }
    }

    const skipped = skippedWorkloads(doc, runs)
    if (runs.length === 0 && skipped.length === 0) {
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
    const measurementByWorkloadId = new Map(runs.map((r) => [r.workloadId, r]))
    const rows: TableRow[] = []
    const measuredRows: ({ kind: "measured" } & TimingRow)[] = []
    for (const workload of doc.workloads) {
      const run = measurementByWorkloadId.get(workload.id)
      const label = workloadLabel(workload)
      if (run) {
        const row = { kind: "measured" as const, run, workload, label }
        rows.push(row)
        measuredRows.push(row)
      } else if (workload.skipped) {
        rows.push({ kind: "skipped", workload, label })
      }
    }

    const memory = memoryReadings(doc)
    const showAlloc = [...memory.values()].some((r) => r.retained !== undefined)
    const showPeak = [...memory.values()].some((r) => r.peak !== undefined)
    const rowWarnings = (run: Measurement) => [
      ...run.warnings,
      ...(memory.get(run.workloadId)?.warnings ?? []),
    ]
    const cpuTimesByRow = new Map(
      measuredRows.map((row) => [row, cpuTimes(row.run)]),
    )
    const showCpuTimes = [...cpuTimesByRow.values()].some(Boolean)

    const showRelative = measuredRows.length > 1
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
    const allocWidth = 11
    const peakWidth = 10
    const cpuTimesWidth = 18

    const lines: string[] = [...envLine]
    const allocHeader = showAlloc ? ` ${"Retained/op".padEnd(allocWidth)}` : ""
    const peakHeader = showPeak ? ` ${"Peak mem".padEnd(peakWidth)}` : ""
    const cpuTimesHeader = showCpuTimes
      ? ` ${"User/Sys".padEnd(cpuTimesWidth)}`
      : ""
    const header = `${"Task".padEnd(labelWidth)}   ${"Median".padEnd(medianWidth)} ${"Spread".padEnd(spreadWidth)} ${"Range".padEnd(rangeWidth)}${cpuTimesHeader}${allocHeader}${peakHeader}${showRelative ? " Relative" : ""}`
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
      const medianCell = formatDuration(t.median, unit)
      const spreadCell = `${formatDuration(t.p75, unit)}…${formatDuration(t.p99, unit)}`
      const rangeCell = `${formatDuration(t.min, unit)}…${formatDuration(t.max, unit)}`

      let line = `${(indent + label).padEnd(labelWidth)}   ${medianCell.padEnd(medianWidth)} ${spreadCell.padEnd(spreadWidth)} ${rangeCell.padEnd(rangeWidth)}`
      if (showCpuTimes) {
        const times = cpuTimesByRow.get(row)
        line += ` ${(times ? formatCpuTimes(times) : "").padEnd(cpuTimesWidth)}`
      }
      const readings = workload ? memory.get(workload.id) : undefined
      if (showAlloc) {
        const retained = readings?.retained
        const allocCell = retained !== undefined ? formatBytes(retained) : ""
        line += ` ${allocCell.padEnd(allocWidth)}`
      }
      if (showPeak) {
        const peak = readings?.peak
        const peakCell = peak !== undefined ? formatBytes(peak) : ""
        line += ` ${peakCell.padEnd(peakWidth)}`
      }
      if (showRelative) {
        const relative = t.median / (references.get(row) ?? t.median)
        line += ` ${formatRelative(relative, !!workload?.baseline)}`
      }
      lines.push(line)
      const warnings = rowWarnings(run)
      if (warnings.length > 0) {
        lines.push(
          `${" ".repeat(indent.length)}  ! ${warnings.map((w) => w.code).join(", ")}`,
        )
        rowsWithWarnings.push(row)
      }
    }

    if (rowsWithWarnings.length > 0) {
      lines.push("")
      lines.push("Warnings:")
      for (const row of rowsWithWarnings) {
        for (const w of rowWarnings(row.run)) {
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

/** An `ab()` document: one row per paired workload, base and candidate side
 * by side, then what differed and the run's verdict. */
function renderPaired(
  doc: ProfileDocument,
  runs: PairedRun[],
  envLine: string[],
): string {
  const byWorkload = new Map(doc.workloads.map((w) => [w.id, w]))
  const lines = [...envLine]
  if (doc.ab) lines.push(`A/B: ${formatAbHeader(doc.ab)}`, "")

  const rows = runs.map((run) => {
    const workload = byWorkload.get(run.workloadId)
    const p = run.paired
    const unit = pickDurationUnit(Math.min(p.baseMedianNs, run.timing.median))
    return {
      run,
      group: groupOf(workload),
      label: workloadLabel(workload),
      cells: [
        formatDuration(p.baseMedianNs, unit),
        formatDuration(run.timing.median, unit),
        formatRatio(p.medianRatio),
        `${formatRatio(p.p25)}…${formatRatio(p.p75)}`,
      ],
      verdict: pairedVerdict(p),
    }
  })

  if (rows.length > 0) {
    const labelWidth = Math.max(
      4,
      ...rows.map((r) => (r.group !== undefined ? 2 : 0) + r.label.length),
    )
    const widths = [10, 10, 9, 18]
    const header = `${"Task".padEnd(labelWidth)}   ${["Base", "Candidate", "Change", "p25…p75"].map((h, i) => h.padEnd(widths[i]!)).join(" ")} Verdict`
    lines.push(header, "-".repeat(header.length))
    let lastGroup: string | undefined
    for (const row of rows) {
      if (row.group !== lastGroup && row.group !== undefined) {
        lines.push(`${row.group}:`)
      }
      lastGroup = row.group
      const indent = row.group !== undefined ? "  " : ""
      lines.push(
        `${(indent + row.label).padEnd(labelWidth)}   ${row.cells.map((c, i) => c.padEnd(widths[i]!)).join(" ")} ${row.verdict}`,
      )
      if (row.run.warnings.length > 0) {
        lines.push(
          `${indent}  ! ${row.run.warnings.map((w) => w.code).join(", ")}`,
        )
      }
    }
  }

  const notes = abNotes(doc)
  if (notes.outputDiffers.length > 0) {
    lines.push(
      "",
      `Output differs from the base (${notes.outputDiffers.length}):`,
    )
    for (const label of notes.outputDiffers) lines.push(`  ${label}`)
  }
  if (notes.baseOnly.length > 0 || notes.candOnly.length > 0) {
    lines.push("", "Unmatched:")
    if (notes.baseOnly.length > 0)
      lines.push(`  base only: ${notes.baseOnly.join(", ")}`)
    if (notes.candOnly.length > 0)
      lines.push(`  candidate only: ${notes.candOnly.join(", ")}`)
  }

  const warned = rows.filter((r) => r.run.warnings.length > 0)
  if (warned.length > 0) {
    lines.push("", "Warnings:")
    for (const row of warned) {
      for (const w of row.run.warnings)
        lines.push(`  ${row.label}: ${w.message}`)
    }
  }

  if (doc.ab) lines.push("", formatAbSummary(doc.ab))
  return `${lines.map((l) => l.trimEnd()).join("\n")}\n`
}

function renderComparisons(
  doc: ProfileDocument,
  byWorkload: Map<string, Workload>,
): string[] {
  if (!doc.comparisons || doc.comparisons.length === 0) return []
  const lines: string[] = []
  const byMeasurement = new Map(doc.measurements.map((m) => [m.id, m]))

  const mismatch = environmentMismatch(doc)
  if (mismatch) lines.push(`⚠ ${mismatch.message}`, "")

  const footnotes: { label: string; message: string }[] = []

  for (const cmp of doc.comparisons) {
    const run = byMeasurement.get(cmp.candidateMeasurementId)
    // A skipped candidate has no measurement, so `compareWorkload` falls back
    // to the workload's own id for `candidateMeasurementId` - resolve that too.
    const workload = byWorkload.get(
      run?.workloadId ?? cmp.candidateMeasurementId,
    )
    const label = workload
      ? workloadLabel(workload)
      : cmp.candidateMeasurementId
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
        if (Math.abs(f.deltaPct) < MIN_DISPLAY_DELTA_PCT) continue
        const sign = f.deltaPct > 0 ? "+" : ""
        lines.push(
          `  frame ${f.name}: ${sign}${f.deltaPct.toFixed(1)}% self-time (${(f.baseSelfUs / 1000).toFixed(2)}ms -> ${(f.candSelfUs / 1000).toFixed(2)}ms)`,
        )
      }
    }
    if (cmp.heapTypes) {
      for (const h of cmp.heapTypes.slice(0, TOP_TYPES)) {
        if (Math.abs(h.deltaPct) < MIN_DISPLAY_DELTA_PCT) continue
        const sign = h.deltaPct > 0 ? "+" : ""
        lines.push(
          `  heap ${h.type}: ${sign}${h.deltaPct.toFixed(1)}% count (${h.baseCount} -> ${h.candCount})`,
        )
      }
    }

    const otherWarnings = (cmp.warnings ?? []).filter(
      (w) => w.code !== "environment-mismatch",
    )
    if (otherWarnings.length > 0) {
      lines.push(`  ! ${otherWarnings.map((w) => w.code).join(", ")}`)
      for (const w of otherWarnings)
        footnotes.push({ label, message: w.message })
    }
  }

  if (footnotes.length > 0) {
    lines.push("", "Comparison warnings:")
    for (const f of footnotes) lines.push(`  ${f.label}: ${f.message}`)
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
    const label = workload ? workloadLabel(workload) : run.workloadId

    if (run.phase === "cpu") {
      if (run.cpu) {
        lines.push(
          `CPU capture - ${label} (instrumented, ${run.cpu.samplingIntervalUs}µs interval, ${cpuSampleCount(run.cpu)} samples, diagnostic wall ${fmtMs(run.diagnosticWallNs ?? 0)}ms)`,
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
