// The human format, for a person at a terminal: the verdict first, a dim
// line of context, the table, then a closing line that says what ran and
// what it cost. Color comes from `paint`, which the CLI gives only to a
// terminal no coding agent reads.

import { isAbsolute, relative } from "node:path";

import type { Unpaired } from "../ab/unpaired.ts";
import { cpuSampleCount } from "../ir/cpu.ts";
import type {
  AbSummary,
  ComparedTask,
  Comparison,
  GitMetadata,
  Measurement,
  ProfileDocument,
  Workload,
} from "../ir/types.ts";
import { comparable, metricRatios } from "../measure/paired.ts";
import {
  branch,
  closingLine,
  failLine,
  headerRow,
  MEASURE,
  MISSING,
  type Paint,
  PLAIN,
  plural,
  SEPARATOR,
  textWidth,
  truncatePath,
  truncateWords,
} from "../terminal.ts";
import { cpuTimes, labelOrId, topSelfFrames, workloadLabel } from "./format.ts";
import {
  contextLines,
  environmentParts,
  fittedParts,
  medianAbsoluteDeviation,
  type NamedRow,
  namedTable,
  type Note,
  noteLines,
  numberIn,
  RUN_WARNINGS,
  toBytes,
  toChange,
  toCount,
  toDuration,
  toElapsed,
  toNoise,
  toShare,
  toTimes,
  toWarningNote,
} from "./human.ts";
import { abNotes, abRows, formatThrew, type PairedRun } from "./paired.ts";
import { groupOf, labelInGroup, relativeRatios } from "./relative.ts";
import {
  comparedRows,
  environmentMismatch,
  memoryReadings,
  noSampleRuns,
  oneSidedNote,
  rowComparisonWarnings,
  runWarnings,
  shownFrameDeltas,
  shownHeapDeltas,
  type TimingRun,
  timingRuns,
  workloadsById,
} from "./select.ts";
import type { Renderer, RenderResult } from "./types.ts";

const TOP_FRAMES = 5;
const TOP_TYPES = 5;
// The longest a name may run in a verdict line, so two fit on one line;
// a line that names one gives it more.
const VERDICT_NAME_WIDTH = 30;
const VERDICT_ONE_NAME_WIDTH = 40;
// Heap readings move with GC timing, so a small change is noise, not
// a note.
const MIN_MEMORY_NOTE_PCT = 10;

/** What the table renderer needs beyond the document, all optional. */
export interface TableOptions {
  /** Color; plain when absent, as for a pipe or a file. */
  paint?: Paint;
  /** What was run (suite files), for the context line. */
  ran?: string;
  /** The command's wall time, for the closing line. */
  elapsedMs?: number;
  /** `compare`: where its thresholds came from, and each side's git state. */
  compare?: {
    thresholds: string;
    baseGit?: GitMetadata | undefined;
    candGit?: GitMetadata | undefined;
  };
  /** `ab` that paired nothing: each side's task count, and why. */
  unpaired?: Unpaired;
  /** `ci`: the baseline it gated against, and what the cache saved. */
  ci?: {
    baseline: string;
    workloads: number;
    cached: number;
    executed: number;
    /** Workloads that failed to measure. */
    failed: readonly string[];
    missingBaseline: number;
  };
}

interface Report {
  verdict: string;
  context: string[];
  /** The table, then any further blocks, each set off by a blank line. */
  blocks: string[][];
  closing: string;
}

export const terminalRenderer: Renderer<TableOptions> = {
  name: "table",
  render(doc: ProfileDocument, options: TableOptions): Promise<RenderResult> {
    return Promise.try(() => {
      const report = toReport(doc, options, options.paint ?? PLAIN);
      if (!report) return { text: "nothing measured\n" };
      const instrumented = instrumentedBlocks(doc, options.paint ?? PLAIN);
      const blocks = [...report.blocks, ...instrumented].filter(
        (block) => block.length > 0,
      );
      const lines = [
        report.verdict,
        ...report.context,
        ...blocks.flatMap((block) => ["", ...block]),
        "",
        report.closing,
      ];
      return { text: `${lines.map((l) => l.trimEnd()).join("\n")}\n` };
    });
  },
};

function toReport(
  doc: ProfileDocument,
  options: TableOptions,
  paint: Paint,
): Report | undefined {
  // Only `ab()` writes paired measurements, and it always stamps `ab`.
  if (doc.ab) return pairedReport(doc, doc.ab, options, paint);
  if (options.ci || options.compare || comparedRows(doc).length > 0) {
    return comparisonReport(doc, options, paint);
  }
  const rows = timingRows(doc);
  if (rows.length > 0) return timingReport(doc, rows, options, paint);
  if (doc.measurements.length > 0) return instrumentedReport(doc, paint);
  return undefined;
}

// A failure's closing line, with the next step after it when the two fit
// 80 columns, else on a dim line of its own, whole, since a command cut
// short can't be pasted.
function failWith(paint: Paint, what: string, next: string): string {
  const line = failLine(paint, what, next);
  if (textWidth(line) <= MEASURE) return line;
  return [failLine(paint, what), ...wrapWords(next, MEASURE - 2)]
    .map((text, i) => (i === 0 ? text : paint.dim(`  ${text}`)))
    .join("\n");
}

