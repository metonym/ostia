import { formatDuration, pickDurationUnit } from "../../format.ts"
import { cpuSampleCount } from "../../ir/cpu.ts"
import type {
  Measurement,
  ProfileDocument,
  Warning,
  Workload,
} from "../../ir/types.ts"
import {
  cpuTimes,
  escapeMdCell,
  formatCpuTimes,
  formatEnvironmentLine,
  formatGit,
  formatHeapSummary,
  formatNsAsMs,
  formatRelative,
  formatSignedPct,
  formatSpan,
  formatUsAsMs,
  frameName,
  labelOrId,
  topSelfFrames,
} from "../format.ts"
import {
  abNotes,
  formatAbHeader,
  formatAbSummary,
  formatNewSuites,
  formatThrew,
  memoryCells,
  memoryRows,
  pairedCells,
  pairedRuns,
  threwRuns,
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

const TOP_FRAMES = 10
const TOP_TYPES = 10

type ParamValue = string | number | boolean

const cell = (v: ParamValue): string => escapeMdCell(String(v))

function mdTable(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ]
}

function paramsSuffix(w: Workload | undefined): string {
  if (!w?.params) return ""
  const pairs = Object.entries(w.params).map(([k, v]) => `${k}=${v}`)
  return ` (${pairs.join(", ")})`
}

function taskCell(w: Workload | undefined, id: string): string {
  return cell(labelOrId(w, id) + paramsSuffix(w))
}

function warningNote(w: Warning): string {
  return `${w.message} (\`${w.code}\`)`
}

function warningBullets(label: string, warnings: Warning[]): string[] {
  return warnings.map((w) => `- **${label}**: ${warningNote(w)}`)
}

/** The two param keys every workload shares, when each has exactly those two
 * (a `sweep()` over two dimensions): the shape a pivot table needs. */
function pivotKeysFor(
  workloads: (Workload | undefined)[],
): [string, string] | undefined {
  let keys: string[] | undefined
  for (const w of workloads) {
    const k = w?.params ? Object.keys(w.params) : undefined
    if (k?.length !== 2) return undefined
    if (keys === undefined) keys = k
    else if (k.some((kk, i) => kk !== keys![i])) return undefined
  }
  return keys as [string, string] | undefined
}

export const markdownRenderer: Renderer = {
  name: "markdown",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const byWorkload = workloadsById(doc)
    const gitSuffix = doc.git ? ` · ${formatGit(doc.git)}` : ""
    const mismatch = environmentMismatch(doc)

    const lines = [
      "# Profile Report",
      "",
      `Bun ${doc.bunVersion} · ostia ${doc.toolVersion} · ${doc.platform.os}/${doc.platform.arch} · ${doc.createdAt}${gitSuffix}`,
      "",
      ...(doc.environment ? [formatEnvironmentLine(doc.environment), ""] : []),
      ...(mismatch ? [`> ⚠ ${mismatch.message}`, ""] : []),
      // Only `ab()` writes paired measurements, and it always stamps `ab`.
      ...(doc.ab ? abSection(doc, doc.ab, byWorkload) : []),
      ...timingSection(doc, byWorkload),
      ...captureSections(doc, byWorkload),
      ...comparisonSection(doc),
    ]
    return { text: lines.join("\n") }
  },
}

function abSection(
  doc: ProfileDocument,
  ab: NonNullable<ProfileDocument["ab"]>,
  byWorkload: Map<string, Workload>,
): string[] {
  const paired = pairedRuns(doc)
  const lines = ["## A/B", "", formatAbHeader(ab), ""]
  if (paired.length > 0) {
    lines.push(
      ...mdTable(
        ["Task", "Base", "Candidate", "Change", "p25…p75", "Verdict"],
        paired.map((run) => {
          const c = pairedCells(run)
          return [
            taskCell(byWorkload.get(run.workloadId), run.workloadId),
            c.base,
            c.candidate,
            c.change,
            c.spread,
            c.verdict ? `**${cell(c.verdict)}**` : "",
          ]
        }),
      ),
      "",
    )
  }
  const memory = memoryRows(doc)
  if (memory.length > 0) {
    lines.push(
      ...mdTable(
        ["Task", "Memory", "Base", "Candidate", "Change", "Verdict"],
        memory.map((row) => {
          const c = memoryCells(row)
          return [
            taskCell(byWorkload.get(row.run.workloadId), row.run.workloadId),
            c.reading,
            c.base,
            c.candidate,
            c.change,
            c.verdict ? `**${c.verdict}**` : "",
          ]
        }),
      ),
      "",
    )
  }
  const threw = threwRuns(doc)
  if (threw.length > 0) {
    lines.push(`Threw (${threw.length}):`, "")
    for (const run of threw) {
      const message = run.threw.message.split("\n")[0]!.replaceAll("`", "'")
      lines.push(
        `- **${taskCell(byWorkload.get(run.workloadId), run.workloadId)}**: ${formatThrew(run.threw)}: \`${message}\``,
      )
    }
    lines.push("")
  }
  const notes = abNotes(doc)
  const listed = (title: string, labels: string[]) =>
    labels.length > 0 ? `${title}: ${labels.map(cell).join(", ")}` : undefined
  for (const note of [
    listed("Output differs from the base", notes.outputDiffers),
    formatNewSuites(ab),
    listed("Base only", notes.baseOnly),
    listed("Candidate only", notes.candOnly),
  ]) {
    if (note) lines.push(note, "")
  }
  const bullets = paired.flatMap((run) =>
    warningBullets(
      labelOrId(byWorkload.get(run.workloadId), run.workloadId),
      run.warnings,
    ),
  )
  if (bullets.length > 0) lines.push(...bullets, "")
  lines.push(`**${formatAbSummary(ab)}**`, "")
  return lines
}

