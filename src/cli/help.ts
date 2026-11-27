import { processEnv } from "../config/env.ts";
import {
  createPaint,
  fitTerminal,
  MEASURE,
  type Paint,
  PLAIN,
  SEPARATOR,
  wantsColor,
} from "../terminal.ts";
import { TOOL_VERSION } from "../version.ts";
import { agentVariable } from "./agent.ts";

// A status line, Usage, Commands, Options, Examples, then the agent
// section, within 80 columns. Section heads are bold and defaults gray,
// so a reader scans for the flag, not the fine print.

export type HelpTopic =
  "main" | "time" | "bench" | "ab" | "compare" | "report" | "ci" | "baseline";

const NAME_WIDTH = 22;
const DESCRIPTION_AT = 2 + NAME_WIDTH;

// Words packed into lines of `width`, so a long description wraps
// under itself instead of running ragged.
function wrapped(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines;
}

// The default goes gray after the separator, so the eye finds the flag
// first; a long description wraps under itself, so the columns
// stay straight.
function flag(p: Paint, name: string, does: string, preset?: string): string {
  const room = MEASURE - DESCRIPTION_AT;
  const lines = wrapped(does, room);
  if (preset !== undefined) {
    const last = lines.at(-1) ?? "";
    const tail = `${SEPARATOR}${preset}`;
    if (last.length + tail.length <= room) {
      lines[lines.length - 1] = `${last}${p.dim(tail)}`;
    } else lines.push(p.dim(`default ${preset}`));
  }
  const pad = " ".repeat(DESCRIPTION_AT);
  const first =
    // Two spaces at least between a name and its description, or the
    // description starts on the next line.
    name.length <= NAME_WIDTH - 2
      ? `  ${name.padEnd(NAME_WIDTH)}${lines[0] ?? ""}`
      : `  ${name}\n${pad}${lines[0] ?? ""}`;
  return [first, ...lines.slice(1).map((line) => `${pad}${line}`)].join("\n");
}

// Examples carry their intent as a comment, so a reader picks one by
// what it's for.
const example = (p: Paint, intent: string, command: string) =>
  `  ${p.dim(`# ${intent}`)}\n  ${command}`;

const paragraph = (text: string) =>
  wrapped(text, MEASURE - 2)
    .map((line) => `  ${line}`)
    .join("\n");

const status = (p: Paint, name: string, tagline: string) =>
  `${p.bold(name)}${p.dim(`${SEPARATOR}${tagline}`)}`;

const OUTPUT_FORMATS = "table, concise, events, json, jsonl or markdown";

function outputFlags(p: Paint, exported = "the document"): string[] {
  return [
    flag(
      p,
      "--format <name>",
      OUTPUT_FORMATS,
      "table; concise for a coding agent",
    ),
    flag(p, "--json", "same as --format json"),
    flag(p, "--export-json <path>", `write ${exported} to a file`),
    flag(p, "--quiet", "don't print the report"),
    flag(p, "--color, --no-color", "force color on or off", "on in a terminal"),
    flag(p, "-h, --help", "this help"),
  ];
}

const noiseFlags = (p: Paint, budget = true) => [
  flag(p, "--no-noise-check", "skip the noise-floor checks, 50 to 75 ms"),
  ...(budget
    ? [flag(p, "--noise-budget <ms>", "sample the noise floor for exactly ms")]
    : []),
];

const suiteFlags = (p: Paint, kill: string) => [
  flag(p, "--filter <regex>", 'only tasks whose "group/name" matches'),
  flag(p, "--preload <path>", "import before each suite file; repeatable"),
  flag(p, "--bun-flags <flags>", "more flags for the bun running each suite"),
  flag(p, "--timeout <ms>", `kill a ${kill} process after ms`),
  flag(p, "--out-dir <path>", "scratch directory", "node_modules/.cache/ostia"),
  flag(p, "--config <path>", "this config file", "ostia.config.ts or .json"),
];

const section = (p: Paint, head: string, lines: readonly string[]) =>
  `${p.bold(head)}\n${lines.join("\n")}`;