// Lines of at most `width` columns, broken between words, so a long next
// step stays inside the measure instead of running off it.
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && textWidth(`${line} ${word}`) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  return line === "" ? lines : [...lines, line];
}

const elapsedPart = (options: TableOptions) =>
  options.elapsedMs === undefined ? "" : ` in ${toElapsed(options.elapsedMs)}`;

const shortName = (name: string, width = VERDICT_NAME_WIDTH) =>
  truncateWords(name, width);

// Once each, under the table, since they're about the machine or the run,
// not any one row.
function runNotes(doc: ProfileDocument, paint: Paint): string[] {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const m of doc.measurements) {
    for (const w of m.warnings) {
      if (!RUN_WARNINGS.has(w.code) || w.code === "aborted") continue;
      if (seen.has(w.code)) continue;
      seen.add(w.code);
      notes.push(...noteLines(toWarningNote(w), "  ", paint));
    }
  }
  return notes;
}

const isAborted = (doc: ProfileDocument) =>
  doc.measurements.some((m) => m.warnings.some((w) => w.code === "aborted"));

// A row's place in its group, so the group's label prints once, above
// its first row, and its last row closes it with └.
function grouped<T extends { group: string | undefined }>(
  items: readonly T[],
): { item: T; branch: string; label?: string }[] {
  return items.map((item, i) => {
    if (item.group === undefined) return { item, branch: "" };
    let start = i;
    while (start > 0 && items[start - 1]?.group === item.group) start--;
    let end = i;
    while (end < items.length - 1 && items[end + 1]?.group === item.group) {
      end++;
    }
    return {
      item,
      branch: branch(i - start, end - start + 1),
      ...(i === start && { label: item.group }),
    };
  });
}

// A group's label prints once, above its first task, so its rows can
// drop the group from their names.
function withGroupLabels(
  rows: { branch: string; label?: string; row: NamedRow }[],
  columns: number,
): NamedRow[] {
  return rows.flatMap(({ label, row }) =>
    label === undefined
      ? [row]
      : [
          {
            branch: "",
            name: label,
            bold: true,
            cells: Array.from({ length: columns }, () => ""),
          },
          row,
        ],
  );
}

const relativeFile = (file: string) =>
  isAbsolute(file) ? relative(process.cwd(), file) : file;

// --filter takes a regex, so a task's name matches as written.
const filterFor = (label: string) =>
  `'${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "'\\''")}'`;

// The suite a task came from, so the next step is a command a person
// can paste.
const suiteOf = (workload: Workload | undefined) =>
  workload?.entry ? ` ${relativeFile(workload.entry.file)}` : "";

// --- time and bench ---

interface TimingRowItem {
  workload: Workload;
  group: string | undefined;
  run?: TimingRun;
  /** A run whose every trial failed, timed out or missed `timeSource`. */
  empty?: Measurement;
}

function timingRows(doc: ProfileDocument): TimingRowItem[] {
  const runs = new Map(timingRuns(doc).map((r) => [r.workloadId, r]));
  const empty = new Map(noSampleRuns(doc).map((r) => [r.workloadId, r]));
  // Workload order, so a skipped task prints in its group's place.
  return doc.workloads.flatMap((workload): TimingRowItem[] => {
    const run = runs.get(workload.id);
    const none = empty.get(workload.id);
    const group = groupOf(workload);
    if (run) return [{ workload, group, run }];
    if (none) return [{ workload, group, empty: none }];
    if (workload.skipped) return [{ workload, group }];
    return [];
  });
}

const isFailedRow = (row: TimingRowItem) =>
  row.empty !== undefined ||
  (row.run?.warnings.some((w) => w.code === "nonzero-exit") ?? false);

