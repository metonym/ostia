import { formatDuration, pickDurationUnit } from "../format.ts";
import type {
  AbSummary,
  Measurement,
  MemoryChange,
  PairedEvidence,
  ProfileDocument,
} from "../ir/types.ts";
import { comparable, metricRatios, sideLabel } from "../measure/paired.ts";
import {
  formatBytes,
  formatInstructions,
  formatSignedPct,
  labelOrId,
} from "./format.ts";
import { workloadsById } from "./select.ts";

export type PairedRun = Measurement & {
  timing: NonNullable<Measurement["timing"]>;
  paired: PairedEvidence;
};

type ThrewRun = Measurement & {
  threw: NonNullable<Measurement["threw"]>;
};

// On either side, in its first process or a repeat.
function isThrewRun(m: Measurement): m is ThrewRun {
  return m.phase === "paired" && m.threw !== undefined;
}

function isPairedRun(m: Measurement): m is PairedRun {
  return (
    m.phase === "paired" &&
    m.threw === undefined &&
    m.timing !== undefined &&
    m.paired !== undefined
  );
}

export function pairedRuns(doc: ProfileDocument): PairedRun[] {
  return doc.measurements.filter(isPairedRun);
}

export function threwRuns(doc: ProfileDocument): ThrewRun[] {
  return doc.measurements.filter(isThrewRun);
}

type AbRow =
  { kind: "timed"; run: PairedRun } | { kind: "threw"; run: ThrewRun };

export function abRows(doc: ProfileDocument): AbRow[] {
  const rows: AbRow[] = [];
  for (const m of doc.measurements) {
    if (isThrewRun(m)) rows.push({ kind: "threw", run: m });
    else if (isPairedRun(m)) rows.push({ kind: "timed", run: m });
  }
  return rows;
}

export function formatThrew(threw: ThrewRun["threw"]): string {
  return `${sideLabel(threw.side)} threw${threw.repeat ? ` (repeat ${threw.repeat})` : ""}`;
}

// A candidate/base ratio: `1.032` is `+3.2%`.
function formatRatio(ratio: number): string {
  return formatSignedPct((ratio - 1) * 100);
}

// Blank for unchanged; a flagged workload that fresh processes didn't
// reproduce reads `unconfirmed`. Repeats follow so the confirmation is
// visible. A changed suite with changed output reads `not comparable`.
function pairedVerdict(p: PairedEvidence, metric: AbSummary["metric"]): string {
  if (!comparable(p)) return "not comparable";
  if (!p.flagged) return "";
  const repeats = p.repeats?.length
    ? ` (repeats: ${p.repeats.map((r) => formatRatio(metricRatios(r, metric)?.medianRatio ?? Number.NaN)).join(", ")})`
    : "";
  if (p.confirmed === undefined) return `${p.flagged}${repeats}`;
  return `${p.confirmed ? `${p.flagged}, confirmed` : `${p.flagged}? unconfirmed`}${repeats}`;
}

export function formatNewSuites(ab: AbSummary): string | undefined {
  if (!ab.newSuites?.length) return undefined;
  return `New suite${ab.newSuites.length > 1 ? "s" : ""}, not at ${ab.base.ref}: ${ab.newSuites.join(", ")}`;
}

interface PairedCells {
  base: string;
  candidate: string;
  change: string;
  spread: string;
  also: string;
  verdict: string;
}

// `also` is the other metric's change (see `alsoHeader`), blank on a task
// without an instruction count.
export function pairedCells(
  run: PairedRun,
  metric: AbSummary["metric"],
): PairedCells {
  const p = run.paired;
  const i = p.instructions;
  const judged = metricRatios(p, metric);
  const other = metricRatios(p, metric === "time" ? "instructions" : "time");
  let base = "-";
  let candidate = "-";
  if (metric === "time") {
    const unit = pickDurationUnit(Math.min(p.baseMedianNs, run.timing.median));
    base = formatDuration(p.baseMedianNs, unit);
    candidate = formatDuration(run.timing.median, unit);
  } else if (i) {
    base = formatInstructions(i.baseMedian);
    candidate = formatInstructions(i.candMedian);
  }
  return {
    base,
    candidate,
    change: judged ? formatRatio(judged.medianRatio) : "",
    spread: judged
      ? `${formatRatio(judged.ratioP25)}…${formatRatio(judged.ratioP75)}`
      : "",
    also: other ? formatRatio(other.medianRatio) : "",
    verdict: pairedVerdict(p, metric),
  };
}

