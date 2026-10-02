import { formatDuration, pickDurationUnit } from "../format.ts"
import type {
  AbSummary,
  Measurement,
  PairedEvidence,
  ProfileDocument,
} from "../ir/types.ts"
import { formatSignedPct, labelOrId } from "./format.ts"
import { workloadsById } from "./select.ts"

export type PairedRun = Measurement & {
  timing: NonNullable<Measurement["timing"]>
  paired: PairedEvidence
}

export function pairedRuns(doc: ProfileDocument): PairedRun[] {
  return doc.measurements.filter(
    (m): m is PairedRun =>
      m.phase === "paired" && m.timing !== undefined && m.paired !== undefined,
  )
}

/** A candidate/base ratio as a signed percent change: `1.032` is `+3.2%`. */
function formatRatio(ratio: number): string {
  return formatSignedPct((ratio - 1) * 100)
}

// Blank for unchanged; a flagged workload that fresh processes didn't
// reproduce reads `unconfirmed`. Repeats follow so the confirmation is visible.
function pairedVerdict(p: PairedEvidence): string {
  if (!p.flagged) return ""
  const repeats = p.repeats?.length
    ? ` (repeats: ${p.repeats.map((r) => formatRatio(r.medianRatio)).join(", ")})`
    : ""
  if (p.confirmed === undefined) return `${p.flagged}${repeats}`
  return `${p.confirmed ? `${p.flagged}, confirmed` : `${p.flagged}? unconfirmed`}${repeats}`
}

/** The text of one paired row's table cells. */
export function pairedCells(run: PairedRun) {
  const p = run.paired
  const unit = pickDurationUnit(Math.min(p.baseMedianNs, run.timing.median))
  return {
    base: formatDuration(p.baseMedianNs, unit),
    candidate: formatDuration(run.timing.median, unit),
    change: formatRatio(p.medianRatio),
    spread: `${formatRatio(p.ratioP25)}…${formatRatio(p.ratioP75)}`,
    verdict: pairedVerdict(p),
  }
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
      : `Geomean ${formatSignedPct(ab.geomeanPct)} (threshold ${ab.geomeanThresholdPct}%)`
  const unconfirmed =
    ab.unconfirmed > 0 ? ` (${ab.unconfirmed} unconfirmed)` : ""
  return `${geomean} · ${ab.regressed} regressed, ${ab.improved} improved, ${ab.unchanged} unchanged of ${ab.matched}${unconfirmed} · ${ab.verdict}`
}

/** Labels of workloads whose output differed between sides, and of those
 * present on only one side. */
export function abNotes(doc: ProfileDocument): {
  outputDiffers: string[]
  baseOnly: string[]
  candOnly: string[]
} {
  const byId = workloadsById(doc)
  const label = (id: string) => labelOrId(byId.get(id), id)
  return {
    outputDiffers: pairedRuns(doc)
      .filter((m) => !m.paired.sameOutput)
      .map((m) => label(m.workloadId)),
    baseOnly: (doc.unmatched?.baseOnly ?? []).map(label),
    candOnly: (doc.unmatched?.candOnly ?? []).map(label),
  }
}
