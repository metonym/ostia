import type {
  AbSummary,
  Measurement,
  PairedEvidence,
  ProfileDocument,
  Workload,
} from "../ir/types.ts"
import { comparable } from "../measure/paired.ts"
import { workloadLabel } from "./format.ts"

export type PairedRun = Measurement & {
  timing: NonNullable<Measurement["timing"]>
  paired: PairedEvidence
}

export type ThrewRun = Measurement & {
  threw: NonNullable<Measurement["threw"]>
}

/** A task that threw, on either side, in its first process or a repeat. */
function isThrewRun(m: Measurement): m is ThrewRun {
  return m.phase === "paired" && m.threw !== undefined
}

/** A task judged on its time: measured, and it never threw. */
function isPairedRun(m: Measurement): m is PairedRun {
  return (
    m.phase === "paired" &&
    m.threw === undefined &&
    m.timing !== undefined &&
    m.paired !== undefined
  )
}

/** The timed measurements an A/B table is made of (`ab()` documents). */
export function pairedRuns(doc: ProfileDocument): PairedRun[] {
  return doc.measurements.filter(isPairedRun)
}

/** An `ab()` document's tasks that threw. */
export function threwRuns(doc: ProfileDocument): ThrewRun[] {
  return doc.measurements.filter(isThrewRun)
}

export type AbRow =
  | { kind: "timed"; run: PairedRun }
  | { kind: "threw"; run: ThrewRun }

/** Every row of an A/B table, timed or threw, in document order. */
export function abRows(doc: ProfileDocument): AbRow[] {
  const rows: AbRow[] = []
  for (const m of doc.measurements) {
    if (isThrewRun(m)) rows.push({ kind: "threw", run: m })
    else if (isPairedRun(m)) rows.push({ kind: "timed", run: m })
  }
  return rows
}

/** `base threw`, `candidate threw`, `both threw`, with `(repeat 1)` when it
 * threw in a confirmation repeat. */
export function formatThrew(threw: ThrewRun["threw"]): string {
  const side = threw.side === "cand" ? "candidate" : threw.side
  return `${side} threw${threw.repeat ? ` (repeat ${threw.repeat})` : ""}`
}

/** A ratio as a signed percent change, e.g. `1.032` → `+3.2%`. */
export function formatRatio(ratio: number): string {
  const pct = (ratio - 1) * 100
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`
}

/** `regressed`, `improved`, blank for unchanged; a flagged workload that
 * fresh processes didn't reproduce reads `unconfirmed`. Repeats follow in
 * parentheses so a reader sees what the confirmation runs measured. A
 * changed suite with changed output reads `not comparable`. */
export function pairedVerdict(p: PairedEvidence): string {
  if (!comparable(p)) return "not comparable"
  if (!p.flagged) return ""
  const repeats = p.repeats?.length
    ? ` (repeats: ${p.repeats.map((r) => formatRatio(r.medianRatio)).join(", ")})`
    : ""
  if (p.confirmed === undefined) return `${p.flagged}${repeats}`
  return `${p.confirmed ? `${p.flagged}, confirmed` : `${p.flagged}? unconfirmed`}${repeats}`
}

/** `New suites, not at HEAD: bench/new.bench.ts`, or nothing. */
export function formatNewSuites(ab: AbSummary): string | undefined {
  if (!ab.newSuites?.length) return undefined
  return `New suite${ab.newSuites.length > 1 ? "s" : ""}, not at ${ab.base.ref}: ${ab.newSuites.join(", ")}`
}

/** `working tree vs HEAD (26e7d0d) · 15 rounds · threshold 10% · geomean threshold 1.5%` */
export function formatAbHeader(ab: AbSummary): string {
  return `working tree vs ${ab.base.ref} (${ab.base.sha.slice(0, 7)}) · ${ab.rounds} rounds · threshold ${ab.thresholdPct}% · geomean threshold ${ab.geomeanThresholdPct}%`
}

/** `Geomean +2.1% (threshold 1.5%) · 1 regressed, 0 improved, 47 unchanged of 48 (1 unconfirmed) · fail` */
export function formatAbSummary(ab: AbSummary): string {
  const geomean =
    ab.geomeanPct === null
      ? "Geomean -"
      : `Geomean ${ab.geomeanPct >= 0 ? "+" : ""}${ab.geomeanPct.toFixed(1)}% (threshold ${ab.geomeanThresholdPct}%)`
  const notes = [
    ab.unconfirmed > 0 && `${ab.unconfirmed} unconfirmed`,
    ab.notComparable > 0 && `${ab.notComparable} not comparable`,
    ab.threw > 0 && `${ab.threw} threw`,
  ].filter(Boolean)
  const unconfirmed = notes.length > 0 ? ` (${notes.join(", ")})` : ""
  return `${geomean} · ${ab.regressed} regressed, ${ab.improved} improved, ${ab.unchanged} unchanged of ${ab.matched}${unconfirmed} · ${ab.verdict}`
}

/** Labels of the workloads whose output differed between the two sides, and
 * of those present on only one side. */
export function abNotes(doc: ProfileDocument): {
  outputDiffers: string[]
  baseOnly: string[]
  candOnly: string[]
} {
  const byId = new Map<string, Workload>(doc.workloads.map((w) => [w.id, w]))
  const label = (id: string) =>
    byId.has(id) ? workloadLabel(byId.get(id)) : id
  return {
    outputDiffers: pairedRuns(doc)
      .filter((m) => !m.paired.sameOutput)
      .map((m) => label(m.workloadId)),
    baseOnly: (doc.unmatched?.baseOnly ?? []).map(label),
    candOnly: (doc.unmatched?.candOnly ?? []).map(label),
  }
}
