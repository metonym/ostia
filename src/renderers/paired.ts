import { formatDuration, pickDurationUnit } from "../format.ts"
import type {
  AbSummary,
  Measurement,
  MemoryChange,
  PairedEvidence,
  ProfileDocument,
} from "../ir/types.ts"
import { comparable, sideLabel } from "../measure/paired.ts"
import { formatBytes, formatSignedPct, labelOrId } from "./format.ts"
import { workloadsById } from "./select.ts"

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
  return `${sideLabel(threw.side)} threw${threw.repeat ? ` (repeat ${threw.repeat})` : ""}`
}

/** A candidate/base ratio as a signed percent change: `1.032` is `+3.2%`. */
function formatRatio(ratio: number): string {
  return formatSignedPct((ratio - 1) * 100)
}

// Blank for unchanged; a flagged workload that fresh processes didn't
// reproduce reads `unconfirmed`. Repeats follow so the confirmation is visible.
// A changed suite with changed output reads `not comparable`.
function pairedVerdict(p: PairedEvidence): string {
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

export interface MemoryRow {
  run: PairedRun
  reading: "retained/op" | "peak"
  change: MemoryChange
}

/** Each timed task's memory readings, retained before peak. */
export function memoryRows(doc: ProfileDocument): MemoryRow[] {
  return pairedRuns(doc).flatMap((run) => {
    const rows: MemoryRow[] = []
    const { retained, peak } = run.paired
    if (retained) rows.push({ run, reading: "retained/op", change: retained })
    if (peak) rows.push({ run, reading: "peak", change: peak })
    return rows
  })
}

/** `+1.50MiB (+87.4%)`, in whole bytes; no percent when the base is under
 * the noise floor, where it would be huge and meaningless. */
function formatByteChange(c: MemoryChange): string {
  const base = Math.round(c.baseBytes)
  const diff = Math.round(c.candBytes) - base
  if (diff === 0) return "0B"
  const bytes = `${diff > 0 ? "+" : "-"}${formatBytes(Math.abs(diff))}`
  if (base === 0 || c.baseBytes < c.floorBytes) return bytes
  return `${bytes} (${formatSignedPct((diff / base) * 100)})`
}

/** The text of one memory row's table cells. */
export function memoryCells({ reading, change: c }: MemoryRow) {
  return {
    reading,
    base: formatBytes(c.baseBytes),
    candidate: formatBytes(c.candBytes),
    change: formatByteChange(c),
    verdict: c.verdict === "unchanged" ? "" : c.verdict,
  }
}

/** `working tree vs HEAD (26e7d0d) · 15 rounds · threshold 10% · geomean threshold 1.5%` */
export function formatAbHeader(ab: AbSummary): string {
  const memory = ab.memory
    ? ` · memory threshold ${ab.memory.thresholdPct}%`
    : ""
  return `working tree vs ${ab.base.ref} (${ab.base.sha.slice(0, 7)}) · ${ab.rounds} rounds · threshold ${ab.thresholdPct}% · geomean threshold ${ab.geomeanThresholdPct}%${memory}`
}

/** `Geomean +2.1% (threshold 1.5%) · 1 regressed, 0 improved, 47 unchanged of 48 (1 unconfirmed) · memory: 0 regressed, 1 improved · fail` */
export function formatAbSummary(ab: AbSummary): string {
  const geomean =
    ab.geomeanPct === null
      ? "Geomean -"
      : `Geomean ${formatSignedPct(ab.geomeanPct)} (threshold ${ab.geomeanThresholdPct}%)`
  const notes = [
    ab.unconfirmed > 0 && `${ab.unconfirmed} unconfirmed`,
    ab.notComparable > 0 && `${ab.notComparable} not comparable`,
    ab.threw > 0 && `${ab.threw} threw`,
  ].filter(Boolean)
  const unconfirmed = notes.length > 0 ? ` (${notes.join(", ")})` : ""
  const memory = ab.memory
    ? ` · memory: ${ab.memory.regressed} regressed, ${ab.memory.improved} improved`
    : ""
  return `${geomean} · ${ab.regressed} regressed, ${ab.improved} improved, ${ab.unchanged} unchanged of ${ab.matched}${unconfirmed}${memory} · ${ab.verdict}`
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