function timingSection(
  doc: ProfileDocument,
  byWorkload: Map<string, Workload>,
): string[] {
  const runs = timingRuns(doc)
  const noSamples = noSampleRuns(doc)
  const memory = memoryReadings(doc)
  // Rows with nothing to tabulate: `task.skip()`'d and sample-less workloads.
  const empty: {
    id: string
    workload: Workload | undefined
    status: string
  }[] = [
    ...skippedWorkloads(doc, runs).map((workload) => ({
      id: workload.id,
      workload,
      status: "skipped",
    })),
    ...noSamples.map((run) => ({
      id: run.workloadId,
      workload: byWorkload.get(run.workloadId),
      status: "no samples",
    })),
  ]
  if (runs.length === 0 && empty.length === 0) return []

  const lines = ["## Timing", ""]

  // A group pivots into its own table when all its tasks share the same two
  // param keys; everything else is a normal row, with a `key=value` suffix
  // when it carries params.
  const rows: TimingRow[] = runs.map((run) => ({
    run,
    workload: byWorkload.get(run.workloadId),
  }))
  const byGroup = new Map<string, TimingRow[]>()
  const flat: TimingRow[] = []
  for (const row of rows) {
    const group = groupOf(row.workload)
    if (group === undefined) flat.push(row)
    else if (byGroup.has(group)) byGroup.get(group)!.push(row)
    else byGroup.set(group, [row])
  }
  const pivots: { group: string; keys: [string, string]; rows: TimingRow[] }[] =
    []
  for (const [group, groupRows] of byGroup) {
    const keys = pivotKeysFor(groupRows.map((r) => r.workload))
    if (keys) pivots.push({ group, keys, rows: groupRows })
    else flat.push(...groupRows)
  }

  if (flat.length > 0 || empty.length > 0) {
    const ratios = relativeRatios(rows)
    const optional: { header: string; cell: (row: TimingRow) => string }[] = []
    const cpuByRow = new Map(flat.map((row) => [row, cpuTimes(row.run)]))
    if ([...cpuByRow.values()].some(Boolean)) {
      optional.push({
        header: "User/Sys",
        cell: (row) => {
          const times = cpuByRow.get(row)
          return times ? formatCpuTimes(times) : "-"
        },
      })
    }
    for (const col of memoryColumns(memory)) {
      optional.push({
        header: col.header,
        cell: (row) => col.cell(row.run.workloadId) ?? "-",
      })
    }
    if (ratios) {
      optional.push({
        header: "Relative",
        cell: (row) =>
          formatRelative(ratios.get(row)!, !!row.workload?.baseline),
      })
    }

    lines.push(
      ...mdTable(
        [
          "Task",
          "Median",
          "Spread (p75…p99)",
          "Mean ± SD",
          "Range",
          "MAD",
          ...optional.map((c) => c.header),
        ],
        [
          ...flat.map((row) => {
            const t = row.run.timing
            const unit = pickDurationUnit(t.median)
            return [
              taskCell(row.workload, row.run.workloadId),
              formatDuration(t.median, unit),
              formatSpan(t.p75, t.p99, unit),
              `${formatDuration(t.mean, unit)} ± ${formatDuration(t.stddev, unit)}`,
              formatSpan(t.min, t.max, unit),
              formatDuration(t.mad, unit),
              ...optional.map((c) => c.cell(row)),
            ]
          }),
          ...empty.map(({ id, workload, status }) => [
            taskCell(workload, id),
            `- ${status}`,
            "-",
            "-",
            "-",
            "-",
            ...optional.map(() => "-"),
          ]),
        ],
      ),
      "",
    )
  }

  for (const {
    group,
    keys: [key1, key2],
    rows: groupRows,
  } of pivots) {
    const rowValues: ParamValue[] = []
    const colValues: ParamValue[] = []
    const medianAt = new Map<string, number>()
    for (const { run, workload } of groupRows) {
      const v1 = workload!.params![key1]!
      const v2 = workload!.params![key2]!
      if (!rowValues.includes(v1)) rowValues.push(v1)
      if (!colValues.includes(v2)) colValues.push(v2)
      medianAt.set(`${v1} ${v2}`, run.timing.median)
    }
    lines.push(
      `### ${cell(group)} (${cell(key1)} × ${cell(key2)})`,
      "",
      ...mdTable(
        [`${cell(key1)} \\ ${cell(key2)}`, ...colValues.map(cell)],
        rowValues.map((v1) => [
          cell(v1),
          ...colValues.map((v2) => {
            const median = medianAt.get(`${v1} ${v2}`)
            return median === undefined ? "-" : formatDuration(median)
          }),
        ]),
      ),
      "",
    )
  }

  const warned = [...runs, ...noSamples].flatMap((run) =>
    warningBullets(
      labelOrId(byWorkload.get(run.workloadId), run.workloadId),
      runWarnings(run, memory),
    ),
  )
  if (warned.length > 0) lines.push("### Warnings", "", ...warned, "")
  return lines
}