function main(p: Paint): string {
  return [
    `${p.bold("ostia")} ${TOOL_VERSION}${p.dim(`${SEPARATOR}profiling and benchmarking for Bun`)}`,
    section(p, "Usage", ["  ostia <command> [options]"]),
    section(p, "Commands", [
      flag(p, "time <command...>", "time commands as subprocesses"),
      flag(
        p,
        "bench <suite.ts...>",
        "run in-process group() and task() suites",
      ),
      flag(p, "ab <suite.ts...>", "pair suites against a git ref, gate on it"),
      flag(p, "compare <a> <b>", "compare two saved documents, gate on it"),
      flag(p, "report <doc.json>", "render a saved document, or its profile"),
      flag(p, "ci", "run the config's workloads against a baseline"),
      flag(p, "baseline <sub>", "save, list or show baselines"),
    ]),
    section(p, "Options", [
      flag(p, "-h, --help", "help; <command> --help for a command's"),
      flag(p, "-v, --version", "the version"),
    ]),
    section(p, "Examples", [
      example(
        p,
        "which of two commands is faster",
        'ostia time "bun a.ts" "bun b.ts"',
      ),
      example(
        p,
        "a suite's tasks, with CPU profiles",
        "ostia bench bench/*.ts --cpu",
      ),
      example(
        p,
        "the working tree against HEAD",
        "ostia ab bench/parse.bench.ts",
      ),
    ]),
    section(p, "For agents", [
      paragraph(
        "A coding agent gets --format concise: one line per task, then its warnings. --json prints the whole document; --format events, one JSON line per task. Exit 0 done, 1 regressed, 2 called wrong or failed to measure. The fields are in docs/agent-protocol.md.",
      ),
    ]),
  ].join("\n\n");
}

function time(p: Paint): string {
  return [
    status(p, "ostia time", "time commands as subprocesses"),
    section(p, "Usage", [
      "  ostia time [options] <command...>",
      "  ostia time [options] -- <argv...>",
      "",
      paragraph(
        "Each <command> is split on whitespace into argv, with no shell; everything after -- is one more command's argv, verbatim. A command stops at its first non-zero exit not ignored. Exit 0 done, 2 a command failed or produced no samples, or a bad flag, 130 Ctrl-C.",
      ),
    ]),
    section(p, "Options", [
      flag(
        p,
        "--samples <n>",
        "exact runs per command",
        "about 3 s, at least 10",
      ),
      flag(p, "--budget <ms>", "sampling time per command"),
      flag(
        p,
        "--min-samples <n>",
        "the fewest runs, when --samples isn't given",
      ),
      flag(p, "--warmup <n>", "runs to discard first", "3"),
      flag(p, "--no-interleave", "run commands one after another, not in turn"),
      flag(
        p,
        "--prepare <cmd>",
        "run before every run, unmeasured; once, or once per command",
      ),
      flag(p, "--shell <sh>", "run each command and --prepare as sh -c CMD"),
      flag(
        p,
        "--save-output <dir>",
        "save each run's output as dir/<command>/trial-N.log",
      ),
      flag(p, "--show-output", "pass each run's output to stderr"),
      flag(
        p,
        "--time-source <regex>",
        "take each run's time from capture group 1 of its output",
      ),
      flag(
        p,
        "--time-unit <unit>",
        "unit of --time-source: ns, us, ms or s",
        "ms",
      ),
      flag(p, "--cpu", "capture one more run's CPU profile"),
      flag(p, "--heap", "capture one more run's heap snapshot"),
      flag(
        p,
        "--cpu-interval <us>",
        "CPU sampling interval; needs --cpu",
        "1000",
      ),
      flag(p, "--timeout <ms>", "kill a run or a --prepare hook after ms"),
      flag(
        p,
        "--ignore-failure[=<codes>]",
        "treat these exit codes, comma-separated, as success; bare, every one",
      ),
      flag(
        p,
        "--out-dir <path>",
        "artifact directory",
        "node_modules/.cache/ostia",
      ),
      ...noiseFlags(p),
      ...outputFlags(p),
    ]),
    section(p, "Examples", [
      example(p, "which of two is faster", 'ostia time "bun a.ts" "bun b.ts"'),
      example(
        p,
        "25 runs, with a CPU profile and a heap snapshot",
        'ostia time --samples 25 --cpu --heap "bun src/server.ts"',
      ),
      example(
        p,
        "a cold build each run",
        'ostia time --prepare "rm -rf dist" "bun build.ts"',
      ),
      example(
        p,
        "the time the build prints, not its wall time",
        'ostia time --time-source "built in (\\d+)ms" "bun build.ts"',
      ),
      example(
        p,
        "an argv with spaces in it",
        "ostia time -- bun -e \"console.log('a b')\"",
      ),
    ]),
  ].join("\n\n");
}

