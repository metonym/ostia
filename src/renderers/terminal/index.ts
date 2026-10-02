import { formatDuration, pickDurationUnit } from "../../format.ts"
import { cpuSampleCount } from "../../ir/cpu.ts"
import type {
  AbSummary,
  ProfileDocument,
  Warning,
  Workload,
} from "../../ir/types.ts"
import {
  cpuTimes,
  formatCpuTimes,
  formatEnvironmentLine,
  formatHeapSummary,
  formatNsAsMs,
  formatRelative,
  formatSignedPct,
  formatSpan,
  formatUsAsMs,
  labelOrId,
  topSelfFrames,
  workloadLabel,
} from "../format.ts"
import {
  abNotes,
  formatAbHeader,
  formatAbSummary,
  pairedCells,
  pairedRuns,
} from "../paired.ts"
import { groupOf, relativeRatios, type TimingRow } from "../relative.ts"
import {
  comparisonResolver,
  environmentMismatch,
  memoryColumns,
  memoryReadings,
  noSampleRuns,
  rowComparisonWarnings,
  runWarnings,
  shownFrameDeltas,
  shownHeapDeltas,
  skippedWorkloads,
  timingRuns,
  workloadsById,
} from "../select.ts"
import type { Renderer, RenderResult } from "../types.ts"

const TOP_FRAMES = 5
const TOP_TYPES = 5
const MIN_MEMORY_WIDTH = 10

interface Column<R> {
  header: string
  width: number
  cell: (data: R) => string
}

interface TableRow<R> {
  label: string
  group?: string
  /** Absent when there is nothing to tabulate; `status` says why. */
  data?: R
  /** The row's text when `data` is absent: `skipped` or `no samples`. */
  status?: string
  warnings: Warning[]
}

function textTable<R>(columns: Column<R>[], rows: TableRow<R>[]): string[] {
  const indentOf = (row: TableRow<R>) => (row.group !== undefined ? "  " : "")
  let labelWidth = 4
  for (const r of rows) {
    labelWidth = Math.max(labelWidth, indentOf(r).length + r.label.length)
  }
  const header = `${"Task".padEnd(labelWidth)}   ${columns.map((c) => c.header.padEnd(c.width)).join(" ")}`
  const lines = [header, "-".repeat(header.length)]
  let lastGroup: string | undefined
  for (const row of rows) {
    if (row.group !== undefined && row.group !== lastGroup) {
      lines.push(`${row.group}:`)
    }
    lastGroup = row.group
    const indent = indentOf(row)
    const label = (indent + row.label).padEnd(labelWidth)
    const data = row.data
    lines.push(
      data === undefined
        ? `${label}   - ${row.status}`
        : `${label}   ${columns.map((c) => c.cell(data).padEnd(c.width)).join(" ")}`,
    )
    if (row.warnings.length > 0) {
      lines.push(`${indent}  ! ${row.warnings.map((w) => w.code).join(", ")}`)
    }
  }
  return lines
}

function warningFootnotes(rows: TableRow<unknown>[]): string[] {
  const lines = rows.flatMap((row) =>
    row.warnings.map((w) => `  ${row.label}: ${w.message}`),
  )
  return lines.length > 0 ? ["", "Warnings:", ...lines] : []
}

function finish(lines: string[]): RenderResult {
  return { text: `${lines.map((l) => l.trimEnd()).join("\n")}\n` }
}

export const terminalRenderer: Renderer = {
  name: "table",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const env = doc.environment
      ? [formatEnvironmentLine(doc.environment), ""]
      : []

    // Only `ab()` writes paired measurements, and it always stamps `ab`.
    if (doc.ab) return finish(renderPaired(doc, doc.ab, env))

    const runs = timingRuns(doc)
    const empty = noSampleRuns(doc)
    const comparisons = renderComparisons(doc)
    if (
      runs.length === 0 &&
      empty.length === 0 &&
      skippedWorkloads(doc, runs).length === 0
    ) {
      return comparisons.length > 0
        ? finish([...env, ...comparisons])
        : { text: "(no timing runs)\n" }
    }

    const lines = [...env, ...renderTiming(doc, runs, empty)]
    const instrumented = renderInstrumentedRuns(doc)
    if (instrumented.length > 0) lines.push("", ...instrumented)
    if (comparisons.length > 0) lines.push("", ...comparisons)
    return finish(lines)
  },
}

