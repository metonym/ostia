// The pieces of the human (table) format that every command shares:
// numbers to three significant figures, the context line, a warning in
// words, and a table whose names shrink to fit 80 columns.

import type { Environment, TimingStats, Warning } from "../ir/types.ts";
import { percentile, sortedCopy } from "../stats/index.ts";
import {
  aligned,
  MEASURE,
  MISSING,
  NOTE_INDENT,
  type Paint,
  plural,
  SEPARATOR,
  signed,
  textWidth,
  truncateWords,
  withNotes,
} from "../terminal.ts";

// Three significant figures, so a column of numbers reads at one
// precision: 22.2, 248, 8.80.
function toSig3(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  return abs >= 100
    ? value.toFixed(0)
    : abs >= 10
      ? value.toFixed(1)
      : value.toFixed(2);
}

// Up a unit when rounding reaches 1000, since 999.7 µs should print
// 1.00 ms, not 1000 µs.
function scaled(
  value: number,
  units: readonly (readonly [string, number])[],
): string {
  if (!Number.isFinite(value)) return MISSING;
  const abs = Math.abs(value);
  let i = 0;
  while (i < units.length - 1 && abs >= (units[i + 1]?.[1] ?? Infinity)) i++;
  let [unit, size] = units[i] ?? ["", 1];
  let text = toSig3(value / size);
  const next = units[i + 1];
  if (next && Math.abs(Number(text)) >= 1000) {
    [unit, size] = next;
    text = toSig3(value / size);
  }
  return unit === "" ? text : `${text}${unit}`;
}

const DURATION_UNITS = [
  [" ns", 1],
  [" µs", 1e3],
  [" ms", 1e6],
  [" s", 1e9],
] as const;

const COUNT_UNITS = [
  ["", 1],
  ["K", 1e3],
  ["M", 1e6],
  ["G", 1e9],
] as const;

// invariant: every byte count ostia prints is 1024-based.
const BYTE_UNITS = [
  [" B", 1],
  [" KiB", 1024],
  [" MiB", 1024 ** 2],
  [" GiB", 1024 ** 3],
] as const;

export function toDuration(ns: number): string {
  return scaled(ns, DURATION_UNITS);
}

export function toCount(count: number): string {
  return count < 1000 ? String(Math.round(count)) : scaled(count, COUNT_UNITS);
}

export function toBytes(bytes: number): string {
  return Math.abs(bytes) < 1024
    ? `${Math.round(bytes)} B`
    : scaled(bytes, BYTE_UNITS);
}

export function toElapsed(ms: number): string {
  return toDuration(ms * 1e6);
}

export function toShare(pct: number): string {
  return `${toSig3(pct)}%`;
}

export function toTimes(ratio: number): string {
  return `${ratio < 1000 ? toSig3(ratio) : toCount(ratio)}×`;
}

const toPercent = (pct: number) =>
  `${Math.abs(pct) < 100 ? pct.toFixed(1) : pct.toFixed(0)}%`;

// The minus is ASCII, so a pasted change parses; zero has no sign.
export function toChange(pct: number): string {
  if (!Number.isFinite(pct)) return MISSING;
  // Past 10×, a multiple reads at a glance where +64237% doesn't.
  if (pct >= 900) return toTimes(1 + pct / 100);
  return Number(toPercent(pct).slice(0, -1)) === 0
    ? "0.0%"
    : signed(pct, toPercent);
}

// The median absolute deviation, since a long right tail would skew a
// standard deviation.
export function toNoise(mad: number, median: number): string {
  return median > 0 ? `±${toPercent((mad / median) * 100)}` : "";
}

export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const median = percentile(sortedCopy([...values]), 0.5);
  return percentile(sortedCopy(values.map((v) => Math.abs(v - median))), 0.5);
}

// The parts of a verdict that fit 80 columns: every required part, then
// the optional ones in order while they fit, so a long verdict drops its
// least telling counts rather than wrap.
export function fittedParts(
  parts: readonly { text: string; required?: boolean }[],
): string {
  let width = parts
    .filter((p) => p.required)
    .reduce((sum, p, i) => sum + textWidth(p.text) + (i > 0 ? 3 : 0), 0);
  return parts
    .filter((p) => {
      if (p.required) return true;
      const more = textWidth(p.text) + 3;
      if (width + more > MEASURE) return false;
      width += more;
      return true;
    })
    .map((p) => p.text)
    .join(SEPARATOR);
}