function bench(p: Paint): string {
  return [
    status(p, "ostia bench", "run in-process group() and task() suites"),
    section(p, "Usage", [
      "  ostia bench [options] <suite.ts...>",
      "",
      paragraph(
        "Each suite file runs in its own process. With no files, the config's \"bench\" section names them; each option overrides its config field, and a task's or group's own options override both. Exit 0 done, 2 a suite failed or a bad flag, 130 Ctrl-C.",
      ),
    ]),
    section(p, "Options", [
      flag(p, "--budget <ms>", "sampling time per task", "500"),
      flag(p, "--samples <n>", "exact samples per task; ignores --budget"),
      flag(p, "--min-samples <n>", "the fewest samples", "by cost, 3 to 20"),
      flag(
        p,
        "--jobs <n|auto>",
        "suite files at once; more than 1 adds noise",
        "1",
      ),
      flag(
        p,
        "--isolate",
        "one process per task, not per file; --no-isolate undoes the config's",
      ),
      flag(p, "--gc", "Bun.gc(true) between samples; --no-gc"),
      flag(
        p,
        "--cpu",
        "one more pass per task for a CPU profile with JIT tiers, about 2,000 samples; --no-cpu",
      ),
      flag(p, "--cpu-interval <us>", "CPU sampling interval", "100"),
      flag(
        p,
        "--alloc",
        "heap each call keeps alive after a full GC, not what it allocates; --no-alloc",
      ),
      flag(
        p,
        "--peak-mem",
        "RSS rise of the first call, garbage included, median of 3 processes; --no-peak-mem",
      ),
      ...suiteFlags(p, "suite (or isolated task)"),
      ...noiseFlags(p),
      ...outputFlags(p),
    ]),
    section(p, "Examples", [
      example(p, "every suite", "ostia bench bench/*.ts"),
      example(
        p,
        "the parse tasks, with CPU profiles and retained heap",
        "ostia bench bench/*.ts --filter parse --cpu --alloc",
      ),
      example(
        p,
        "suites that need a DOM",
        'ostia bench --preload ./dom.ts --bun-flags="--conditions=browser" bench/*.ts',
      ),
    ]),
  ].join("\n\n");
}

function ab(p: Paint): string {
  return [
    status(p, "ostia ab", "pair suites against a git ref, gate on regressions"),
    section(p, "Usage", [
      "  ostia ab [options] <suite.ts...>",
      "",
      paragraph(
        'Each task runs on a git ref\'s committed tree (base) and the working tree (candidate) in one process, in alternating batches of about 10 ms, so drift cancels within a round. Each suite runs twice, each side first once. With no files, the config\'s "bench" suites. A flagged task counts only when every fresh-process repeat flags it the same way. A task whose suite file and output both changed reads "not comparable" and stays out of the verdict.',
      ),
      "",
      paragraph(
        "The base tree is cached per commit and --base-setup under .ostia/ab, with the project's node_modules linked in; setup runs with OSTIA_AB_SHA and OSTIA_AB_CANDIDATE_DIR set. Instructions per call are counted where the machine allows (macOS; Linux with perf_event_paranoid at most 2).",
      ),
      "",
      paragraph(
        "Exit 0 pass; 1 a confirmed regression, a throw on the candidate only, the geomean over its threshold, or a memory regression; 2 nothing paired or a harness error (not a git repo, an unknown ref, a failed setup or suite); 130 Ctrl-C.",
      ),
    ]),
    section(p, "Options", [
      flag(p, "--base <ref>", "the git ref for the base side", "HEAD"),
      flag(
        p,
        "--base-setup <cmd>",
        "a shell command run once in a new base tree, to build what its suites import; repeatable",
      ),
      flag(p, "--rounds <n>", "base and candidate rounds per task", "15"),
      flag(
        p,
        "--metric <name>",
        "judge each round's time or instructions; instructions barely move on a busy machine",
        "time",
      ),
      flag(
        p,
        "--threshold <pct>",
        "flag a task whose median ratio moves past pct",
        "10",
      ),
      flag(
        p,
        "--geomean-threshold <pct>",
        "fail when the geometric mean of all ratios is slower by pct",
        "1.5",
      ),
      flag(
        p,
        "--confirm <n>",
        "recheck a flagged task in n fresh processes; 0 skips",
        "2",
      ),
      flag(p, "--alloc", "compare retained heap per call too; --no-alloc"),
      flag(
        p,
        "--peak-mem",
        "compare the first call's RSS rise too, median of 3 processes a side; --no-peak-mem",
      ),
      flag(
        p,
        "--mem-threshold <pct>",
        "flag a memory reading that moves past pct and its noise floor",
        "10",
      ),
      ...suiteFlags(p, "suite (or repeat)"),
      flag(
        p,
        "--keep-trees <n>",
        "base trees to keep cached, oldest out first",
        "5",
      ),
      flag(p, "--clean", "remove every cached base tree, then exit"),
      flag(
        p,
        "--progress",
        "progress on stderr (--no-progress)",
        "on in a terminal",
      ),
      ...noiseFlags(p),
      ...outputFlags(p),
    ]),
    section(p, "Examples", [
      example(
        p,
        "the working tree against HEAD",
        "ostia ab bench/parse.bench.ts",
      ),
      example(
        p,
        "against main, with more rounds",
        "ostia ab bench/*.ts --base origin/main --rounds 21",
      ),
      example(
        p,
        "a tight gate on a busy CI machine",
        "ostia ab bench/*.ts --metric instructions --threshold 3",
      ),
      example(
        p,
        "a base that needs a build step",
        'ostia ab bench/*.ts --base-setup "bun scripts/generate.ts"',
      ),
      example(
        p,
        "memory too",
        "ostia ab bench/paint.bench.ts --alloc --peak-mem",
      ),
    ]),
  ].join("\n\n");
}

