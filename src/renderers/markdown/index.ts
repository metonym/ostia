import type { Measurement, ProfileDocument, Workload } from "../../ir/types.ts"
import { formatDuration, pickDurationUnit } from "../format.ts"
import type { Renderer, RenderResult } from "../types.ts"

function fmtMs(ns: number): string {
  return (ns / 1e6).toFixed(3)
}

function commandLabel(w: Workload | undefined): string {
  return (
    w?.label ?? w?.command?.join(" ") ?? w?.entry?.task ?? w?.id ?? "unknown"
  )
}

const TOP_FRAMES = 10
const TOP_TYPES = 10

export const markdownRenderer: Renderer<Record<string, never>> = {
  name: "markdown",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const byWorkload = new Map(doc.workloads.map((w) => [w.id, w]))
    const lines: string[] = []

    lines.push(`# Profile Report`, "")
    lines.push(
      `Bun ${doc.bunVersion} · ostia ${doc.toolVersion} · ${doc.platform.os}/${doc.platform.arch} · ${doc.createdAt}`,
      "",
    )

    const timingRuns = doc.measurements.filter(
      (r): r is Measurement & { timing: NonNullable<Measurement["timing"]> } =>
        r.phase === "timing" && r.timing !== undefined,
    )
    if (timingRuns.length > 0) {
      lines.push("## Timing", "")
      lines.push("| Task | Median | Mean ± SD | Range |", "|---|---|---|---|")
      for (const run of timingRuns) {
        const label = commandLabel(byWorkload.get(run.workloadId))
        const t = run.timing
        const unit = pickDurationUnit(t.median)
        lines.push(
          `| ${label} | ${formatDuration(t.median, unit)} | ${formatDuration(t.mean, unit)} ± ${formatDuration(t.stddev, unit)} | ${formatDuration(t.min, unit)}…${formatDuration(t.max, unit)} |`,
        )
      }
      lines.push("")

      const withWarnings = timingRuns.filter((r) => r.warnings.length > 0)
      if (withWarnings.length > 0) {
        lines.push("### Warnings", "")
        for (const run of withWarnings) {
          const label = commandLabel(byWorkload.get(run.workloadId))
          for (const w of run.warnings)
            lines.push(`- **${label}**: ${w.message} (\`${w.code}\`)`)
        }
        lines.push("")
      }
    }

    for (const run of doc.measurements) {
      if (run.phase !== "cpu" && run.phase !== "heap") continue
      const label = commandLabel(byWorkload.get(run.workloadId))

      if (run.phase === "cpu") {
        lines.push(`## CPU capture - ${label}`, "")
        lines.push(
          `instrumented, diagnostic wall ${fmtMs(run.diagnosticWallNs ?? 0)}ms`,
          "",
        )
        if (run.cpu) {
          lines.push(
            `origin: \`${run.cpu.origin}\`, interval: ${run.cpu.samplingIntervalUs}µs`,
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
              `| ${pct}% | ${(t.selfUs / 1000).toFixed(2)} | ${(t.totalUs / 1000).toFixed(2)} | ${frame?.name || "(anonymous)"} |`,
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
            lines.push(`| ${tc.count} | ${tc.type} |`)
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
        const label = commandLabel(
          run ? byWorkload.get(run.workloadId) : undefined,
        )
        lines.push(`### ${cmp.verdict === "pass" ? "✓" : "✗"} ${label}`, "")
        if (cmp.timing) {
          const sign = cmp.timing.medianDeltaPct > 0 ? "+" : ""
          lines.push(
            `- timing: ${sign}${cmp.timing.medianDeltaPct.toFixed(1)}% median (**${cmp.timing.verdict}**)`,
          )
        }
        for (const f of cmp.frames?.slice(0, TOP_FRAMES) ?? []) {
          if (Math.abs(f.deltaPct) < 0.5) continue
          const sign = f.deltaPct > 0 ? "+" : ""
          lines.push(
            `- frame \`${f.name}\`: ${sign}${f.deltaPct.toFixed(1)}% self-time (${(f.baseSelfUs / 1000).toFixed(2)}ms → ${(f.candSelfUs / 1000).toFixed(2)}ms)`,
          )
        }
        for (const h of cmp.heapTypes?.slice(0, TOP_TYPES) ?? []) {
          if (Math.abs(h.deltaPct) < 0.5) continue
          const sign = h.deltaPct > 0 ? "+" : ""
          lines.push(
            `- heap \`${h.type}\`: ${sign}${h.deltaPct.toFixed(1)}% count (${h.baseCount} → ${h.candCount})`,
          )
        }
        lines.push("")
      }
    }

    return { text: lines.join("\n") }
  },
}