function renderTiming(
  doc: ProfileDocument,
  runs: ReturnType<typeof timingRuns>,
  noSamples: ReturnType<typeof noSampleRuns>,
): string[] {
  const memory = memoryReadings(doc)
  const runByWorkloadId = new Map(runs.map((r) => [r.workloadId, r]))
  const noSampleByWorkloadId = new Map(noSamples.map((r) => [r.workloadId, r]))

  // doc.workloads order, so a skipped task prints in its group's place.
  const rows: TableRow<TimingRow>[] = []
  const measured: TimingRow[] = []
  for (const workload of doc.workloads) {
    const run = runByWorkloadId.get(workload.id)
    const label = workloadLabel(workload)
    const group = groupOf(workload)
    if (run) {
      const data = { run, workload }
      measured.push(data)
      rows.push({ label, group, data, warnings: runWarnings(run, memory) })
    } else if (noSampleByWorkloadId.has(workload.id)) {
      const warnings = runWarnings(
        noSampleByWorkloadId.get(workload.id)!,
        memory,
      )
      rows.push({ label, group, status: "no samples", warnings })
    } else if (workload.skipped) {
      rows.push({ label, group, status: "skipped", warnings: [] })
    }
  }

  const unitOf = ({ run }: TimingRow) => pickDurationUnit(run.timing.median)
  const cpuTimesByRow = new Map(measured.map((row) => [row, cpuTimes(row.run)]))
  const ratios = relativeRatios(measured)

  const columns: Column<TimingRow>[] = [
    {
      header: "Median",
      width: 10,
      cell: (row) => formatDuration(row.run.timing.median, unitOf(row)),
    },
    {
      header: "Spread",
      width: 18,
      cell: (row) =>
        formatSpan(row.run.timing.p75, row.run.timing.p99, unitOf(row)),
    },
    {
      header: "Range",
      width: 18,
      cell: (row) =>
        formatSpan(row.run.timing.min, row.run.timing.max, unitOf(row)),
    },
  ]
  if ([...cpuTimesByRow.values()].some(Boolean)) {
    columns.push({
      header: "User/Sys",
      width: 18,
      cell: (row) => {
        const times = cpuTimesByRow.get(row)
        return times ? formatCpuTimes(times) : ""
      },
    })
  }
  for (const col of memoryColumns(memory)) {
    columns.push({
      header: col.header,
      width: Math.max(col.header.length, MIN_MEMORY_WIDTH),
      cell: (row) => col.cell(row.run.workloadId) ?? "",
    })
  }
  if (ratios) {
    columns.push({
      header: "Relative",
      width: 8,
      cell: (row) => formatRelative(ratios.get(row)!, !!row.workload?.baseline),
    })
  }

  return [...textTable(columns, rows), ...warningFootnotes(rows)]
}

function renderPaired(
  doc: ProfileDocument,
  ab: AbSummary,
  env: string[],
): string[] {
  const byWorkload = workloadsById(doc)
  const lines = [...env, `A/B: ${formatAbHeader(ab)}`, ""]

  const rows: TableRow<ReturnType<typeof pairedCells>>[] = pairedRuns(doc).map(
    (run) => {
      const workload = byWorkload.get(run.workloadId)
      return {
        label: labelOrId(workload, run.workloadId),
        group: groupOf(workload),
        data: pairedCells(run),
        warnings: run.warnings,
      }
    },
  )
  if (rows.length > 0) {
    lines.push(
      ...textTable<ReturnType<typeof pairedCells>>(
        [
          { header: "Base", width: 10, cell: (c) => c.base },
          { header: "Candidate", width: 10, cell: (c) => c.candidate },
          { header: "Change", width: 9, cell: (c) => c.change },
          { header: "p25…p75", width: 18, cell: (c) => c.spread },
          { header: "Verdict", width: 7, cell: (c) => c.verdict },
        ],
        rows,
      ),
    )
  }

  const notes = abNotes(doc)
  if (notes.outputDiffers.length > 0) {
    lines.push(
      "",
      `Output differs from the base (${notes.outputDiffers.length}):`,
      ...notes.outputDiffers.map((label) => `  ${label}`),
    )
  }
  if (notes.baseOnly.length > 0 || notes.candOnly.length > 0) {
    lines.push("", "Unmatched:")
    if (notes.baseOnly.length > 0)
      lines.push(`  base only: ${notes.baseOnly.join(", ")}`)
    if (notes.candOnly.length > 0)
      lines.push(`  candidate only: ${notes.candOnly.join(", ")}`)
  }

  lines.push(...warningFootnotes(rows), "", formatAbSummary(ab))
  return lines
}