function timingReport(
  doc: ProfileDocument,
  rows: TimingRowItem[],
  options: TableOptions,
  paint: Paint,
): Report {
  const commands = doc.workloads.every((w) => w.kind === "subprocess");
  const noun = commands ? "command" : "task";
  const memory = memoryReadings(doc);
  const measured = rows.flatMap((row) =>
    row.run ? [{ ...row, run: row.run }] : [],
  );
  const ratios = relativeRatios(measured);
  const ratioById = new Map(
    [...(ratios ?? [])].map(([row, ratio]) => [row.workload.id, ratio]),
  );
  const times = new Map(
    measured.map((row) => [row.workload.id, cpuTimes(row.run)]),
  );
  const hasTimes = [...times.values()].some(Boolean);
  const hasInstructions = measured.some((row) => row.run.instructions);
  const hasRetained = [...memory.values()].some(
    (r) => r.retained !== undefined,
  );
  const hasPeak = [...memory.values()].some((r) => r.peak !== undefined);
  const hasBaseline = measured.some((row) => row.workload.baseline);

  const header = [
    noun,
    "median",
    "noise",
    ...(hasTimes ? ["user", "sys"] : []),
    ...(hasInstructions ? ["instr/call"] : []),
    ...(hasRetained ? ["retained/op"] : []),
    ...(hasPeak ? ["peak mem"] : []),
    ...(ratios ? [hasBaseline ? "vs baseline" : "vs fastest"] : []),
  ];

  let warnings = 0;
  const named = grouped(rows).map(({ item: row, branch, label }) => {
    const name = labelInGroup(workloadLabel(row.workload), row.group);
    const run = row.run;
    const readings = memory.get(row.workload.id);
    const blanks = header.length - 2;
    const status = run
      ? undefined
      : row.empty
        ? paint.bad("no samples")
        : paint.dim("skipped");
    const cells = run
      ? [
          toDuration(run.timing.median),
          paint.dim(toNoise(run.timing.mad, run.timing.median)),
          ...(hasTimes ? timesCells(times.get(row.workload.id)) : []),
          ...(hasInstructions
            ? [run.instructions ? toCount(run.instructions.median) : ""]
            : []),
          ...(hasRetained
            ? [
                readings?.retained === undefined
                  ? ""
                  : toBytes(readings.retained),
              ]
            : []),
          ...(hasPeak
            ? [readings?.peak === undefined ? "" : toBytes(readings.peak)]
            : []),
          ...(ratios
            ? [ratioCell(ratioById.get(row.workload.id), row.workload, paint)]
            : []),
        ]
      : [status ?? "", ...Array.from({ length: blanks }, () => "")];
    const source = run ?? row.empty;
    const notes: Note[] = source
      ? runWarnings(source, memory)
          .filter((w) => !RUN_WARNINGS.has(w.code))
          .map((w) => toWarningNote(w, run?.timing))
      : [];
    warnings += notes.filter((n) => n.tone !== "dim").length;
    return {
      branch,
      ...(label !== undefined && { label }),
      row: { branch, name, cells, notes },
    };
  });

  const failedCount = rows.filter(isFailedRow).length;
  const run = runNotes(doc, paint);
  warnings += run.length;
  const table = namedTable(
    headerRow(paint, header),
    withGroupLabels(named, header.length - 1),
    header.map((_, i) => i).slice(1),
    paint,
  );
  return {
    // A failed run's timings aren't the answer, so the failure leads.
    verdict:
      failedCount > 0
        ? paint.bad(`${failedCount} of ${plural(rows.length, noun)} failed`)
        : commands
          ? timeVerdict(measured, rows.length, paint)
          : benchVerdict(measured, rows.length, warnings, paint),
    context: contextLines(
      [
        ...environmentParts(doc.environment),
        ...(doc.shell
          ? [
              `${doc.shell.command} -c adds ${toDuration(doc.shell.startupNs)} to each`,
            ]
          : []),
        options.ran ?? (commands ? runsPart(measured) : ""),
      ],
      paint,
    ),
    blocks: [table, run],
    closing: timingClosing(doc, rows, measured, noun, options, paint),
  };
}

function timesCells(
  times: { userNs: number; systemNs: number } | undefined,
): string[] {
  return times
    ? [toDuration(times.userNs), toDuration(times.systemNs)]
    : ["", ""];
}

// The reference row says what it is, dim; a faster row says so, since a
// bare ratio under 1 reads as slower.
function ratioCell(
  ratio: number | undefined,
  workload: Workload,
  paint: Paint,
): string {
  if (ratio === undefined) return "";
  if (workload.baseline) return paint.dim("baseline");
  if (ratio === 1) return paint.dim("fastest");
  return ratio < 1 ? `${toTimes(1 / ratio)} faster` : toTimes(ratio);
}

function runsPart(measured: readonly { run: TimingRun }[]): string {
  const counts = measured.map((row) => row.run.trials.length);
  if (counts.length === 0) return "";
  const least = Math.min(...counts);
  const most = Math.max(...counts);
  if (least === most) {
    return counts.length === 1
      ? `median of ${plural(least, "run")}`
      : `median of ${plural(least, "run")} each`;
  }
  return `median of ${least} to ${most} runs`;
}

type MeasuredRow = TimingRowItem & { run: TimingRun };

const nameOf = (row: MeasuredRow) =>
  labelInGroup(workloadLabel(row.workload), row.group);

// Which command is faster, and by how much; "within noise" when the gap
// is under twice the larger MAD, since then a rerun could flip it.
function timeVerdict(
  measured: readonly MeasuredRow[],
  total: number,
  paint: Paint,
): string {
  const sorted = [...measured].sort(
    (a, b) => a.run.timing.median - b.run.timing.median,
  );
  const [first, second] = sorted;
  if (!first) return `${plural(total, "command")}${SEPARATOR}none measured`;
  const a = paint.bold(shortName(nameOf(first)));
  if (!second) return `${a} takes ${toDuration(first.run.timing.median)}`;
  const b = paint.bold(shortName(nameOf(second)));
  const gap = second.run.timing.median - first.run.timing.median;
  const noise = 2 * Math.max(first.run.timing.mad, second.run.timing.mad);
  const more =
    sorted.length > 2 ? `${SEPARATOR}fastest of ${sorted.length}` : "";
  if (gap < noise) return `${a} and ${b} are within noise${more}`;
  const ratio = second.run.timing.median / first.run.timing.median;
  return `${a} is ${toTimes(ratio)} faster than ${b}${more}`;
}

function benchVerdict(
  measured: readonly MeasuredRow[],
  total: number,
  warnings: number,
  paint: Paint,
): string {
  const warned =
    warnings > 0
      ? `${SEPARATOR}${paint.warn(plural(warnings, "warning"))}`
      : "";
  const fastest = measured.reduce<MeasuredRow | undefined>(
    (best, row) =>
      best === undefined || row.run.timing.median < best.run.timing.median
        ? row
        : best,
    undefined,
  );
  if (!fastest)
    return `${plural(total, "task")}${SEPARATOR}none measured${warned}`;
  const name = paint.bold(shortName(nameOf(fastest), VERDICT_ONE_NAME_WIDTH));
  const time = toDuration(fastest.run.timing.median);
  if (total === 1) return `${name} takes ${time}${warned}`;
  return `${plural(total, "task")}${SEPARATOR}fastest ${name} ${time}${warned}`;
}