export function alsoHeader(
  doc: ProfileDocument,
  metric: AbSummary["metric"],
): string | undefined {
  if (metric === "instructions") return "Time";
  return doc.measurements.some((m) => m.paired?.instructions)
    ? "Instr"
    : undefined;
}

interface MemoryRow {
  run: PairedRun;
  reading: "retained/op" | "peak";
  change: MemoryChange;
}

export function memoryRows(doc: ProfileDocument): MemoryRow[] {
  return pairedRuns(doc).flatMap((run) => {
    const rows: MemoryRow[] = [];
    const { retained, peak } = run.paired;
    if (retained) rows.push({ run, reading: "retained/op", change: retained });
    if (peak) rows.push({ run, reading: "peak", change: peak });
    return rows;
  });
}

// No percent when the base is under the noise floor, where it would be
// huge and meaningless.
function formatByteChange(c: MemoryChange): string {
  const base = Math.round(c.baseBytes);
  const diff = Math.round(c.candBytes) - base;
  if (diff === 0) return "0B";
  const bytes = `${diff > 0 ? "+" : "-"}${formatBytes(Math.abs(diff))}`;
  if (base === 0 || c.baseBytes < c.floorBytes) return bytes;
  return `${bytes} (${formatSignedPct((diff / base) * 100)})`;
}

interface MemoryCells {
  reading: MemoryRow["reading"];
  base: string;
  candidate: string;
  change: string;
  verdict: string;
}

export function memoryCells({ reading, change: c }: MemoryRow): MemoryCells {
  return {
    reading,
    base: formatBytes(c.baseBytes),
    candidate: formatBytes(c.candBytes),
    change: formatByteChange(c),
    verdict: c.verdict === "unchanged" ? "" : c.verdict,
  };
}

export function formatAbHeader(ab: AbSummary): string {
  const metric = ab.metric === "instructions" ? " · by instructions/call" : "";
  const memory = ab.memory
    ? ` · memory threshold ${ab.memory.thresholdPct}%`
    : "";
  return `working tree vs ${ab.base.ref} (${ab.base.sha.slice(0, 7)}) · ${ab.rounds} rounds${metric} · threshold ${ab.thresholdPct}% · geomean threshold ${ab.geomeanThresholdPct}%${memory}`;
}

export function formatAbSummary(ab: AbSummary): string {
  const geomean =
    ab.geomeanPct === null
      ? "Geomean -"
      : `Geomean ${formatSignedPct(ab.geomeanPct)} (threshold ${ab.geomeanThresholdPct}%)`;
  const notes = [
    ab.unconfirmed > 0 && `${ab.unconfirmed} unconfirmed`,
    ab.notComparable > 0 && `${ab.notComparable} not comparable`,
    ab.threw > 0 && `${ab.threw} threw`,
  ].filter(Boolean);
  const unconfirmed = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  const memory = ab.memory
    ? ` · memory: ${ab.memory.regressed} regressed, ${ab.memory.improved} improved`
    : "";
  return `${geomean} · ${ab.regressed} regressed, ${ab.improved} improved, ${ab.unchanged} unchanged of ${ab.matched}${unconfirmed}${memory} · ${ab.verdict}`;
}

export function abNotes(doc: ProfileDocument): {
  outputDiffers: string[];
  baseOnly: string[];
  candOnly: string[];
} {
  const byId = workloadsById(doc);
  const label = (id: string) => labelOrId(byId.get(id), id);
  return {
    outputDiffers: pairedRuns(doc)
      .filter((m) => !m.paired.sameOutput)
      .map((m) => label(m.workloadId)),
    baseOnly: (doc.unmatched?.baseOnly ?? []).map(label),
    candOnly: (doc.unmatched?.candOnly ?? []).map(label),
  };
}
