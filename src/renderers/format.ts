import { type DurationUnit, formatDuration } from "../format.ts"
import type {
  CpuEvidence,
  Environment,
  Frame,
  GitMetadata,
  HeapEvidence,
  Measurement,
  Workload,
} from "../ir/types.ts"
import { percentile, sortedCopy } from "../stats/index.ts"

/** `lo…hi` in one shared unit. */
export function formatSpan(lo: number, hi: number, unit: DurationUnit): string {
  return `${formatDuration(lo, unit)}…${formatDuration(hi, unit)}`
}

export function formatNsAsMs(ns: number): string {
  return (ns / 1e6).toFixed(3)
}

export function formatUsAsMs(us: number): string {
  return (us / 1000).toFixed(2)
}

/** `512B`, `2.00KiB`, `14.90MiB`: every byte count ostia prints is 1024-based. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)}MiB`
}

export function frameName(frame: Frame | undefined): string {
  return frame?.name || "(anonymous)"
}

/** The `limit` heaviest frames by self time (`cpu.totals` is pre-sorted),
 * with each one's share of all self time as a one-decimal percent string. */
export function topSelfFrames(cpu: CpuEvidence, limit: number) {
  const totalSelfUs = cpu.totals.reduce((s, t) => s + t.selfUs, 0) || 1
  return cpu.totals.slice(0, limit).map((t) => ({
    frame: cpu.frames[t.frameIx],
    selfUs: t.selfUs,
    totalUs: t.totalUs,
    pct: ((t.selfUs / totalSelfUs) * 100).toFixed(1),
  }))
}

/** `1200 objects, 3.42MiB` */
export function formatHeapSummary(heap: HeapEvidence): string {
  return `${heap.objectCount ?? "?"} objects, ${formatBytes(heap.heapSizeBytes ?? 0)}`
}

/** `Apple M2 Pro · 12 cores · load 2.1 · noise floor 1.8%` */
export function formatEnvironmentLine(env: Environment): string {
  return `${env.cpuModel} · ${env.cores} cores · load ${env.loadAvg1.toFixed(1)} · noise floor ${env.noise.floorPct.toFixed(1)}%`
}

/** `abc1234 (main, dirty)` */
export function formatGit(git: GitMetadata): string {
  return `${git.sha} (${git.branch}${git.dirty ? ", dirty" : ""})`
}

export function workloadLabel(w: Workload): string {
  return w.label ?? w.command?.join(" ") ?? w.entry?.task ?? w.id
}

/** The workload's label, or its raw id when the document has no such workload. */
export function labelOrId(w: Workload | undefined, id: string): string {
  return w ? workloadLabel(w) : id
}

/** `1.00× (baseline)` / `1.00×` / `2.43× slower` / `1.95× faster` */
export function formatRelative(relative: number, baseline: boolean): string {
  if (relative === 1) return baseline ? "1.00× (baseline)" : "1.00×"
  if (relative > 1) return `${relative.toFixed(2)}× slower`
  return `${(1 / relative).toFixed(2)}× faster`
}

/** Escapes `|`, `<`, `>`, backticks and newlines so a name can't break a GFM
 * table row. */
export function escapeMdCell(s: string): string {
  return s
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\r\n|\r|\n/g, "<br>")
}

/** Median user/system CPU time per trial of a subprocess measurement; undefined
 * for in-process ones. */
export function cpuTimes(
  run: Pick<Measurement, "trials">,
): { userNs: number; systemNs: number } | undefined {
  const user: number[] = []
  const system: number[] = []
  for (const t of run.trials) {
    if (t.timedOut || t.timeSourceNoMatch) continue
    if (t.userNs === undefined || t.systemNs === undefined) continue
    user.push(t.userNs)
    system.push(t.systemNs)
  }
  if (user.length === 0) return undefined
  return {
    userNs: percentile(sortedCopy(user), 0.5),
    systemNs: percentile(sortedCopy(system), 0.5),
  }
}

export function formatCpuTimes(times: {
  userNs: number
  systemNs: number
}): string {
  return `${formatDuration(times.userNs)}/${formatDuration(times.systemNs)}`
}

/** `+3.2%`, `-1.5%`; a delta that rounds to zero is `0.0%`, unsigned. */
export function formatSignedPct(pct: number): string {
  const text = pct.toFixed(1)
  if (Number(text) === 0) return "0.0%"
  return `${pct > 0 ? "+" : ""}${text}%`
}