// The machine, since a number means little without where it ran.
export function environmentParts(env: Environment | undefined): string[] {
  if (!env) return [];
  return [
    env.cpuModel,
    `${env.cores} cores`,
    `load ${env.loadAvg1.toFixed(1)}`,
    `noise floor ${env.noise.floorPct.toFixed(1)}%`,
  ];
}

// The context, packed into as few dim lines as fit 80 columns, a part
// never split, so a long environment wraps between parts.
export function contextLines(parts: readonly string[], paint: Paint): string[] {
  const lines: string[] = [];
  let line = "";
  for (const part of parts.filter((p) => p !== "")) {
    const next = line === "" ? part : `${line}${SEPARATOR}${part}`;
    if (line !== "" && textWidth(next) > MEASURE) {
      lines.push(line);
      line = truncateWords(part, MEASURE);
    } else
      line = textWidth(next) > MEASURE ? truncateWords(next, MEASURE) : next;
  }
  if (line !== "") lines.push(line);
  return lines.map((l) => paint.dim(l));
}

type Tone = "good" | "warn" | "bad" | "dim";

export interface Note {
  text: string;
  tone: Tone;
}

// Tukey's fences, as `computeTimingStats` uses, so a note agrees with
// the count.
const OUTLIER_FENCE = 1.5;

// Whether the outliers move the median by more than the noise: the median
// with them dropped, against the median, past one MAD. The median shrugs
// off a few outliers, so a count alone says nothing; a shift past the
// noise is what makes the number wrong.
function isOutlierShifted(timing: TimingStats): boolean {
  const iqr = timing.p75 - timing.p25;
  const low = timing.p25 - OUTLIER_FENCE * iqr;
  const high = timing.p75 + OUTLIER_FENCE * iqr;
  const kept = timing.samples.filter((s) => s >= low && s <= high);
  if (kept.length === 0 || kept.length === timing.samples.length) return false;
  const median = percentile(sortedCopy(kept), 0.5);
  return Math.abs(median - timing.median) > Math.max(timing.mad, 0);
}

const numberIn = (data: Warning["data"], key: string): number | undefined => {
  const value = data?.[key];
  return typeof value === "number" ? value : undefined;
};

// A message as written for the JSON, without its full stop, so it reads
// as a note.
const asNote = (message: string) => message.replace(/\.$/, "");

// A warning in words, with its fix where there is one; `timing` decides
// whether outliers are a problem or an aside, since that turns on
// the samples.
export function toWarningNote(w: Warning, timing?: TimingStats): Note {
  const data = w.data;
  switch (w.code) {
    case "slow-first-run": {
      const firstNs = numberIn(data, "firstNs");
      const medianNs = numberIn(data, "medianNs");
      if (firstNs === undefined || medianNs === undefined || medianNs <= 0) {
        return { text: asNote(w.message), tone: "warn" };
      }
      return {
        text: `first run ${toDuration(firstNs)}, ${toTimes(firstNs / medianNs)} the median: add warmup`,
        tone: "warn",
      };
    }
    case "outliers-detected": {
      const mild = numberIn(data, "mild") ?? 0;
      const severe = numberIn(data, "severe") ?? 0;
      const shifted = timing !== undefined && isOutlierShifted(timing);
      return {
        text: `${plural(mild + severe, "outlier")}, ${severe} severe${shifted ? ", enough to move the median: a busy machine, or GC" : ": the median holds"}`,
        tone: shifted ? "warn" : "dim",
      };
    }
    case "fast-command":
      return { text: "under 5 ms: spawn overhead may dominate", tone: "dim" };
    case "nonzero-exit":
      return {
        text: `${asNote(w.message)}: --ignore-failure times them anyway`,
        tone: "bad",
      };
    case "timeout":
    case "time-source-no-match":
      return { text: asNote(w.message), tone: "bad" };
    case "noisy-machine": {
      const load = numberIn(data, "loadAvg1");
      const cores = numberIn(data, "cores");
      return load === undefined || cores === undefined
        ? { text: asNote(w.message), tone: "warn" }
        : {
            text: `load ${load.toFixed(1)} on ${cores} cores: timings may be noisy`,
            tone: "warn",
          };
    }
    case "jit-cold": {
      const slow =
        (numberIn(data, "llintPct") ?? 0) +
        (numberIn(data, "baselinePct") ?? 0);
      return {
        text: `${slow.toFixed(0)}% of samples in the slow tiers: the JIT never warmed it up`,
        tone: "warn",
      };
    }
    case "thin-comparison": {
      const base = numberIn(data, "baseSamples");
      const cand = numberIn(data, "candSamples");
      return {
        text: `only ${base ?? "?"} and ${cand ?? "?"} samples: judged by a threshold, not a CI`,
        tone: "warn",
      };
    }
    case "low-sample-count": {
      const samples = numberIn(data, "samples");
      const target = numberIn(data, "target");
      return samples === undefined || target === undefined
        ? { text: asNote(w.message), tone: "warn" }
        : {
            text: `only ${samples} samples, under the ${target} this cost needs: raise the budget`,
            tone: "warn",
          };
    }
    case "peak-hidden": {
      const slack = numberIn(data, "slackBytes");
      return slack === undefined
        ? { text: asNote(w.message), tone: "warn" }
        : {
            text: `may read up to ${toBytes(slack)} low: setup freed memory the call reused; skip it when OSTIA_PEAK_MEM is set`,
            tone: "warn",
          };
    }
    case "suite-changed":
      return {
        text: "the suite and its output both changed, so it isn't judged",
        tone: "dim",
      };
    case "skipped":
      return { text: asNote(w.message), tone: "dim" };
    case "aborted":
    case "artifact-missing":
    case "empty-profile":
    case "environment-mismatch":
      return { text: asNote(w.message), tone: "warn" };
  }
}