function timingClosing(
  doc: ProfileDocument,
  rows: readonly TimingRowItem[],
  measured: readonly MeasuredRow[],
  noun: "command" | "task",
  options: TableOptions,
  paint: Paint,
): string {
  if (isAborted(doc)) {
    return failWith(
      paint,
      "Cancelled",
      `${measured.length} of ${plural(rows.length, noun)} measured`,
    );
  }
  const failed = rows.filter(isFailedRow);
  const first = failed[0];
  if (first) {
    const names = failed.map((row) =>
      labelInGroup(workloadLabel(row.workload), row.group),
    );
    const codes = new Set(
      (first.run ?? first.empty)?.warnings.map((w) => w.code) ?? [],
    );
    const next = codes.has("time-source-no-match")
      ? "check --time-source against --show-output"
      : codes.has("timeout")
        ? "raise --timeout"
        : "see why with --show-output";
    return failWith(
      paint,
      `${plural(failed.length, noun)} failed: ${truncateWords(names.join(", "), 40)}`,
      next,
    );
  }
  const elapsed = elapsedPart(options);
  if (noun === "command") {
    const runs = measured.reduce((sum, row) => sum + row.run.trials.length, 0);
    return closingLine(
      paint,
      `Timed ${plural(rows.length, "command")}`,
      `${plural(runs, "run")}${elapsed}`,
    );
  }
  const samples = measured.reduce(
    (sum, row) => sum + row.run.timing.samples.length,
    0,
  );
  return closingLine(
    paint,
    `Measured ${plural(rows.length, "task")}`,
    `${toCount(samples)} ${samples === 1 ? "sample" : "samples"}${elapsed}`,
  );
}

// --- ab ---

type Flagged = { label: string; workload: Workload | undefined; what: string };

function pairedReport(
  doc: ProfileDocument,
  ab: AbSummary,
  options: TableOptions,
  paint: Paint,
): Report {
  const byWorkload = workloadsById(doc);
  const metric = ab.metric;
  const hasAlso =
    metric === "instructions" ||
    doc.measurements.some((m) => m.paired?.instructions);
  const header = [
    "task",
    "base",
    "candidate",
    "change",
    "noise",
    ...(hasAlso ? [metric === "time" ? "instr" : "time"] : []),
    "verdict",
  ];
  const regressed: Flagged[] = [];
  const threw: Flagged[] = [];
  const memoryRegressed: Flagged[] = [];

  const items = abRows(doc).map((entry) => {
    const workload = byWorkload.get(entry.run.workloadId);
    return { entry, workload, group: groupOf(workload) };
  });
  const named = grouped(items).map(({ item, branch, label }) => {
    const { entry, workload } = item;
    const fullName = labelOrId(workload, entry.run.workloadId);
    const name = labelInGroup(fullName, item.group);
    let cells: string[];
    const notes: Note[] = [];
    if (entry.kind === "threw") {
      const side = entry.run.threw.side;
      const word = formatThrew(entry.run.threw);
      if (side === "cand") {
        threw.push({ label: fullName, workload, what: "throws" });
      }
      cells = [
        "",
        "",
        "",
        "",
        ...(hasAlso ? [""] : []),
        side === "cand" ? paint.bad(word) : paint.warn(word),
      ];
      const [message] = entry.run.threw.message.split("\n");
      notes.push({ text: `${word}: ${message ?? ""}`, tone: "dim" });
    } else {
      cells = pairedCells(entry.run, metric, hasAlso, paint);
      const p = entry.run.paired;
      if (p.verdict === "regressed" && comparable(p)) {
        const judged = metricRatios(p, metric);
        regressed.push({
          label: fullName,
          workload,
          what: `regressed ${judged ? toChange((judged.medianRatio - 1) * 100) : ""}`.trim(),
        });
      }
      notes.push(...pairedNotes(entry.run, metric));
      for (const [reading, change] of [
        ["retained/op", p.retained],
        ["peak", p.peak],
      ] as const) {
        if (!change) continue;
        const pct =
          change.baseBytes > 0
            ? ((change.candBytes - change.baseBytes) / change.baseBytes) * 100
            : Number.NaN;
        // An unjudged reading that barely moved is noise, not a note.
        if (
          change.verdict === "unchanged" &&
          !(Math.abs(pct) >= MIN_MEMORY_NOTE_PCT)
        ) {
          continue;
        }
        notes.push({
          text: `${reading} ${toBytes(change.baseBytes)} → ${toBytes(change.candBytes)}${Number.isFinite(pct) ? ` (${toChange(pct)})` : ""}${change.verdict === "unchanged" ? "" : ` ${change.verdict}`}`,
          tone:
            change.verdict === "regressed"
              ? "bad"
              : change.verdict === "improved"
                ? "good"
                : "dim",
        });
        if (change.verdict === "regressed") {
          memoryRegressed.push({
            label: fullName,
            workload,
            what: `${reading} regressed`,
          });
        }
      }
      for (const w of entry.run.warnings) {
        if (RUN_WARNINGS.has(w.code)) continue;
        if (w.code === "suite-changed" && comparable(p)) continue;
        // pairedNotes says it beside the repeats.
        if (w.code === "repeats-disagree") continue;
        notes.push(toWarningNote(w, entry.run.timing));
      }
    }
    return {
      branch,
      ...(label !== undefined && { label }),
      row: { branch, name, cells, notes },
    };
  });

  const table =
    named.length > 0
      ? namedTable(
          headerRow(paint, header),
          withGroupLabels(named, header.length - 1),
          header.map((_, i) => i).slice(1, -1),
          paint,
        )
      : [];

  const notes = abNotes(doc);
  const after: string[] = [
    ...(ab.newSuites?.length
      ? [
          paint.dim(
            truncateWords(
              `  ${ab.newSuites.length > 1 ? "new suites" : "new suite"}, not at ${ab.base.ref}: ${ab.newSuites.join(", ")}`,
              MEASURE,
            ),
          ),
        ]
      : []),
    ...(notes.baseOnly.length > 0
      ? [
          paint.dim(
            truncateWords(`  base only: ${notes.baseOnly.join(", ")}`, MEASURE),
          ),
        ]
      : []),
    ...(notes.candOnly.length > 0
      ? [
          paint.dim(
            truncateWords(
              `  candidate only: ${notes.candOnly.join(", ")}`,
              MEASURE,
            ),
          ),
        ]
      : []),
    ...runNotes(doc, paint),
  ];

  return {
    verdict: abVerdict(ab, paint),
    context: contextLines(
      [
        ...environmentParts(doc.environment),
        `${ab.base.ref} ${ab.base.sha.slice(0, 7)} vs working tree`,
        `${ab.rounds} rounds`,
        ...(metric === "instructions" ? ["by instructions/call"] : []),
        `thresholds ${ab.thresholdPct}%, geomean ${ab.geomeanThresholdPct}%`,
        ...(ab.memory ? [`memory threshold ${ab.memory.thresholdPct}%`] : []),
      ],
      paint,
    ),
    blocks: [table, after],
    closing: abClosing(
      ab,
      { regressed, threw, memoryRegressed },
      options,
      paint,
    ),
  };
}

