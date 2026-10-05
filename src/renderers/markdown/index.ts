import type { ProfileDocument, Workload } from "../../ir/types.ts"
import {
  cpuSampleCount,
  cpuTimes,
  escapeMdCell,
  formatBytes,
  formatCpuTimes,
  formatDuration,
  formatEnvironmentLine,
  formatGit,
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
  formatThrew,
  pairedRuns,
  pairedVerdict,
  threwRuns,
} from "../paired.ts"
import { relativeReferences } from "../relative.ts"
import {
  environmentMismatch,
  type MemoryReadings,
  memoryReadings,
  skippedWorkloads,
  timingRuns,
} from "../select.ts"
import type { Renderer, RenderResult } from "../types.ts"

function fmtMs(ns: number): string {
  return (ns / 1e6).toFixed(3)
}

function paramsSuffix(w: Workload | undefined): string {
  if (!w?.params) return ""
  const pairs = Object.entries(w.params).map(([k, v]) => `${k}=${v}`)
  return ` (${pairs.join(", ")})`
}

/** A cell's display text, escaped for a GFM table (`|`/`<`/`>`/backtick/
 * newline) - `v` is already a string for a label, or a raw param value
 * (string/number/boolean) from a pivot table's row/column headers. */
function cell(v: string | number | boolean): string {
  return escapeMdCell(String(v))
}

/** The two param keys every one of `runs`' workloads shares, in a consistent
 * order, when every workload has params and they all share exactly the same
 * two keys - the shape a markdown pivot table needs. Otherwise undefined. */
function pivotKeysFor(
  workloads: (Workload | undefined)[],
): [string, string] | undefined {
  let keys: string[] | undefined
  for (const w of workloads) {
    const k = w?.params ? Object.keys(w.params) : undefined
    if (k?.length !== 2) return undefined
    if (keys === undefined) keys = k
    else if (k.length !== keys.length || k.some((kk, i) => kk !== keys![i]))
      return undefined
  }
  return keys as [string, string] | undefined
}

/** `Retained/op` (`--alloc`) and `Peak mem` (`--peak-mem`) columns, each
 * only when some workload in the document has that measurement. */
/** `Retained/op` (`--alloc`) and `Peak mem` (`--peak-mem`) columns, each
 * only when some workload in the document has that measurement. */
function memoryColumns(memory: Map<string, MemoryReadings>): {
  columns: string[]
  cells: (workloadId: string) => string[]
} {
  const readings = [...memory.values()]
  const shown = [
    {
      name: "Retained/op",
      cell: (r: MemoryReadings | undefined) =>
        r?.retained === undefined ? "-" : formatBytes(r.retained),
    },
    {
      name: "Peak mem",
      cell: (r: MemoryReadings | undefined) =>
        r?.peak === undefined ? "-" : formatBytes(r.peak),
    },
  ].filter((_, i) =>
    readings.some((r) =>
      i === 0 ? r.retained !== undefined : r.peak !== undefined,
    ),
  )
  return {
    columns: shown.map((c) => c.name),
    cells: (id) => shown.map((c) => c.cell(memory.get(id))),
  }
}

const TOP_FRAMES = 10
const TOP_TYPES = 10