function compare(p: Paint): string {
  return [
    status(
      p,
      "ostia compare",
      "compare two saved documents, gate on regressions",
    ),
    section(p, "Usage", [
      "  ostia compare [options] <base.json> <candidate.json>",
      "  ostia compare [options] <candidate.json> --baseline <base.json>",
      "",
      paragraph(
        'Tasks match by workload id, or by a task\'s former names from its "aliases". The gate uses the config\'s "thresholds", as ostia ci does, else the defaults, widened by machine noise and drift. Exit 0 pass, 1 a workload regressed, 2 nothing matched or a harness error.',
      ),
    ]),
    section(p, "Options", [
      flag(
        p,
        "--baseline <path>",
        "the base document, when only the candidate is positional",
      ),
      flag(
        p,
        "--config <path>",
        "read thresholds from this config file",
        "ostia.config.ts or .json",
      ),
      ...outputFlags(p, "the candidate with its comparisons"),
    ]),
    section(p, "Examples", [
      example(
        p,
        "a branch's run against main's",
        "ostia compare main.json branch.json",
      ),
      example(
        p,
        "every row, for a script",
        "ostia compare main.json branch.json --json",
      ),
    ]),
  ].join("\n\n");
}

function report(p: Paint): string {
  return [
    status(p, "ostia report", "render a saved document, or its profile"),
    section(p, "Usage", [
      "  ostia report <document.json> [options]",
      "",
      paragraph(
        "Files, not a GUI: hand a visualization format to speedscope.app, flamegraph.pl or a Mermaid renderer.",
      ),
    ]),
    section(p, "Formats", [
      flag(p, "table", "the terminal report", "default"),
      flag(p, "json", "the document, pretty"),
      flag(p, "jsonl", "a metadata line, then one line per measurement"),
      flag(p, "markdown", "a report for a pull request or an agent"),
      flag(p, "concise", "one line per task, then its warnings; alias agent"),
      flag(p, "events", "one JSON line per timing measurement; alias minimal"),
      flag(p, "collapsed", 'folded stacks, "root;a;b 42", for flamegraph.pl'),
      flag(p, "mermaid", "the call tree, the top 15 frames by total time"),
      flag(p, "speedscope", "a sampled profile for speedscope.app"),
      flag(
        p,
        "cpuprofile",
        "the .cpuprofile as captured, inspector origins only",
      ),
    ]),
    section(p, "Options", [
      flag(p, "--format <name>", "one of the formats above", "table"),
      flag(
        p,
        "--measurement <id>",
        "visualizations: this measurement only",
        "every CPU one",
      ),
      flag(
        p,
        "--out-dir <path>",
        "visualizations: write files here, not to stdout",
      ),
      flag(
        p,
        "--color, --no-color",
        "force color on or off",
        "on in a terminal",
      ),
      flag(p, "-h, --help", "this help"),
    ]),
    section(p, "Examples", [
      example(p, "the table again", "ostia report doc.json"),
      example(
        p,
        "for a pull request",
        "ostia report doc.json --format markdown",
      ),
      example(
        p,
        "a flame graph",
        "ostia report doc.json --format collapsed | flamegraph.pl > flame.svg",
      ),
      example(
        p,
        "files for speedscope.app",
        "ostia report doc.json --format speedscope --out-dir viz",
      ),
    ]),
  ].join("\n\n");
}

