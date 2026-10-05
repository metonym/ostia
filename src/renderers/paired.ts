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

/** The measurements an A/B table is made of (`ab()` documents). */
export function pairedRuns(doc: ProfileDocument): PairedRun[] {
  return doc.measurements.filter(
    (m): m is PairedRun =>
      m.phase === "paired" && m.timing !== undefined && m.paired !== undefined,
  )
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