// Shown once, under the table, since they're about the run, not a row.
export const RUN_WARNINGS: ReadonlySet<string> = new Set([
  "noisy-machine",
  "aborted",
  "environment-mismatch",
]);

const paintTone = (paint: Paint, tone: Tone): ((s: string) => string) =>
  tone === "good"
    ? paint.good
    : tone === "warn"
      ? paint.warn
      : tone === "bad"
        ? paint.bad
        : paint.dim;

// A note wrapped at a word to fit 80 columns, each line at its indent:
// a note is read whole, so it isn't cut.
export function noteLines(note: Note, indent: string, paint: Paint): string[] {
  const room = MEASURE - indent.length;
  const lines: string[] = [];
  let line = "";
  for (const word of note.text.split(" ")) {
    if (line !== "" && textWidth(`${line} ${word}`) > room) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines.map((l) => `${indent}${paintTone(paint, note.tone)(l)}`);
}

/** One row of a named table: its label, then its cells. */
export interface NamedRow {
  /** `├ ` or `└ ` under a group, else empty. */
  branch: string;
  name: string;
  /** Bold for a group's label row; plain for a task. */
  bold?: boolean;
  cells: readonly string[];
  notes?: readonly Note[];
}

const MIN_NAME_WIDTH = 12;

// The table's names cut at a word to fit 80 columns, since the numbers
// can't shrink; notes under a row indent past its branch.
export function namedTable(
  header: readonly string[],
  rows: readonly NamedRow[],
  rightColumns: readonly number[],
  paint: Paint,
): string[] {
  const widths = header
    .slice(1)
    .map((cell, i) =>
      Math.max(
        textWidth(cell),
        ...rows.map((row) => textWidth(row.cells[i] ?? "")),
      ),
    );
  const used = widths.filter((w) => w > 0);
  const room = Math.max(
    MIN_NAME_WIDTH,
    MEASURE - 2 - used.reduce((sum, w) => sum + w + 2, 0),
  );
  const table: string[][] = [[...header]];
  const notes = new Map<number, string[]>();
  for (const row of rows) {
    const name = truncateWords(row.name, room - textWidth(row.branch));
    table.push([
      `${row.branch}${row.bold ? paint.bold(name) : name}`,
      ...row.cells,
    ]);
    if (row.notes?.length) {
      const indent = row.branch === "" ? NOTE_INDENT : `  ${NOTE_INDENT}`;
      notes.set(
        table.length - 1,
        row.notes.flatMap((note) => noteLines(note, indent, paint)),
      );
    }
  }
  return withNotes(aligned(table, rightColumns, paint.dim), notes);
}