export const markdownRenderer: Renderer<Record<string, never>> = {
  name: "markdown",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const byWorkload = new Map(doc.workloads.map((w) => [w.id, w]))
    const lines: string[] = []

    lines.push(`# Profile Report`, "")
    const gitSuffix = doc.git ? ` · ${formatGit(doc.git)}` : ""
    lines.push(
      `Bun ${doc.bunVersion} · ostia ${doc.toolVersion} · ${doc.platform.os}/${doc.platform.arch} · ${doc.createdAt}${gitSuffix}`,
      "",
    )
    if (doc.environment) {
      lines.push(formatEnvironmentLine(doc.environment), "")
    }
    const mismatch = environmentMismatch(doc)
    if (mismatch) lines.push(`> ⚠ ${mismatch.message}`, "")

    // Only `ab()` writes paired measurements, and it always stamps `ab`.
    if (doc.ab) {
      const paired = pairedRuns(doc)
      lines.push("## A/B", "")
      lines.push(formatAbHeader(doc.ab), "")
      if (paired.length > 0) {
        lines.push(
          "| Task | Base | Candidate | Change | p25…p75 | Verdict |",
          "|---|---|---|---|---|---|",
        )
        for (const run of paired) {
          const workload = byWorkload.get(run.workloadId)
          const p = run.paired
          const unit = pickDurationUnit(
            Math.min(p.baseMedianNs, run.timing.median),
          )
          const verdict = pairedVerdict(p)
          lines.push(
            `| ${cell(workloadLabel(workload) + paramsSuffix(workload))} | ${formatDuration(p.baseMedianNs, unit)} | ${formatDuration(run.timing.median, unit)} | ${formatRatio(p.medianRatio)} | ${formatRatio(p.p25)}…${formatRatio(p.p75)} | ${verdict ? `**${cell(verdict)}**` : ""} |`,
          )
        }
        lines.push("")
      }
      const threw = threwRuns(doc)
      if (threw.length > 0) {
        lines.push(`Threw (${threw.length}):`, "")
        for (const run of threw) {
          const workload = byWorkload.get(run.workloadId)
          lines.push(
            `- **${cell(workloadLabel(workload) + paramsSuffix(workload))}**: ${formatThrew(run.threw)}: \`${run.threw.message.split("\n")[0]!.replaceAll("`", "'")}\``,
          )
        }
        lines.push("")
      }
      const notes = abNotes(doc)
      if (notes.outputDiffers.length > 0) {
        lines.push(
          `Output differs from the base: ${notes.outputDiffers.map(cell).join(", ")}`,
          "",
        )
      }
      if (notes.baseOnly.length > 0) {
        lines.push(`Base only: ${notes.baseOnly.map(cell).join(", ")}`, "")
      }
      if (notes.candOnly.length > 0) {
        lines.push(`Candidate only: ${notes.candOnly.map(cell).join(", ")}`, "")
      }
      for (const run of paired) {
        const label = workloadLabel(byWorkload.get(run.workloadId))
        for (const w of run.warnings)
          lines.push(`- **${label}**: ${w.message} (\`${w.code}\`)`)
      }
      if (paired.some((r) => r.warnings.length > 0)) lines.push("")
      lines.push(`**${formatAbSummary(doc.ab)}**`, "")
    }

    const runs = timingRuns(doc)
    const skipped = skippedWorkloads(doc, runs)
    const memoryByWorkload = memoryReadings(doc)
    if (runs.length > 0 || skipped.length > 0) {
      lines.push("## Timing", "")

      // A group pivots into its own table when every one of its tasks
      // shares the same two param keys (a sweep() over two dimensions);
      // everything else - ungrouped tasks, groups that don't qualify - is a
      // normal row, with a `key=value` suffix when it carries params.
      type TimingRun = (typeof runs)[number]
      const byGroup = new Map<string, TimingRun[]>()
      const flatRuns: TimingRun[] = []
      for (const run of runs) {
        const group = byWorkload.get(run.workloadId)?.entry?.group
        if (group === undefined) {
          flatRuns.push(run)
          continue
        }
        const arr = byGroup.get(group)
        if (arr) arr.push(run)
        else byGroup.set(group, [run])
      }

      const pivotGroups = new Map<
        string,
        { keys: [string, string]; runs: TimingRun[] }
      >()
      for (const [group, runs] of byGroup) {
        const keys = pivotKeysFor(runs.map((r) => byWorkload.get(r.workloadId)))
        if (keys) pivotGroups.set(group, { keys, runs })
        else flatRuns.push(...runs)
      }

      if (flatRuns.length > 0 || skipped.length > 0) {
        // Parity with the terminal table: a Relative column against the
        // group's baseline task (else its fastest sibling), only once
        // there's more than one timing run to be relative to.
        const relativeRows = runs.map((run) => ({
          run,
          workload: byWorkload.get(run.workloadId),
        }))
        const showRelative = relativeRows.length > 1
        const references = showRelative
          ? relativeReferences(relativeRows)
          : undefined
        const referenceMedianByRunId = new Map(
          relativeRows.map((r) => [
            r.run.id,
            references?.get(r) ?? r.run.timing.median,
          ]),
        )
        const relativeHeader = showRelative ? " Relative |" : ""
        const relativeSep = showRelative ? "---|" : ""
        const showCpuTimes = flatRuns.some((run) => cpuTimes(run))
        const cpuTimesHeader = showCpuTimes ? " User/Sys |" : ""
        const cpuTimesSep = showCpuTimes ? "---|" : ""
        const memory = memoryColumns(memoryByWorkload)
        const memoryHeader = memory.columns.map((c) => ` ${c} |`).join("")
        const memorySep = memory.columns.map(() => "---|").join("")

        lines.push(
          `| Task | Median | Spread (p75…p99) | Mean ± SD | Range | MAD |${cpuTimesHeader}${memoryHeader}${relativeHeader}`,
          `|---|---|---|---|---|---|${cpuTimesSep}${memorySep}${relativeSep}`,
        )
        for (const run of flatRuns) {
          const workload = byWorkload.get(run.workloadId)
          const label = cell(workloadLabel(workload) + paramsSuffix(workload))
          const t = run.timing
          const unit = pickDurationUnit(t.median)
          const times = cpuTimes(run)
          const cpuTimesCell = showCpuTimes
            ? ` ${times ? formatCpuTimes(times) : "-"} |`
            : ""
          const relativeCell = showRelative
            ? ` ${formatRelative(t.median / (referenceMedianByRunId.get(run.id) ?? t.median), !!workload?.baseline)} |`
            : ""
          const memoryCells = memory
            .cells(run.workloadId)
            .map((c) => ` ${c} |`)
            .join("")
          lines.push(
            `| ${label} | ${formatDuration(t.median, unit)} | ${formatDuration(t.p75, unit)}…${formatDuration(t.p99, unit)} | ${formatDuration(t.mean, unit)} ± ${formatDuration(t.stddev, unit)} | ${formatDuration(t.min, unit)}…${formatDuration(t.max, unit)} | ${formatDuration(t.mad, unit)} |${cpuTimesCell}${memoryCells}${relativeCell}`,
          )
        }
        for (const workload of skipped) {
          const label = cell(workloadLabel(workload) + paramsSuffix(workload))
          const relativeCell = showRelative ? " - |" : ""
          const cpuTimesCell = showCpuTimes ? " - |" : ""
          const memoryCells = memory.columns.map(() => " - |").join("")
          lines.push(
            `| ${label} | - skipped | - | - | - | - |${cpuTimesCell}${memoryCells}${relativeCell}`,
          )
        }
        lines.push("")
      }

      for (const [group, { keys, runs }] of pivotGroups) {
        const [key1, key2] = keys
        const rowValues: (string | number | boolean)[] = []
        const colValues: (string | number | boolean)[] = []
        const cellByPoint = new Map<string, TimingRun>()
        for (const run of runs) {
          const params = byWorkload.get(run.workloadId)!.params!
          const v1 = params[key1]!
          const v2 = params[key2]!
          if (!rowValues.includes(v1)) rowValues.push(v1)
          if (!colValues.includes(v2)) colValues.push(v2)
          cellByPoint.set(`${v1} ${v2}`, run)
        }
        lines.push(`### ${cell(group)} (${cell(key1)} × ${cell(key2)})`, "")
        lines.push(
          `| ${cell(key1)} \\ ${cell(key2)} | ${colValues.map(cell).join(" | ")} |`,
          `|---|${colValues.map(() => "---").join("|")}|`,
        )
        for (const v1 of rowValues) {
          const cells = colValues.map((v2) => {
            const run = cellByPoint.get(`${v1} ${v2}`)
            return run ? formatDuration(run.timing.median) : "-"
          })
          lines.push(`| ${cell(v1)} | ${cells.join(" | ")} |`)
        }
        lines.push("")
      }

      const rowWarnings = (run: (typeof runs)[number]) => {
        const extra = memoryByWorkload.get(run.workloadId)?.warnings
        return extra?.length ? [...run.warnings, ...extra] : run.warnings
      }
      const withWarnings = runs.filter((r) => rowWarnings(r).length > 0)
      if (withWarnings.length > 0) {
        lines.push("### Warnings", "")
        for (const run of withWarnings) {
          const label = workloadLabel(byWorkload.get(run.workloadId))
          for (const w of rowWarnings(run))
            lines.push(`- **${label}**: ${w.message} (\`${w.code}\`)`)
        }
        lines.push("")
      }
    }

    for (const run of doc.measurements) {
      if (run.phase !== "cpu" && run.phase !== "heap") continue
      const label = workloadLabel(byWorkload.get(run.workloadId))

      if (run.phase === "cpu") {
        lines.push(`## CPU capture - ${label}`, "")
        lines.push(
          `instrumented, diagnostic wall ${fmtMs(run.diagnosticWallNs ?? 0)}ms`,
          "",
        )
        if (run.cpu) {
          lines.push(
            `origin: \`${run.cpu.origin}\`, interval: ${run.cpu.samplingIntervalUs}µs, samples: ${cpuSampleCount(run.cpu)}`,
            "",
          )
          lines.push(
            "| Self % | Self (ms) | Total (ms) | Frame |",
            "|---|---|---|---|",
          )
          const totalUs = run.cpu.totals.reduce((s, t) => s + t.selfUs, 0) || 1
          for (const t of run.cpu.totals.slice(0, TOP_FRAMES)) {
            const frame = run.cpu.frames[t.frameIx]
            const pct = ((t.selfUs / totalUs) * 100).toFixed(1)
            lines.push(
              `| ${pct}% | ${(t.selfUs / 1000).toFixed(2)} | ${(t.totalUs / 1000).toFixed(2)} | ${cell(frame?.name || "(anonymous)")} |`,
            )
          }
          lines.push("")
          if (run.jit) {
            const tiers = run.jit.tiers
            lines.push(
              `JIT tiers: LLInt ${tiers.llint} · Baseline ${tiers.baseline} · DFG ${tiers.dfg} · FTL ${tiers.ftl}`,
              "",
            )
          }
        }
      } else {
        lines.push(`## Heap snapshot - ${label}`, "")
        lines.push(
          `instrumented, diagnostic wall ${fmtMs(run.diagnosticWallNs ?? 0)}ms`,
          "",
        )
        if (run.heap) {
          lines.push(
            `${run.heap.objectCount ?? "?"} objects, ${((run.heap.heapSizeBytes ?? 0) / 1e6).toFixed(2)}MB`,
            "",
          )
          lines.push("| Count | Type |", "|---|---|")
          for (const tc of run.heap.typeCounts.slice(0, TOP_TYPES)) {
            lines.push(`| ${tc.count} | ${cell(tc.type)} |`)
          }
          lines.push("")
        }
      }

      for (const a of run.artifacts) lines.push(`- artifact: \`${a.path}\``)
      for (const w of run.warnings)
        lines.push(`- ! ${w.message} (\`${w.code}\`)`)
      if (run.artifacts.length > 0 || run.warnings.length > 0) lines.push("")
    }

    if (doc.comparisons && doc.comparisons.length > 0) {
      lines.push("## Comparisons", "")
      for (const cmp of doc.comparisons) {
        const run = doc.measurements.find(
          (r) => r.id === cmp.candidateMeasurementId,
        )
        // A skipped candidate has no measurement; compareWorkload falls back
        // to the workload's own id for candidateMeasurementId.
        const label = workloadLabel(
          run
            ? byWorkload.get(run.workloadId)
            : byWorkload.get(cmp.candidateMeasurementId),
        )
        lines.push(`### ${cmp.verdict === "pass" ? "✓" : "✗"} ${label}`, "")
        if (cmp.timing) {
          const sign = cmp.timing.medianDeltaPct > 0 ? "+" : ""
          // "~": the delta rounds to non-zero but isn't a significant
          // difference (Mann-Whitney p past alpha) - a point estimate that
          // looks like a change but isn't one, per the verdict rule.
          const tilde =
            cmp.timing.verdict === "unchanged" &&
            cmp.timing.pValue !== undefined &&
            cmp.timing.pValue >= cmp.thresholds.alpha
              ? "~"
              : ""
          const detail: string[] = []
          if (run?.timing) detail.push(`n=${run.timing.samples.length}`)
          if (cmp.timing.ci95) {
            detail.push(
              `95% CI [${cmp.timing.ci95[0] > 0 ? "+" : ""}${cmp.timing.ci95[0].toFixed(1)}%, ${cmp.timing.ci95[1] > 0 ? "+" : ""}${cmp.timing.ci95[1].toFixed(1)}%]`,
            )
          }
          if (cmp.timing.pValue !== undefined) {
            detail.push(`p=${cmp.timing.pValue.toFixed(4)}`)
          }
          detail.push(
            `threshold ${cmp.thresholds.effectiveTimingPct.toFixed(1)}%`,
          )
          lines.push(
            `- timing: ${tilde}${sign}${cmp.timing.medianDeltaPct.toFixed(1)}% median, ${detail.join(", ")} (**${cmp.timing.verdict}**)`,
          )
        }
        for (const f of cmp.frames?.slice(0, TOP_FRAMES) ?? []) {
          if (Math.abs(f.deltaPct) < MIN_DISPLAY_DELTA_PCT) continue
          const sign = f.deltaPct > 0 ? "+" : ""
          lines.push(
            `- frame \`${cell(f.name)}\`: ${sign}${f.deltaPct.toFixed(1)}% self-time (${(f.baseSelfUs / 1000).toFixed(2)}ms → ${(f.candSelfUs / 1000).toFixed(2)}ms)`,
          )
        }
        for (const h of cmp.heapTypes?.slice(0, TOP_TYPES) ?? []) {
          if (Math.abs(h.deltaPct) < MIN_DISPLAY_DELTA_PCT) continue
          const sign = h.deltaPct > 0 ? "+" : ""
          lines.push(
            `- heap \`${cell(h.type)}\`: ${sign}${h.deltaPct.toFixed(1)}% count (${h.baseCount} → ${h.candCount})`,
          )
        }
        for (const w of cmp.warnings ?? []) {
          if (w.code === "environment-mismatch") continue
          lines.push(`- ! ${w.message} (\`${w.code}\`)`)
        }
        lines.push("")
      }
    }

    return { text: lines.join("\n") }
  },
}
