import { type DurationUnit, formatDuration } from "../format.ts";
import type {
  CpuEvidence,
  Environment,
  Frame,
  GitMetadata,
  HeapEvidence,
  Measurement,
  Workload,
} from "../ir/types.ts";
import { percentile, sortedCopy } from "../stats/index.ts";

export function formatSpan(lo: number, hi: number, unit: DurationUnit): string {
  return `${formatDuration(lo, unit)}…${formatDuration(hi, unit)}`;
}

export function formatNsAsMs(ns: number): string {
  return (ns / 1e6).toFixed(3);
}

export function formatUsAsMs(us: number): string {
  return (us / 1000).toFixed(2);
}

// invariant: every byte count ostia prints is 1024-based.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MiB`;
}

export function formatInstructions(count: number): string {
  if (count < 1e3) return count.toFixed(0);
  const [divisor, suffix] =
    count >= 1e9 ? [1e9, "G"] : count >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  const value = count / divisor;
  return `${value.toFixed(value < 10 ? 2 : 1)}${suffix}`;
}

export function frameName(frame: Frame | undefined): string {
  return frame?.name || "(anonymous)";
}

// `cpu.totals` is pre-sorted by self time, so the first `limit` are the
// heaviest.
export function topSelfFrames(
  cpu: CpuEvidence,
  limit: number,
): {
  frame: Frame | undefined;
  selfUs: number;
  totalUs: number;
  pct: string;
}[] {
  const totalSelfUs = cpu.totals.reduce((s, t) => s + t.selfUs, 0) || 1;
  return cpu.totals.slice(0, limit).map((t) => ({
    frame: cpu.frames[t.frameIx],
    selfUs: t.selfUs,
    totalUs: t.totalUs,
    pct: ((t.selfUs / totalSelfUs) * 100).toFixed(1),
  }));
}

export function formatHeapSummary(heap: HeapEvidence): string {
  return `${heap.objectCount ?? "?"} objects, ${formatBytes(heap.heapSizeBytes ?? 0)}`;
}

export function formatEnvironmentLine(env: Environment): string {
  return `${env.cpuModel} · ${env.cores} cores · load ${env.loadAvg1.toFixed(1)} · noise floor ${env.noise.floorPct.toFixed(1)}%`;
}

export function formatGit(git: GitMetadata): string {
  return `${git.sha} (${git.branch}${git.dirty ? ", dirty" : ""})`;
}

export function workloadLabel(w: Workload): string {
  return w.label ?? w.command?.join(" ") ?? w.entry?.task ?? w.id;
}

export function labelOrId(w: Workload | undefined, id: string): string {
  return w ? workloadLabel(w) : id;
}

export function formatRelative(relative: number, baseline: boolean): string {
  if (relative === 1) return baseline ? "1.00× (baseline)" : "1.00×";
  if (relative > 1) return `${relative.toFixed(2)}× slower`;
  return `${(1 / relative).toFixed(2)}× faster`;
}

// So a name can't break a GFM table row.
export function escapeMdCell(s: string): string {
  return s
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\r\n|\r|\n/g, "<br>");
}

// Median per trial; in-process measurements have no CPU times, so
// undefined.
export function cpuTimes(
  run: Pick<Measurement, "trials">,
): { userNs: number; systemNs: number } | undefined {
  const user: number[] = [];
  const system: number[] = [];
  for (const t of run.trials) {
    if (t.timedOut || t.timeSourceNoMatch) continue;
    if (t.userNs === undefined || t.systemNs === undefined) continue;
    user.push(t.userNs);
    system.push(t.systemNs);
  }
  if (user.length === 0) return undefined;
  return {
    userNs: percentile(sortedCopy(user), 0.5),
    systemNs: percentile(sortedCopy(system), 0.5),
  };
}

export function formatCpuTimes(times: {
  userNs: number;
  systemNs: number;
}): string {
  return `${formatDuration(times.userNs)}/${formatDuration(times.systemNs)}`;
}

// A delta that rounds to zero prints unsigned, never `-0.0%`.
export function formatSignedPct(pct: number): string {
  const text = pct.toFixed(1);
  if (Number(text) === 0) return "0.0%";
  return `${pct > 0 ? "+" : ""}${text}%`;
}