function captureSections(
  doc: ProfileDocument,
  byWorkload: Map<string, Workload>,
): string[] {
  const lines: string[] = []
  for (const run of doc.measurements) {
    if (run.phase !== "cpu" && run.phase !== "heap") continue
    const label = labelOrId(byWorkload.get(run.workloadId), run.workloadId)
    lines.push(
      run.phase === "cpu"
        ? `## CPU capture - ${label}`
        : `## Heap snapshot - ${label}`,
      "",
      `instrumented, diagnostic wall ${formatNsAsMs(run.diagnosticWallNs ?? 0)}ms`,
      "",
      ...(run.phase === "cpu" ? cpuDetail(run) : heapDetail(run)),
    )

    const notes = [
      ...run.artifacts.map((a) => `- artifact: \`${a.path}\``),
      ...run.warnings.map((w) => `- ! ${warningNote(w)}`),
    ]
    if (notes.length > 0) lines.push(...notes, "")
  }
  return lines
}

function cpuDetail(run: Measurement): string[] {
  const { cpu } = run
  if (!cpu) return []
  const lines = [
    `origin: \`${cpu.origin}\`, interval: ${cpu.samplingIntervalUs}µs, samples: ${cpuSampleCount(cpu)}`,
    "",
    ...mdTable(
      ["Self %", "Self (ms)", "Total (ms)", "Frame"],
      topSelfFrames(cpu, TOP_FRAMES).map((f) => [
        `${f.pct}%`,
        formatUsAsMs(f.selfUs),
        formatUsAsMs(f.totalUs),
        cell(frameName(f.frame)),
      ]),
    ),
    "",
  ]
  if (run.jit) {
    const tiers = run.jit.tiers
    lines.push(
      `JIT tiers: LLInt ${tiers.llint} · Baseline ${tiers.baseline} · DFG ${tiers.dfg} · FTL ${tiers.ftl}`,
      "",
    )
  }
  return lines
}

function heapDetail(run: Measurement): string[] {
  const { heap } = run
  if (!heap) return []
  return [
    formatHeapSummary(heap),
    "",
    ...mdTable(
      ["Count", "Type"],
      heap.typeCounts
        .slice(0, TOP_TYPES)
        .map((tc) => [String(tc.count), cell(tc.type)]),
    ),
    "",
  ]
}

function comparisonSection(doc: ProfileDocument): string[] {
  if (!doc.comparisons || doc.comparisons.length === 0) return []
  const resolve = comparisonResolver(doc)
  const lines = ["## Comparisons", ""]
  for (const cmp of doc.comparisons) {
    const { run, workload, workloadId } = resolve(cmp)
    lines.push(
      `### ${cmp.verdict === "pass" ? "✓" : "✗"} ${labelOrId(workload, workloadId)}`,
      "",
    )
    if (cmp.timing) {
      const { medianDeltaPct, ci95, pValue, verdict } = cmp.timing
      // "~": the delta rounds to non-zero but isn't significant (p past alpha).
      const tilde =
        verdict === "unchanged" &&
        pValue !== undefined &&
        pValue >= cmp.thresholds.alpha
          ? "~"
          : ""
      const detail: string[] = []
      if (run?.timing) detail.push(`n=${run.timing.samples.length}`)
      if (ci95)
        detail.push(
          `95% CI [${formatSignedPct(ci95[0])}, ${formatSignedPct(ci95[1])}]`,
        )
      if (pValue !== undefined) detail.push(`p=${pValue.toFixed(4)}`)
      detail.push(`threshold ${cmp.thresholds.effectiveTimingPct.toFixed(1)}%`)
      lines.push(
        `- timing: ${tilde}${formatSignedPct(medianDeltaPct)} median, ${detail.join(", ")} (**${verdict}**)`,
      )
    }
    for (const f of shownFrameDeltas(cmp, TOP_FRAMES)) {
      lines.push(
        `- frame \`${cell(f.name)}\`: ${formatSignedPct(f.deltaPct)} self-time (${formatUsAsMs(f.baseSelfUs)}ms → ${formatUsAsMs(f.candSelfUs)}ms)`,
      )
    }
    for (const h of shownHeapDeltas(cmp, TOP_TYPES)) {
      lines.push(
        `- heap \`${cell(h.type)}\`: ${formatSignedPct(h.deltaPct)} count (${h.baseCount} → ${h.candCount})`,
      )
    }
    for (const w of rowComparisonWarnings(cmp)) {
      lines.push(`- ! ${warningNote(w)}`)
    }
    lines.push("")
  }
  return lines
}