// The gate's verdict, colored, since here a change is judged: pass, or
// what regressed and what improved.
function abVerdict(ab: AbSummary, paint: Paint): string {
  if (ab.matched + ab.threw === 0) return paint.bad("nothing paired");
  const geomeanOver =
    ab.geomeanPct !== null && ab.geomeanPct > ab.geomeanThresholdPct;
  const geomean =
    ab.geomeanPct === null ? "" : `geomean ${toChange(ab.geomeanPct)}`;
  const memory = ab.memory;
  return fittedParts([
    {
      text: ab.verdict === "pass" ? paint.good("pass") : paint.bad("fail"),
      required: true,
    },
    ...(ab.regressed > 0
      ? [{ text: paint.bad(`${ab.regressed} regressed`), required: true }]
      : []),
    ...(ab.improved > 0
      ? [{ text: paint.good(`${ab.improved} improved`), required: true }]
      : []),
    ...(ab.threw > 0 ? [{ text: `${ab.threw} threw`, required: true }] : []),
    ...(geomean === ""
      ? []
      : [
          {
            text: geomeanOver ? paint.bad(geomean) : geomean,
            required: geomeanOver,
          },
        ]),
    ...(memory && memory.regressed + memory.improved > 0
      ? [
          {
            text:
              memory.regressed > 0
                ? paint.bad(`memory ${memory.regressed} regressed`)
                : paint.good(`memory ${memory.improved} improved`),
            required: memory.regressed > 0,
          },
        ]
      : []),
    { text: `${ab.unchanged} unchanged` },
    ...(ab.unconfirmed > 0 ? [{ text: `${ab.unconfirmed} unconfirmed` }] : []),
    ...(ab.notComparable > 0
      ? [{ text: `${ab.notComparable} not comparable` }]
      : []),
  ]);
}

function pairedCells(
  run: PairedRun,
  metric: AbSummary["metric"],
  hasAlso: boolean,
  paint: Paint,
): string[] {
  const p = run.paired;
  const i = p.instructions;
  const judged = metricRatios(p, metric);
  const other = metricRatios(p, metric === "time" ? "instructions" : "time");
  const ratios = metric === "time" ? p.ratios : (i?.ratios ?? []);
  const [base, candidate] =
    metric === "time"
      ? [toDuration(p.baseMedianNs), toDuration(run.timing.median)]
      : i
        ? [toCount(i.baseMedian), toCount(i.candMedian)]
        : [MISSING, MISSING];
  const mad = medianAbsoluteDeviation(ratios);
  const changePct = judged ? (judged.medianRatio - 1) * 100 : Number.NaN;
  const noisePct = (mad / (judged?.medianRatio ?? 1)) * 100;
  // A change inside the noise reads ~0, so a person doesn't chase it.
  const change = !judged
    ? ""
    : Math.abs(changePct) < noisePct
      ? "~0%"
      : toChange(changePct);
  const paintChange =
    !comparable(p) || p.verdict === "unchanged"
      ? (s: string) => s
      : p.verdict === "regressed"
        ? paint.bad
        : paint.good;
  return [
    base,
    candidate,
    paintChange(change),
    judged ? paint.dim(toNoise(mad, judged.medianRatio)) : "",
    ...(hasAlso ? [other ? toChange((other.medianRatio - 1) * 100) : ""] : []),
    pairedVerdict(run, paint),
  ];
}

