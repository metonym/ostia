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
