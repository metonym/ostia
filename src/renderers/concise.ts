import { formatDuration, pickDurationUnit } from "../format.ts";
import type { ProfileDocument, Warning, Workload } from "../ir/types.ts";
import {
  formatRelative,
  formatShellLine,
  formatSignedPct,
  workloadLabel,
} from "./format.ts";
import { abRows, formatAbSummary, formatThrew, pairedCells } from "./paired.ts";
import { relativeRatios, type TimingRow } from "./relative.ts";
import {
  comparedRows,
  memoryReadings,
  noSampleRuns,
  oneSidedNote,
  runWarnings,
  timingRuns,
  workloadsById,
} from "./select.ts";
import type { Renderer, RenderResult } from "./types.ts";

// One line per command or task, and each warning on a short line after
// them: the fewest tokens that still read as text, for an agent or a
// person (metonym/ostia#54). `events` is the format a script parses.

// Each line's columns, padded so they line up.
function aligned(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    }
  }
  return rows.map((row) =>
    row
      .map((cell, i) =>
        i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
}

function warningLines(label: string, warnings: readonly Warning[]): string[] {
  return warnings.map((w) => `! ${label}: ${w.message}`);
}

function timingLines(doc: ProfileDocument): string[] {
  const memory = memoryReadings(doc);
  const byId = new Map(timingRuns(doc).map((run) => [run.workloadId, run]));
  const empty = new Map(noSampleRuns(doc).map((run) => [run.workloadId, run]));
  const measured: TimingRow[] = [];
  for (const workload of doc.workloads) {
    const run = byId.get(workload.id);
    if (run) measured.push({ run, workload });
  }
  const ratios = relativeRatios(measured);
  const rows: string[][] = [];
  const warnings: string[] = [];
  for (const workload of doc.workloads) {
    const label = workloadLabel(workload);
    const run = byId.get(workload.id);
    const noSamples = empty.get(workload.id);
    if (run) {
      const { median, mad } = run.timing;
      const unit = pickDurationUnit(median);
      const row = measured.find((r) => r.run === run);
      const ratio = row && ratios?.get(row);
      rows.push([
        label,
        formatDuration(median, unit),
        `±${(median === 0 ? 0 : (mad / median) * 100).toFixed(1)}%`,
        ratio === undefined ? "" : formatRelative(ratio, !!workload.baseline),
      ]);
      warnings.push(...warningLines(label, runWarnings(run, memory)));
    } else if (noSamples) {
      rows.push([label, "no samples"]);
      warnings.push(...warningLines(label, runWarnings(noSamples, memory)));
    } else if (workload.skipped) {
      rows.push([label, "skipped"]);
    }
  }
  return [...aligned(rows), ...warnings];
}

function comparisonLines(doc: ProfileDocument): string[] {
  const rows: string[][] = [];
  const notCompared: string[] = [];
  for (const { row } of comparedRows(doc)) {
    if (row.verdict === "missing-base" || row.verdict === "missing-cand") {
      notCompared.push(`- ${row.task}: ${oneSidedNote(row.verdict)}`);
      continue;
    }
    const mark = row.pass === false ? "✗" : "✓";
    if (!row.timing) {
      rows.push([`${mark} ${row.task}`, `(${row.verdict})`]);
      continue;
    }
    const { baseMedian, candMedian, medianDeltaPct } = row.timing;
    const unit = pickDurationUnit(Math.max(baseMedian, candMedian));
    rows.push([
      `${mark} ${row.task}`,
      `${formatDuration(baseMedian, unit)} -> ${formatDuration(candMedian, unit)}`,
      formatSignedPct(medianDeltaPct),
      `(${row.verdict})`,
    ]);
  }
  return [...aligned(rows), ...notCompared];
}

function abLines(
  doc: ProfileDocument,
  ab: NonNullable<ProfileDocument["ab"]>,
): string[] {
  const workloads = workloadsById(doc);
  const label = (id: string) => {
    const workload: Workload | undefined = workloads.get(id);
    return workload ? workloadLabel(workload) : id;
  };
  const rows: string[][] = [];
  for (const row of abRows(doc)) {
    if (row.kind === "threw") {
      rows.push([label(row.run.workloadId), formatThrew(row.run.threw)]);
      continue;
    }
    const cells = pairedCells(row.run, ab.metric);
    rows.push([
      label(row.run.workloadId),
      `${cells.base} -> ${cells.candidate}`,
      cells.change,
      cells.verdict,
    ]);
  }
  return [formatAbSummary(ab), ...aligned(rows)];
}

export const conciseRenderer: Renderer = {
  name: "concise",
  render(doc: ProfileDocument): Promise<RenderResult> {
    return Promise.try(() => {
      const lines = doc.ab
        ? abLines(doc, doc.ab)
        : [...timingLines(doc), ...comparisonLines(doc)];
      if (doc.shell) lines.push(formatShellLine(doc.shell));
      return { text: lines.length > 0 ? `${lines.join("\n")}\n` : "" };
    });
  },
};