function pairedVerdict(run: PairedRun, paint: Paint): string {
  const p = run.paired;
  if (!comparable(p)) return paint.dim("not comparable");
  if (p.verdict === "regressed") return paint.bad("regressed");
  if (p.verdict === "improved") return paint.good("improved");
  // Flagged here, but a fresh process disagreed.
  if (p.flagged) return paint.dim(`${p.flagged}?`);
  return "";
}

function pairedNotes(run: PairedRun, metric: AbSummary["metric"]): Note[] {
  const p = run.paired;
  const notes: Note[] = [];
  if (p.repeats?.length) {
    const changes = p.repeats.map((r) => {
      const ratio = metricRatios(r, metric)?.medianRatio;
      return ratio === undefined ? MISSING : toChange((ratio - 1) * 100);
    });
    const apart = numberIn(
      run.warnings.find((w) => w.code === "repeats-disagree")?.data,
      "factor",
    );
    if (apart === undefined) {
      notes.push({ text: `repeats ${changes.join(", ")}`, tone: "dim" });
    } else {
      notes.push(
        {
          text: `repeats ${changes.join(", ")}: ${toTimes(apart)} apart from the paired run`,
          tone: "warn",
        },
        {
          text: "another task in this process may shape it; --filter to measure it alone",
          tone: "dim",
        },
      );
    }
  }
  // A changed suite whose output changed says so in its verdict.
  if (!p.sameOutput && comparable(p)) {
    notes.push({ text: "output differs from the base", tone: "dim" });
  }
  return notes;
}

function abClosing(
  ab: AbSummary,
  flagged: {
    regressed: readonly Flagged[];
    threw: readonly Flagged[];
    memoryRegressed: readonly Flagged[];
  },
  options: TableOptions,
  paint: Paint,
): string {
  if (ab.matched + ab.threw === 0) {
    return options.unpaired
      ? failWith(paint, options.unpaired.what, options.unpaired.next)
      : failWith(paint, "Nothing paired", "no task is on both sides");
  }
  if (ab.verdict === "pass") {
    return closingLine(
      paint,
      "A/B passes",
      `${plural(ab.matched, "task")} paired${elapsedPart(options)}`,
    );
  }
  const what = (list: readonly Flagged[]) => {
    const [first] = list;
    if (!first) return "";
    const more = list.length > 1 ? ` and ${list.length - 1} more` : "";
    return `${shortName(first.label)} ${first.what}${more}`;
  };
  const [regressed] = flagged.regressed;
  if (regressed) {
    return failWith(
      paint,
      `A/B fails: ${what(flagged.regressed)}`,
      `profile it: ostia bench${suiteOf(regressed.workload)} --cpu --filter ${filterFor(regressed.label)}`,
    );
  }
  const [threw] = flagged.threw;
  if (threw) {
    return failWith(
      paint,
      `A/B fails: ${what(flagged.threw)}`,
      `run it: ostia bench${suiteOf(threw.workload)} --filter ${filterFor(threw.label)}`,
    );
  }
  const [memory] = flagged.memoryRegressed;
  if (memory) {
    return failWith(
      paint,
      `A/B fails: ${what(flagged.memoryRegressed)}`,
      `measure it: ostia bench${suiteOf(memory.workload)} --alloc --peak-mem --filter ${filterFor(memory.label)}`,
    );
  }
  return failWith(
    paint,
    `A/B fails: geomean ${toChange(ab.geomeanPct ?? 0)}, over ${ab.geomeanThresholdPct}%`,
    ab.unconfirmed > 0
      ? "recheck the unconfirmed tasks with a higher --confirm"
      : `a broad slowdown, no one task past ${ab.thresholdPct}%`,
  );
}

// --- compare and ci ---

const MEMORY_LABELS: Record<
  NonNullable<ComparedTask["memory"]>[number]["reading"],
  string
> = {
  heapUsedBefore: "heap used before",
  heapUsedAfter: "heap used after",
  retained: "retained/op",
  peak: "peak",
  maxRss: "max RSS",
};

