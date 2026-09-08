import type { Environment, GitMetadata, Workload } from "../ir/types.ts"

/** Below this absolute percent, a comparison's frame/heap-type delta is
 * noise, not signal - the terminal and markdown renderers both skip it
 * rather than list dozens of near-zero rows. Shared so the two can't drift
 * apart on what counts as "worth showing". */
export const MIN_DISPLAY_DELTA_PCT = 0.5

export type DurationUnit = "ns" | "µs" | "ms" | "s"

const UNIT_DIVISORS: Record<DurationUnit, number> = {
  ns: 1,
  µs: 1e3,
  ms: 1e6,
  s: 1e9,
}

/** Largest unit whose value (for this many nanoseconds) is at least 1, so a
 * duration reads as a small number instead of a long run of digits. */
export function pickDurationUnit(ns: number): DurationUnit {
  const abs = Math.abs(ns)
  if (abs >= 1e9) return "s"
  if (abs >= 1e6) return "ms"
  if (abs >= 1e3) return "µs"
  return "ns"
}

/** Decimal places so the value carries about 3 significant digits: 2 decimals
 * under 10, 1 decimal from 10 up (matches `12.4`, `275.8`; the latter is 4
 * sig figs, not 3, since a duration never drops below 1 decimal place). */
function sigFigDecimals(value: number): number {
  const intDigits = Math.floor(Math.log10(Math.max(Math.abs(value), 1))) + 1
  return Math.max(1, 3 - intDigits)
}

/** Formats a duration in nanoseconds with an adaptive unit (ns/µs/ms/s) and
 * about 3 significant digits, e.g. `3.02 ns`, `12.4 µs`, `275.8 ms`, `2.41 s`.
 * Pass `unit` to force a specific unit (e.g. so a range/spread column lines
 * up with its row's median column) instead of picking one from `ns`. */
export function formatDuration(
  ns: number,
  unit: DurationUnit = pickDurationUnit(ns),
): string {
  const value = ns / UNIT_DIVISORS[unit]
  return `${value.toFixed(sigFigDecimals(value))} ${unit}`
}

/** One header line describing the machine a document was measured on, e.g.
 * `Apple M2 Pro · 12 cores · load 2.1 · noise floor 1.8%`. */
export function formatEnvironmentLine(env: Environment): string {
  return `${env.cpuModel} · ${env.cores} cores · load ${env.loadAvg1.toFixed(1)} · noise floor ${env.noise.floorPct.toFixed(1)}%`
}

/** `abc1234 (main, dirty)`: the short sha, branch, and a dirty marker. */
export function formatGit(git: GitMetadata): string {
  return `${git.sha} (${git.branch}${git.dirty ? ", dirty" : ""})`
}

/** Display name for a workload: its label, else the command line, else the
 * bench task id, else the raw workload id. */
export function workloadLabel(w: Workload | undefined): string {
  return (
    w?.label ?? w?.command?.join(" ") ?? w?.entry?.task ?? w?.id ?? "unknown"
  )
}

/** `1.00× (baseline)` / `1.00×` / `2.43× slower` / `1.95× faster` - a Relative
 * cell's text, shared by the terminal and markdown renderers so the two
 * can't drift on what "Relative" means. */
export function formatRelative(relative: number, baseline: boolean): string {
  if (relative === 1) return baseline ? "1.00× (baseline)" : "1.00×"
  if (relative > 1) return `${relative.toFixed(2)}× slower`
  return `${(1 / relative).toFixed(2)}× faster`
}

/** Escapes text for a GFM table cell: `|` (column separator), `<`/`>` (raw
 * HTML), backticks (code spans), and newlines (which would otherwise break
 * the row) - so a task/frame/param name containing any of these renders as
 * one intact row instead of corrupting the table. */
export function escapeMdCell(s: string): string {
  return s
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\r\n|\r|\n/g, "<br>")
}