function renderComparisons(doc: ProfileDocument): string[] {
  if (!doc.comparisons || doc.comparisons.length === 0) return []
  const lines: string[] = []
  const resolve = comparisonResolver(doc)

  const mismatch = environmentMismatch(doc)
  if (mismatch) lines.push(`⚠ ${mismatch.message}`, "")

  const footnotes: string[] = []

  for (const cmp of doc.comparisons) {
    const { workload, workloadId } = resolve(cmp)
    const label = labelOrId(workload, workloadId)
    lines.push(`${cmp.verdict === "pass" ? "✓" : "✗"} ${label}`)

    if (cmp.timing) {
      const { medianDeltaPct, ci95, pValue, verdict } = cmp.timing
      if (ci95 && pValue !== undefined) {
        const p = pValue < 0.001 ? "p<0.001" : `p=${pValue.toFixed(3)}`
        lines.push(
          `  timing: ${formatSignedPct(medianDeltaPct)} median, 95% CI [${formatSignedPct(ci95[0])}, ${formatSignedPct(ci95[1])}], ${p} (${verdict})`,
        )
      } else {
        lines.push(
          `  timing: ${formatSignedPct(medianDeltaPct)} median (${verdict})`,
        )
      }
    }
    for (const f of shownFrameDeltas(cmp, TOP_FRAMES)) {
      lines.push(
        `  frame ${f.name}: ${formatSignedPct(f.deltaPct)} self-time (${formatUsAsMs(f.baseSelfUs)}ms -> ${formatUsAsMs(f.candSelfUs)}ms)`,
      )
    }
    for (const h of shownHeapDeltas(cmp, TOP_TYPES)) {
      lines.push(
        `  heap ${h.type}: ${formatSignedPct(h.deltaPct)} count (${h.baseCount} -> ${h.candCount})`,
      )
    }

    const warnings = rowComparisonWarnings(cmp)
    if (warnings.length > 0) {
      lines.push(`  ! ${warnings.map((w) => w.code).join(", ")}`)
      for (const w of warnings) footnotes.push(`  ${label}: ${w.message}`)
    }
  }

  if (footnotes.length > 0) lines.push("", "Comparison warnings:", ...footnotes)
  return lines
}

function renderInstrumentedRuns(doc: ProfileDocument): string[] {
  const byWorkload: Map<string, Workload> = workloadsById(doc)
  const lines: string[] = []

  for (const run of doc.measurements) {
    if (run.phase !== "cpu" && run.phase !== "heap") continue
    const workload = byWorkload.get(run.workloadId)
    const label = labelOrId(workload, run.workloadId)

    if (run.phase === "cpu") {
      if (run.cpu) {
        lines.push(
          `CPU capture - ${label} (instrumented, ${run.cpu.samplingIntervalUs}µs interval, ${cpuSampleCount(run.cpu)} samples, diagnostic wall ${formatNsAsMs(run.diagnosticWallNs ?? 0)}ms)`,
        )
        for (const f of topSelfFrames(run.cpu, TOP_FRAMES)) {
          lines.push(
            `  ${f.pct.padStart(5)}%  ${formatUsAsMs(f.selfUs).padStart(8)}ms self  ${f.frame?.name ?? "?"}`,
          )
        }
      } else {
        lines.push(
          `CPU capture - ${label} (instrumented, no evidence captured)`,
        )
      }
    } else if (run.heap) {
      lines.push(
        `Heap snapshot - ${label} (instrumented, ${formatHeapSummary(run.heap)})`,
      )
      for (const tc of run.heap.typeCounts.slice(0, TOP_TYPES)) {
        lines.push(`  ${String(tc.count).padStart(6)}  ${tc.type}`)
      }
    } else {
      lines.push(
        `Heap snapshot - ${label} (instrumented, no evidence captured)`,
      )
    }

    for (const a of run.artifacts) lines.push(`  artifact: ${a.path}`)
    for (const w of run.warnings) lines.push(`  ! ${w.message}`)
  }

  return lines
}