function ci(p: Paint): string {
  return [
    status(p, "ostia ci", "run the config's workloads against a baseline"),
    section(p, "Usage", [
      "  ostia ci [options]",
      "",
      paragraph(
        "Runs the config's workloads, reusing a cached run whose declared inputs haven't changed, compares them with a saved baseline and gates on regressions. Exit 0 pass, 1 a regression, 2 a harness error (no config or baseline, a workload failed or produced no samples, or an onMissingBaseline \"fail\" mismatch), 130 Ctrl-C (the partial document is exported; nothing is compared or saved).",
      ),
    ]),
    section(p, "Options", [
      flag(p, "--full", "ignore the cache"),
      flag(
        p,
        "--baseline <name>",
        "gate on this baseline",
        'the config\'s "baseline", or main',
      ),
      flag(
        p,
        "--save-baseline",
        "after a pass, save this run as the baseline; always measures fresh",
      ),
      flag(
        p,
        "--config <path>",
        "this config file",
        "ostia.config.ts or .json",
      ),
      ...noiseFlags(p, false),
      ...outputFlags(p, "the candidate with its comparisons"),
    ]),
    section(p, "Examples", [
      example(p, "gate a pull request", "ostia ci"),
      example(
        p,
        "after a merge to main, move the baseline",
        "ostia ci --save-baseline",
      ),
    ]),
  ].join("\n\n");
}

function baseline(p: Paint): string {
  return [
    status(p, "ostia baseline", "save, list or show baselines"),
    section(p, "Usage", [
      "  ostia baseline <save|list|show> [args]",
      "",
      paragraph(
        "The documents ostia ci gates against and ostia compare --baseline reads.",
      ),
    ]),
    section(p, "Commands", [
      flag(
        p,
        "save [name]",
        'measure every configured workload, as ostia ci does, without comparing; write <baselineDir>/<name>.json, name the config\'s "baseline", or main',
      ),
      flag(p, "list", "saved baselines: name, created date, workload count"),
      flag(
        p,
        "show <name>",
        "render a saved baseline, as ostia report does, with its --format, --measurement and --out-dir",
      ),
    ]),
    section(p, "Options", [
      flag(
        p,
        "--config <path>",
        "this config file",
        "ostia.config.ts or .json",
      ),
      flag(p, "-h, --help", "this help"),
    ]),
    section(p, "Examples", [
      example(p, "save the main baseline", "ostia baseline save"),
      example(p, "a named one, for a branch", "ostia baseline save my-feature"),
      example(p, "what's saved", "ostia baseline list"),
      example(
        p,
        "a baseline, for a pull request",
        "ostia baseline show main --format markdown",
      ),
    ]),
  ].join("\n\n");
}

const TOPICS: Record<HelpTopic, (p: Paint) => string> = {
  main,
  time,
  bench,
  ab,
  compare,
  report,
  ci,
  baseline,
};

export function helpText(topic: HelpTopic, paint: Paint): string {
  return `${TOPICS[topic](paint)}\n`;
}

// The forced color from argv, read before (or without) the rest parsing,
// so help and a usage error honor --no-color.
function forcedColor(argv: readonly string[]): boolean | undefined {
  const end = argv.indexOf("--");
  const own = end === -1 ? argv : argv.slice(0, end);
  if (own.includes("--no-color")) return false;
  return own.includes("--color") ? true : undefined;
}

// The flag, then the terminal, so help, output and errors agree.
export async function paintFor(
  fd: 1 | 2,
  forced: boolean | undefined = forcedColor(process.argv),
): Promise<Paint> {
  // perf: imported lazily, since loading node:tty up front costs every
  // invocation about 4 ms (median of 150 runs, before and after).
  const { isatty } = await import("node:tty");
  const env = processEnv();
  return wantsColor(forced, isatty(fd), env, agentVariable(env) !== undefined)
    ? createPaint()
    : PLAIN;
}

export async function showHelp(
  topic: HelpTopic,
  requested: boolean,
): Promise<0 | 2> {
  const { isatty } = await import("node:tty");
  await Bun.write(
    Bun.stdout,
    fitTerminal(
      helpText(topic, await paintFor(1)),
      isatty(1),
      process.stdout.columns,
    ),
  );
  return requested ? 0 : 2;
}