function comparisonReport(
  doc: ProfileDocument,
  options: TableOptions,
  paint: Paint,
): Report {
  const rows = comparedRows(doc);
  const header = ["task", "base", "candidate", "change", "verdict"];
  const regressed: ComparedTask[] = [];
  const items = rows.map((entry) => ({ ...entry, group: entry.row.group }));
  const named = grouped(items).map(({ item, branch, label }) => {
    const { row, cmp } = item;
    const name = labelInGroup(row.task, row.group);
    const notes: Note[] = [];
    let cells: string[];
    if (row.verdict === "missing-base" || row.verdict === "missing-cand") {
      const note = oneSidedNote(row.verdict);
      const word = note.slice(0, note.indexOf(" ("));
      cells = ["", "", "", paint.dim(word)];
      notes.push({
        text: note.slice(word.length + 2, -1).replace(/`/g, ""),
        tone: "dim",
      });
    } else {
      if (row.pass === false) regressed.push(row);
      cells = comparedCells(row, paint);
      notes.push(...comparedNotes(row, cmp));
    }
    return {
      branch,
      ...(label !== undefined && { label }),
      row: { branch, name, cells, notes },
    };
  });
  const table = namedTable(
    headerRow(paint, header),
    withGroupLabels(named, header.length - 1),
    [1, 2, 3],
    paint,
  );
  const mismatch = environmentMismatch(doc);
  const after = [
    ...(mismatch ? noteLines(toWarningNote(mismatch), "  ", paint) : []),
    ...runNotes(doc, paint),
  ];
  return {
    verdict: comparedVerdict(doc, rows, options, paint),
    context: contextLines(
      [...environmentParts(doc.environment), ...compareContext(doc, options)],
      paint,
    ),
    blocks: [table, after],
    closing: comparedClosing(rows, regressed, options, paint),
  };
}

function comparedCells(row: ComparedTask, paint: Paint): string[] {
  const t = row.timing;
  const word =
    row.verdict === "regressed"
      ? paint.bad("regressed")
      : row.verdict === "improved"
        ? paint.good("improved")
        : row.pass === false
          ? paint.bad("fail")
          : "";
  if (!t) return ["", "", "", word];
  const change = toChange(t.medianDeltaPct);
  return [
    toDuration(t.baseMedian),
    toDuration(t.candMedian),
    row.verdict === "regressed"
      ? paint.bad(change)
      : row.verdict === "improved"
        ? paint.good(change)
        : change,
    word,
  ];
}

function comparedNotes(row: ComparedTask, cmp: Comparison | undefined): Note[] {
  const notes: Note[] = [];
  if (row.renamedFrom) {
    notes.push({ text: `renamed from ${row.renamedFrom.task}`, tone: "dim" });
  }
  const t = row.timing;
  if (t?.ci95 && row.verdict !== "unchanged") {
    const p =
      t.pValue === undefined
        ? ""
        : `${SEPARATOR}${t.pValue < 0.001 ? "p<0.001" : `p=${t.pValue.toFixed(3)}`}`;
    notes.push({
      text: `95% CI ${toChange(t.ci95[0])}…${toChange(t.ci95[1])}${p}`,
      tone: "dim",
    });
  }
  for (const m of row.memory ?? []) {
    if (Math.abs(m.deltaPct) < MIN_MEMORY_NOTE_PCT) continue;
    notes.push({
      text: `${MEMORY_LABELS[m.reading]} ${toBytes(m.baseBytes)} → ${toBytes(m.candBytes)} (${Number.isFinite(m.deltaPct) ? toChange(m.deltaPct) : "new"})`,
      tone: "dim",
    });
  }
  if (!cmp) return notes;
  for (const f of shownFrameDeltas(cmp, TOP_FRAMES)) {
    notes.push({
      text: `${f.name} ${toChange(f.deltaPct)} self time (${toDuration(f.baseSelfUs * 1e3)} → ${toDuration(f.candSelfUs * 1e3)})`,
      tone: "dim",
    });
  }
  for (const h of shownHeapDeltas(cmp, TOP_TYPES)) {
    notes.push({
      text: `${h.type} ${toChange(h.deltaPct)} objects (${h.baseCount} → ${h.candCount})`,
      tone: "dim",
    });
  }
  for (const w of rowComparisonWarnings(cmp)) notes.push(toWarningNote(w));
  return notes;
}

const shortGit = (git: GitMetadata) =>
  `${git.sha.slice(0, 7)} (${git.branch}${git.dirty ? ", dirty" : ""})`;

function compareContext(doc: ProfileDocument, options: TableOptions): string[] {
  const parts: string[] = [];
  const ci = options.ci;
  if (ci) {
    parts.push(
      `baseline ${ci.baseline}`,
      `${ci.cached} cached, ${ci.executed} executed`,
    );
  }
  const compare = options.compare;
  if (compare) {
    parts.push(`thresholds from ${compare.thresholds}`);
    if (compare.baseGit && compare.candGit) {
      parts.push(
        `base ${shortGit(compare.baseGit)}`,
        `cand ${shortGit(compare.candGit)}`,
      );
    }
  }
  const summary = doc.comparisonSummary;
  const base = doc.comparisons?.[0]?.thresholds.timingPct;
  if (summary && base !== undefined) {
    const drift =
      summary.driftPct !== undefined && summary.driftPct > 0
        ? ` and ${summary.driftPct.toFixed(1)}% drift`
        : "";
    parts.push(
      summary.effectiveTimingPct > base
        ? `threshold ${base.toFixed(1)}%, ${summary.effectiveTimingPct.toFixed(1)}% with noise${drift}`
        : `threshold ${base.toFixed(1)}%`,
    );
  }
  return parts;
}

function comparedVerdict(
  doc: ProfileDocument,
  rows: readonly { row: ComparedTask }[],
  options: TableOptions,
  paint: Paint,
): string {
  const count = (verdict: ComparedTask["verdict"]) =>
    rows.filter(({ row }) => row.verdict === verdict).length;
  const failed = options.ci?.failed.length ?? 0;
  const pass =
    (doc.comparisonSummary?.verdict ??
      (rows.some(({ row }) => row.pass === false) ? "fail" : "pass")) ===
      "pass" && failed === 0;
  const regressed = count("regressed");
  const improved = count("improved");
  const geomean = doc.comparisonSummary?.geomeanPct;
  return [
    pass ? paint.good("pass") : paint.bad("fail"),
    ...(regressed > 0 ? [paint.bad(`${regressed} regressed`)] : []),
    ...(improved > 0 ? [paint.good(`${improved} improved`)] : []),
    `${count("unchanged")} unchanged`,
    ...(failed > 0 ? [paint.bad(`${failed} failed`)] : []),
    ...(options.ci && options.ci.missingBaseline > 0
      ? [`${options.ci.missingBaseline} not in the baseline`]
      : []),
    ...(geomean === null || geomean === undefined
      ? []
      : [`geomean ${toChange(geomean)}`]),
  ].join(SEPARATOR);
}

function comparedClosing(
  rows: readonly { row: ComparedTask }[],
  regressed: readonly ComparedTask[],
  options: TableOptions,
  paint: Paint,
): string {
  const ci = options.ci;
  const name = ci ? "Profile CI" : "Compare";
  if (ci && ci.failed.length > 0) {
    return failWith(
      paint,
      `${name} fails: ${plural(ci.failed.length, "workload")} failed to measure: ${truncateWords(ci.failed.join(", "), 30)}`,
      "see the error above",
    );
  }
  const [first] = regressed;
  if (first) {
    const change = first.timing
      ? ` ${toChange(first.timing.medianDeltaPct)}`
      : "";
    const more =
      regressed.length > 1 ? ` and ${regressed.length - 1} more` : "";
    return failWith(
      paint,
      `${name} fails: ${shortName(first.task)} regressed${change}${more}`,
      ci
        ? "fix it, or accept it: ostia ci --save-baseline"
        : "profile both sides with --cpu to see where",
    );
  }
  const matched = rows.filter(
    ({ row }) =>
      row.verdict !== "missing-base" && row.verdict !== "missing-cand",
  ).length;
  if (matched === 0) {
    return failWith(paint, "Nothing compared", "no workload is on both sides");
  }
  return closingLine(
    paint,
    `${name} passes`,
    ci
      ? `${plural(ci.workloads, "workload")}${elapsedPart(options)}`
      : `${plural(matched, "task")} compared${elapsedPart(options)}`,
  );
}

// --- CPU and heap captures ---

function instrumentedReport(doc: ProfileDocument, paint: Paint): Report {
  const captures = doc.measurements.filter(
    (m) => m.phase === "cpu" || m.phase === "heap",
  ).length;
  return {
    verdict: plural(captures, "capture"),
    context: contextLines(environmentParts(doc.environment), paint),
    blocks: [],
    closing: closingLine(paint, `Captured ${plural(captures, "profile")}`),
  };
}

// The label is cut to fit, not the detail, since the detail says what the
// numbers below it are.
function captureHeading(
  paint: Paint,
  kind: string,
  label: string,
  detail: string,
): string {
  const room = MEASURE - textWidth(`${kind} ${SEPARATOR}${detail}`);
  return `${paint.bold(kind)} ${truncateWords(label, Math.max(room, 12))}${paint.dim(`${SEPARATOR}${detail}`)}`;
}

// One block per CPU profile or heap snapshot, since each is a run of its
// own: what it captured, then its heaviest frames or commonest types.
function instrumentedBlocks(doc: ProfileDocument, paint: Paint): string[][] {
  const byWorkload = workloadsById(doc);
  return doc.measurements.flatMap((run): string[][] => {
    if (run.phase !== "cpu" && run.phase !== "heap") return [];
    const label = labelOrId(byWorkload.get(run.workloadId), run.workloadId);
    const lines: string[] = [];
    if (run.phase === "cpu") {
      const detail = run.cpu
        ? `${toCount(cpuSampleCount(run.cpu))} samples at ${toDuration(run.cpu.samplingIntervalUs * 1e3)}`
        : "nothing captured";
      lines.push(captureHeading(paint, "CPU profile", label, detail));
      if (run.cpu) {
        // A frame with no self time, as (root) and (module) mostly are,
        // isn't where the time went.
        const frames = topSelfFrames(run.cpu, TOP_FRAMES).filter(
          (f) => f.selfUs > 0,
        );
        lines.push(
          ...namedTable(
            headerRow(paint, ["function", "self", "share"]),
            frames.map((f) => ({
              branch: "",
              name: f.frame?.name || "(anonymous)",
              cells: [toDuration(f.selfUs * 1e3), toShare(Number(f.pct))],
            })),
            [1, 2],
            paint,
          ),
        );
      }
    } else {
      const heap = run.heap;
      const detail = heap
        ? `${toCount(heap.objectCount ?? 0)} objects${SEPARATOR}${toBytes(heap.heapSizeBytes ?? 0)}`
        : "nothing captured";
      lines.push(captureHeading(paint, "Heap snapshot", label, detail));
      if (heap) {
        lines.push(
          ...namedTable(
            headerRow(paint, ["type", "objects"]),
            heap.typeCounts.slice(0, TOP_TYPES).map((tc) => ({
              branch: "",
              name: tc.type,
              cells: [toCount(tc.count)],
            })),
            [1],
            paint,
          ),
        );
      }
    }
    for (const a of run.artifacts) {
      lines.push(paint.dim(`  ${truncatePath(a.path, 76)}`));
    }
    for (const w of run.warnings) {
      lines.push(...noteLines(toWarningNote(w), "  ", paint));
    }
    return [lines];
  });
}
