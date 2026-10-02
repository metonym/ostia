/** Duration formatting shared by the stats warnings and every renderer; a leaf
 * module so neither imports the other. */
export type DurationUnit = "ns" | "µs" | "ms" | "s"

const UNIT_DIVISORS: Record<DurationUnit, number> = {
  ns: 1,
  µs: 1e3,
  ms: 1e6,
  s: 1e9,
}

export function pickDurationUnit(ns: number): DurationUnit {
  const abs = Math.abs(ns)
  if (abs >= 1e9) return "s"
  if (abs >= 1e6) return "ms"
  if (abs >= 1e3) return "µs"
  return "ns"
}

// 2 decimals under 10, else 1: never fewer than one.
function sigFigDecimals(value: number): number {
  const intDigits = Math.floor(Math.log10(Math.max(Math.abs(value), 1))) + 1
  return Math.max(1, 3 - intDigits)
}

/** Adaptive-unit duration, e.g. `3.02 ns`, `12.4 µs`, `275.8 ms`. Pass `unit`
 * to keep a row's columns in one unit. */
export function formatDuration(
  ns: number,
  unit: DurationUnit = pickDurationUnit(ns),
): string {
  const value = ns / UNIT_DIVISORS[unit]
  return `${value.toFixed(sigFigDecimals(value))} ${unit}`
}
