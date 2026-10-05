#!/usr/bin/env bun
import { AbBaseError, AbSetupError, ab } from "../ab/index.ts"
import { listBaselines, saveBaseline } from "../baseline/index.ts"
import {
  availableJobs,
  bench,
  expandSuiteGlobs,
  resolveBenchOptions,
} from "../bench/index.ts"
import {
  BaselineNotFoundError,
  MissingBaselineError,
  renderCiReport,
  runCi,
} from "../ci/index.ts"
import {
  compareDocuments,
  DEFAULT_THRESHOLDS,
  type Thresholds,
} from "../compare/index.ts"
import {
  baselinePath,
  ConfigError,
  configFilePath,
  loadConfig,
  type OstiaConfig,
} from "../config/index.ts"
import { type CommandSpec, time } from "../index.ts"
import {
  loadDocument,
  OstiaDocumentError,
  saveDocument,
  saveDocumentText,
  serializeDocument,
} from "../ir/document.ts"
import type { ProfileDocument, Workload } from "../ir/types.ts"
import { isHarnessFailure } from "../measure/timing.ts"
import { formatGit, workloadLabel } from "../renderers/format.ts"
import {
  type FormatName,
  type RenderResult,
  renderers,
} from "../renderers/index.ts"
import {
  MINIMAL_PROTOCOL_VERSION,
  type MinimalProtocolContext,
} from "../renderers/minimal/index.ts"
import { splitCommand, type TimeSource, type TimeUnit } from "../spawn/index.ts"

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `process.stdout`/`process.stderr` instantiate Node's stream stack on
 * first touch, costing real process-startup time for a CLI that's often
 * just printing one line and exiting - `Bun.write` to `Bun.stdout`/
 * `Bun.stderr` writes the same fd without paying for that. Every write in
 * this file goes through these two so none of them re-trigger it. */
const out = (text: string) => Bun.write(Bun.stdout, text)
const err = (text: string) => Bun.write(Bun.stderr, text)

/** Thrown by an argument parser for a malformed flag; every `xCommand`
 * catches it, prints the message plus a `--help` pointer, and exits 2. */
export class CliUsageError extends Error {}

/** Every code a `writeCliError` call may use, one per distinct exit-2 cause
 * across every subcommand - see the machine-output-protocol spec's `error`
 * event. */
export type CliErrorCode =
  | "invalid-flag"
  | "config-missing"
  | "config-invalid"
  | "baseline-missing"
  | "no-matches"
  | "spawn-failed"
  | "command-failed"
  | "timeout"
  | "time-source-no-match"
  | "document-load-failed"
  | "no-cpu-evidence"
  | "internal"

/** The subcommand's argv, for `wantsMachineErrors`. Set once in `main()`. */
let cliArgv: string[] = []

const MACHINE_FORMATS = new Set(["minimal", "json", "jsonl"])

/** Whether exit-2 errors also get a machine-readable JSON line: always when
 * stderr isn't a terminal (a script or agent is reading it) or a
 * machine-readable `--format` was asked for, never for a person at a
 * terminal reading prose. `node:tty` is imported only here, on the error
 * path: loading it up front costs every invocation ~15ms of startup. */
async function wantsMachineErrors(argv: string[]): Promise<boolean> {
  const { isatty } = await import("node:tty")
  if (!isatty(2)) return true
  return argv.some(
    (arg, i) =>
      (arg === "--format" && MACHINE_FORMATS.has(argv[i + 1] ?? "")) ||
      (arg.startsWith("--format=") &&
        MACHINE_FORMATS.has(arg.slice("--format=".length))),
  )
}

/** Writes `message` to stderr (prose, possibly multi-line - e.g. with a
 * trailing "Run '... --help'." hint), then, for a machine reader (see
 * `wantsMachineErrors`), one more JSON line with a machine-readable `code` for the
 * same failure, so a script/agent can `JSON.parse` the last line instead of
 * pattern-matching prose. Never written to stdout, which stays pure JSON for
 * `json`/`jsonl`/`minimal`. The JSON `message` is just `message`'s first
 * line - a "Run --help" hint belongs to a human at a terminal. */
async function writeCliError(
  code: CliErrorCode,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await err(message.endsWith("\n") ? message : `${message}\n`)
  if (!(await wantsMachineErrors(cliArgv))) return
  await err(
    `${JSON.stringify({
      event: "error",
      protocolVersion: MINIMAL_PROTOCOL_VERSION,
      code,
      message: message.split("\n")[0],
      ...(data && { data }),
    })}\n`,
  )
}

/** Prints `text` (a `*_HELP` constant) to stdout and returns the matching
 * exit code - 0 when help was explicitly requested, 2 when it's being
 * shown because something required was missing (bare invocation, no
 * command given, etc). The repeated shape at the top of every command. */
async function showHelp(text: string, ok: boolean): Promise<number> {
  await out(text)
  return ok ? 0 : 2
}

async function reportUsageError(
  usageErr: CliUsageError,
  command: string,
): Promise<number> {
  await writeCliError(
    "invalid-flag",
    `${usageErr.message}\nRun 'ostia ${command} --help'.`,
  )
  return 2
}

/** Parses `raw` as an integer flag value, throwing `CliUsageError` with a
 * uniform message when it isn't one (or is below `opts.min`, default 1).
 * `opts.allowAuto` additionally accepts the literal "auto", resolved to the
 * machine's available job count. */
export function parseIntFlag(
  name: string,
  raw: string | undefined,
  opts: { min?: number; allowAuto?: boolean } = {},
): number {
  if (opts.allowAuto && raw === "auto") return availableJobs()
  const min = opts.min ?? 1
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) {
    throw new CliUsageError(
      `Invalid ${name} "${raw}": expected an integer ≥ ${min}${
        opts.allowAuto ? ` (or "auto")` : ""
      }`,
    )
  }
  return n
}

/** Formats that render a `ProfileDocument`'s timing/CPU/heap numbers as a
 * report - what `time`/`bench`/`compare` accept. */
const TIME_UNITS: readonly TimeUnit[] = ["ns", "us", "ms", "s"]

const DOCUMENT_FORMATS = [
  "table",
  "json",
  "jsonl",
  "markdown",
  "minimal",
] as const

/** Formats that turn CPU evidence into files for other tools - additionally
 * accepted by `report`, which is the only command that can target a
 * document with no timing measurements at all. */
const VIZ_FORMATS = [
  "collapsed",
  "mermaid",
  "speedscope",
  "cpuprofile",
] as const

/** `report` is the only command that can target a viz format. */
const REPORT_FORMATS = [...DOCUMENT_FORMATS, ...VIZ_FORMATS] as const

const NO_CPU_EVIDENCE =
  "No CPU evidence in this document; rerun with --cpu (ostia time) or --cpu (ostia bench)\n"

function hasCpuMeasurement(doc: ProfileDocument): boolean {
  return doc.measurements.some((m) => m.phase === "cpu")
}

/** Saves `doc` to `path` when given - the one export decision every
 * `emitDocument` caller and `ci` (which can't route through `emitDocument`
 * itself, see its doc comment below) both need. */
/** Shared tail of time/bench/compare: optional --export-json, then the
 * rendered report unless --quiet. Guards against a viz format on a document
 * with no CPU evidence, though today only `report` can reach one (the other
 * three are restricted to `DOCUMENT_FORMATS`). `rendererOptions` reaches
 * `renderers[format].render` verbatim - `compare`/`ci` use it to pass a
 * `MinimalRenderOptions.protocol` context that only they can build (the
 * other document's git, `ci`'s baseline info, the real exit code). */
async function emitDocument(
  doc: ProfileDocument,
  args: { exportJson?: string; format: FormatName; quiet: boolean },
  rendererOptions: Record<string, unknown> = {},
): Promise<number> {
  // `--format json`'s render output is byte-for-byte `serializeDocument(doc)`
  // (see the json renderer) - the same text `--export-json` would write.
  // With both flags given, build that text once and reuse it for both
  // instead of running the (doc-size-proportional) canonical-JSON serializer
  // twice on the same document.
  if (args.format === "json" && args.exportJson) {
    const text = serializeDocument(doc)
    await saveDocumentText(text, args.exportJson)
    if (!args.quiet) await out(text)
    return 0
  }
  if (args.exportJson) await saveDocument(doc, args.exportJson)
  if (args.quiet) return 0
  if (
    (VIZ_FORMATS as readonly string[]).includes(args.format) &&
    !hasCpuMeasurement(doc)
  ) {
    await writeCliError("no-cpu-evidence", NO_CPU_EVIDENCE)
    return 2
  }
  await writeRenderResult(
    await renderers[args.format].render(doc, rendererOptions),
  )
  return 0
}

/** Loads the project config, printing the standard "not found" message
 * (and, when `command` is given, requiring at least one workload). */
async function requireConfig(
  command?: string,
): Promise<OstiaConfig | undefined> {
  const config = await loadConfig()
  if (!config) {
    await writeCliError(
      "config-missing",
      command
        ? `No ostia.config.json found. "${command}" needs configured workloads.`
        : `No ostia.config.json found.`,
    )
    return undefined
  }
  if (command && config.workloads.length === 0) {
    const configFile = (await configFilePath()) ?? "ostia.config.json"
    await writeCliError(
      "config-missing",
      `${configFile} has no "workloads" configured.`,
    )
    return undefined
  }
  return config
}

async function writeRenderResult(
  result: RenderResult,
  outDir?: string,
): Promise<void> {
  if (result.text) await out(result.text)

  if (!result.files || result.files.length === 0) return

  if (outDir) {
    for (const f of result.files) {
      const path = f.path ? `${outDir}/${f.path}` : outDir
      await Bun.write(path, f.content)
      await out(`wrote ${path}\n`)
    }
  } else if (result.files.length === 1) {
    await out(result.files[0]!.content)
  } else {
    for (const f of result.files) {
      await out(`--- ${f.path ?? "(unnamed)"} ---\n${f.content}\n`)
    }
  }
}

const TIME_HELP = `ostia time [flags] <command...>
ostia time [flags] -- <argv...>

Time commands as subprocesses. Each <command> is whitespace-split into argv (no shell);
everything after -- is one more command's argv, verbatim.

Flags:
  --samples N          exact trials per command (default: ~3s budget, at least 10)
  --budget MS          sampling time budget per command
  --min-samples N      floor on trials when --samples isn't given
  --warmup N           discarded warmup trials (default: 3)
  --no-interleave      run commands one after another instead of round-robin
  --prepare CMD        run before every trial, unmeasured; once, or once per command
  --time-source REGEX  take each trial's time from capture group 1 in the command's output
  --time-unit UNIT     unit of --time-source: ns | us | ms | s (default: ms)
  --cpu                capture one extra CPU-profile trial
  --heap               capture one extra heap-snapshot trial
  --cpu-interval US    CPU sampling interval (default: 1000)
  --timeout MS         kill a trial or --prepare hook after MS
  --ignore-failure[=CODE,...]  treat these exit codes (bare: all) as success
  --out-dir PATH       artifact directory (default: node_modules/.cache/ostia)
  --no-noise-check     skip the ~200ms noise-floor measurement
  --export-json PATH   write the ProfileDocument to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --quiet              don't print the report
  --help               show this message

A command stops at its first non-ignored non-zero exit.
Exit codes: 0 ok, 2 a command failed or produced no samples (or a bad flag), 130 Ctrl-C.

Examples:
  ostia time "bun a.ts" "bun b.ts"
  ostia time --samples 25 --cpu --heap "bun src/server.ts"
  ostia time --prepare "rm -rf dist" "bun build.ts"
  ostia time --time-source "built in (\\d+)ms" "bun build.ts"
  ostia time -- bun -e "console.log('a b')"
`

/** `--ignore-failure` given bare (no `=CODE,...`) means "ignore any exit code" -
 * POSIX exit codes are 0-255, so listing every non-zero one is exact. */
const IGNORE_ALL_EXIT_CODES = Array.from({ length: 255 }, (_, i) => i + 1)

const BENCH_HELP = `ostia bench [flags] <suite.ts...>

Run in-process group()/task() suites, each file in its own child process. With no files,
uses ostia.config's "bench" section; each flag overrides its config field.

Flags:
  --budget MS          sampling budget per task (default: 500)
  --samples N          exact trials per task (ignores --budget)
  --min-samples N      floor on trials (default: cost-aware, 3-20)
  --jobs N|auto        suite files at once (default: 1; >1 adds noise)
  --isolate            one process per task, not per file (--no-isolate to undo config)
  --gc                 Bun.gc(true) between trials (--no-gc)
  --cpu                extra per-task CPU profile with JIT tiers, ~2,000 samples (--no-cpu)
  --cpu-interval US    CPU sampling interval (default: 100)
  --alloc              extra per-task retained-heap-per-call measurement: what calls keep
                       alive after a full GC, not what they allocate (--no-alloc)
  --peak-mem           extra per-task RSS rise during the task's first call, garbage
                       included; median of 3 fresh processes (--no-peak-mem)
  --filter REGEX       only tasks whose "group/name" matches
  --preload PATH       import before each suite file (repeatable, in order)
  --bun-flags FLAGS    extra flags for the bun process running each suite (repeatable)
  --timeout MS         kill a suite (or isolated task) process after MS
  --out-dir PATH       scratch directory (default: node_modules/.cache/ostia)
  --no-noise-check     skip the ~200ms noise-floor measurement
  --export-json PATH   write the ProfileDocument to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --quiet              don't print the report
  --help               show this message

Per-task/per-group options ({ budgetMs, minSamples, gc, isolate, cpu, alloc, peakMem }) override
the suite-wide defaults. Exit codes: 0 ok, 2 a suite failed (or a bad flag), 130 Ctrl-C.

Examples:
  ostia bench bench/*.ts
  ostia bench bench/*.ts --filter parse --cpu --alloc
  ostia bench --preload ./bench/dom-setup.ts --bun-flags="--conditions=browser" bench/*.ts
`

const AB_HELP = `ostia ab [flags] <suite.ts...>

Pair every task on a git ref's committed tree (base) against the working tree (candidate), in
one process, alternating ~10ms batches, and gate on the per-round time ratio. Drift between
the two sides cancels within a round. With no files, uses ostia.config's "bench" suites.

Flags:
  --base REF           git ref for the base side (default: HEAD)
  --base-setup CMD     shell command run once in a freshly extracted base tree, e.g. to build
                       gitignored files the suites import (repeatable, in order)
  --rounds N           base/candidate rounds per task (default: 15)
  --threshold PCT      flag a task whose median ratio moves past PCT (default: 10)
  --geomean-threshold PCT  fail when the geometric mean of all ratios is slower than PCT
                       (default: 1.5)
  --confirm N          re-measure each flagged task in N fresh processes (default: 2; 0 skips)
  --filter REGEX       only tasks whose "group/name" matches
  --preload PATH       import before each suite file (repeatable, in order)
  --bun-flags FLAGS    extra flags for the bun process running each suite (repeatable)
  --timeout MS         kill a suite (or repeat) process after MS
  --out-dir PATH       scratch directory and base-tree cache (default: node_modules/.cache/ostia)
  --no-noise-check     skip the ~200ms noise-floor measurement
  --export-json PATH   write the ProfileDocument to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --quiet              don't print the report
  --help               show this message

The base tree is cached per commit (and --base-setup commands) under --out-dir. Setup runs
with the project's node_modules linked in, and OSTIA_AB_SHA and OSTIA_AB_CANDIDATE_DIR (the
working tree) set. A flagged task counts only when every fresh-process repeat flags it the
same way. A task that throws isn't timed; one that throws on the candidate side only fails
the run. A task whose suite file and output both changed reads "not comparable" and stays
out of the verdict. Exit codes: 0 pass, 1 a confirmed regression, a candidate-only throw or
the geomean over its threshold, 2 nothing paired or a harness error (not a git repo,
unknown ref, a failed setup or suite), 130 Ctrl-C.

Examples:
  ostia ab bench/parse.bench.ts
  ostia ab bench/*.ts --base origin/main --rounds 21
  ostia ab bench/*.ts --filter parse --format minimal
  ostia ab bench/*.ts --base-setup "bun scripts/generate.ts"
`

const COMPARE_HELP = `ostia compare <base.json> <candidate.json>
ostia compare <candidate.json> --baseline <base.json>

Compare two ProfileDocuments by workload id. Gates on ostia.config's "thresholds" when
present (the same ones "ostia ci" uses), else the defaults.

Flags:
  --baseline PATH      the base document, when only the candidate is positional
  --export-json PATH   write the candidate document with comparisons to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --quiet              don't print the report
  --help               show this message

Exit codes: 0 pass, 1 a workload regressed, 2 nothing matched or a harness error.
`

const REPORT_HELP = `ostia report <document.json> [flags]

Render a saved ProfileDocument. Files, not a GUI for the visualization formats -
hand the output to speedscope.app, flamegraph.pl, or a Mermaid renderer.

Formats:
  table        terminal timing/CPU/heap/comparison text (default)
  json         pretty JSON document
  jsonl        one metadata line, then one line per measurement
  markdown     agent- and human-readable report
  minimal      one compact JSON object per timing measurement, for LLM/CI consumption
  collapsed    folded stacks: "root;a;b 42" - flamegraph.pl and most flame tooling
  mermaid      call tree, top-15 frames by total time (never the whole profile)
  speedscope   sampled profile JSON for speedscope.app
  cpuprofile   verbatim .cpuprofile pass-through (cpu-prof/inspector origins only)

Flags:
  --format FORMAT     one of the formats above (default: table)
  --measurement <id>  for the visualization formats: render only this measurement
                       (default: every CPU measurement in the document)
  --out-dir PATH      write visualization files here instead of stdout
  --help              show this message

Examples:
  ostia report doc.json
  ostia report doc.json --format markdown
  ostia report doc.json --format speedscope --out-dir node_modules/.cache/ostia/viz
  ostia report doc.json --format collapsed | flamegraph.pl > flame.svg
`

const CI_HELP = `ostia ci [flags]

Run ostia.config's workloads (reusing cached runs whose declared inputs are unchanged),
compare against a saved baseline, and gate on regressions.

Flags:
  --full               ignore the cache
  --baseline NAME      baseline to compare against (default: config "baseline", or "main")
  --save-baseline      after a pass, save this run as the new baseline
  --no-noise-check     skip the ~200ms noise-floor measurement
  --export-json PATH   write the candidate document with comparisons to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --quiet              don't print the report
  --help               show this message

Exit codes: 0 pass, 1 regression, 2 harness error (missing config/baseline, a workload
failed or produced no samples, or an onMissingBaseline "fail" mismatch).
`

const BASELINE_HELP = `ostia baseline <save|list|show> [args]

Manage the baseline ProfileDocuments "ostia ci" gates against and "ostia compare --baseline"
reads.

Subcommands:
  save [name]              measure every configured workload (same code path as "ostia ci",
                            no comparison) and write it to <baselineDir>/<name>.json
                            (default name: config's "baseline" field, or "main")
  list                     list saved baselines: name, created date, workload count
  show <name> [flags]      render a saved baseline; delegates to "ostia report" (same
                            --format/--measurement/--out-dir flags)

Examples:
  ostia baseline save
  ostia baseline save my-feature
  ostia baseline list
  ostia baseline show main
  ostia baseline show main --format markdown
`

/** One flag's shape for the declarative tables below: what `argv[++i]`
 * becomes and how it's validated. */
type FlagSpec =
  | { kind: "string" }
  | { kind: "int"; min?: number; allowAuto?: boolean }
  | { kind: "number"; min: number }
  | { kind: "bool"; value: boolean }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "list" }

interface FlagDef {
  dest: string
  spec: FlagSpec
}

/** Generic engine behind every `parse*Args` below: walks `argv`, and for
 * each token either hands it to `special` (irregular forms a keyed table
 * can't express - `--`'s argv escape, `--ignore-failure[=..]`,
 * `--bun-flags[=..]` - which returns the index parsing should resume from,
 * or `undefined` to fall through), looks it up in `table` and assigns the
 * parsed value onto `args[dest]`, or - when it matches neither - routes it
 * to `onPositional` (a bare word) or throws the uniform "Unknown flag"
 * `CliUsageError` (anything starting with "-"). */
function parseFlags<T extends object>(
  argv: string[],
  command: string,
  table: Record<string, FlagDef>,
  args: T,
  onPositional: (arg: string, args: T) => void,
  special?: (arg: string, i: number, args: T) => number | undefined,
): T {
  const bag = args as unknown as Record<string, unknown>
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const handled = special?.(arg, i, args)
    if (handled !== undefined) {
      i = handled
      continue
    }
    // `--flag=value` is the same as `--flag value` for any flag that takes
    // a value.
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const def = table[name]
    if (!def || (eq > 0 && def.spec.kind === "bool")) {
      if (arg.startsWith("-")) {
        throw new CliUsageError(`Unknown flag "${arg}" for "ostia ${command}".`)
      }
      onPositional(arg, args)
      continue
    }
    const value = (): string | undefined =>
      eq > 0 ? arg.slice(eq + 1) : argv[++i]
    switch (def.spec.kind) {
      case "string":
        bag[def.dest] = value()
        break
      case "int":
        bag[def.dest] = parseIntFlag(name, value(), def.spec)
        break
      case "number": {
        const raw = value()
        const n = Number(raw)
        if (
          raw === undefined ||
          raw === "" ||
          !Number.isFinite(n) ||
          n < def.spec.min
        ) {
          throw new CliUsageError(
            `Invalid ${name} "${raw}": expected a number ≥ ${def.spec.min}`,
          )
        }
        bag[def.dest] = n
        break
      }
      case "bool":
        bag[def.dest] = def.spec.value
        break
      case "list":
        ;(bag[def.dest] as string[]).push(value() ?? "")
        break
      case "enum": {
        const raw = value()
        if (!def.spec.values.includes(raw as string)) {
          throw new CliUsageError(
            `Invalid ${name} "${raw}": expected one of: ${def.spec.values.join(", ")}`,
          )
        }
        bag[def.dest] = raw
        break
      }
    }
  }
  return args
}

interface TimeArgs {
  commands: string[]
  /** `-- <argv...>`: one more command, given as argv with no whitespace
   * splitting, so an argument containing a space survives. Always exactly
   * one command - everything after `--` belongs to it, flags included. */
  argvCommand?: string[]
  /** One entry applies to every command; N entries pair with N commands
   * (`commands.length` plus one more if `argvCommand` is set). */
  prepare: string[]
  timeSource?: string
  timeUnit?: TimeUnit
  samples?: number
  budgetMs?: number
  minSamples?: number
  warmup?: number
  interleave: boolean
  cpu: boolean
  heap: boolean
  cpuIntervalUs?: number
  timeoutMs?: number
  ignoreExitCodes: number[]
  outDir?: string
  noiseCheck: boolean
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
}

const TIME_FLAGS: Record<string, FlagDef> = {
  "--samples": { dest: "samples", spec: { kind: "int", min: 1 } },
  "--budget": { dest: "budgetMs", spec: { kind: "int", min: 1 } },
  "--min-samples": { dest: "minSamples", spec: { kind: "int", min: 1 } },
  "--warmup": { dest: "warmup", spec: { kind: "int", min: 0 } },
  "--no-interleave": {
    dest: "interleave",
    spec: { kind: "bool", value: false },
  },
  "--prepare": { dest: "prepare", spec: { kind: "list" } },
  "--time-source": { dest: "timeSource", spec: { kind: "string" } },
  "--time-unit": {
    dest: "timeUnit",
    spec: { kind: "enum", values: TIME_UNITS },
  },
  "--cpu": { dest: "cpu", spec: { kind: "bool", value: true } },
  "--heap": { dest: "heap", spec: { kind: "bool", value: true } },
  "--cpu-interval": { dest: "cpuIntervalUs", spec: { kind: "int", min: 1 } },
  "--timeout": { dest: "timeoutMs", spec: { kind: "int", min: 1 } },
  "--out-dir": { dest: "outDir", spec: { kind: "string" } },
  "--no-noise-check": {
    dest: "noiseCheck",
    spec: { kind: "bool", value: false },
  },
  "--export-json": { dest: "exportJson", spec: { kind: "string" } },
  "--format": {
    dest: "format",
    spec: { kind: "enum", values: DOCUMENT_FORMATS },
  },
  "--quiet": { dest: "quiet", spec: { kind: "bool", value: true } },
  "--help": { dest: "help", spec: { kind: "bool", value: true } },
  "-h": { dest: "help", spec: { kind: "bool", value: true } },
}

function parseTimeArgs(argv: string[]): TimeArgs {
  const args: TimeArgs = {
    commands: [],
    prepare: [],
    interleave: true,
    cpu: false,
    heap: false,
    ignoreExitCodes: [],
    noiseCheck: true,
    format: "table",
    quiet: false,
    help: false,
  }
  return parseFlags(
    argv,
    "time",
    TIME_FLAGS,
    args,
    (arg, a) => a.commands.push(arg),
    (arg, i, a) => {
      if (arg === "--") {
        // Everything after `--` is one command's argv, verbatim - not
        // whitespace-split, not further flag-parsed (an argument that
        // happens to look like a flag still belongs to the command).
        a.argvCommand = argv.slice(i + 1)
        return argv.length
      }
      if (arg === "--ignore-failure" || arg.startsWith("--ignore-failure=")) {
        const value = arg.startsWith("--ignore-failure=")
          ? arg.slice("--ignore-failure=".length)
          : undefined
        a.ignoreExitCodes.push(
          ...(value === undefined
            ? IGNORE_ALL_EXIT_CODES
            : value.split(",").map(Number)),
        )
        return i
      }
      return undefined
    },
  )
}

/** Wires SIGINT to an `AbortController` for the duration of `run`, so a
 * running `time()`/`bench()` call cancels cleanly (partial results, caller
 * decides the exit code) instead of the process just dying mid-spawn.
 * Always detaches the listener before returning, whether `run` resolved,
 * rejected, or was cancelled. */
async function withSigintAbort<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<{ result: T; aborted: boolean }> {
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on("SIGINT", onSigint)
  try {
    const result = await run(controller.signal)
    return { result, aborted: controller.signal.aborted }
  } finally {
    process.off("SIGINT", onSigint)
  }
}

async function timeCommand(argv: string[]): Promise<number> {
  const parsed = parseTimeArgs(argv)
  const hasArgvCommand = (parsed.argvCommand?.length ?? 0) > 0
  if (parsed.help || (parsed.commands.length === 0 && !hasArgvCommand)) {
    return showHelp(TIME_HELP, parsed.help)
  }

  const totalCommands = parsed.commands.length + (hasArgvCommand ? 1 : 0)
  if (parsed.prepare.length > 1 && parsed.prepare.length !== totalCommands) {
    await writeCliError(
      "invalid-flag",
      `--prepare given ${parsed.prepare.length} times for ${totalCommands} command(s): give it once (applies to all) or once per command.`,
    )
    return 2
  }
  if (parsed.timeSource !== undefined) {
    try {
      new RegExp(parsed.timeSource)
    } catch (err) {
      await writeCliError(
        "invalid-flag",
        `Invalid --time-source regex: ${errorMessage(err)}`,
      )
      return 2
    }
  }
  const timeSource: TimeSource | undefined =
    parsed.timeSource !== undefined
      ? { pattern: parsed.timeSource, unit: parsed.timeUnit }
      : undefined
  const prepareFor = (i: number) =>
    parsed.prepare.length === 1 ? parsed.prepare[0] : parsed.prepare[i]
  const commands: CommandSpec[] = parsed.commands.map((command, i) => ({
    command,
    prepare: prepareFor(i),
  }))
  if (hasArgvCommand) {
    commands.push({
      command: parsed.argvCommand!,
      prepare: prepareFor(parsed.commands.length),
    })
  }

  let doc: ProfileDocument
  let aborted: boolean
  try {
    ;({ result: doc, aborted } = await withSigintAbort((signal) =>
      time({
        commands,
        timeSource,
        samples: parsed.samples,
        budgetMs: parsed.budgetMs,
        minSamples: parsed.minSamples,
        warmup: parsed.warmup,
        interleave: parsed.interleave,
        cpu: parsed.cpu,
        heap: parsed.heap,
        cpuIntervalUs: parsed.cpuIntervalUs,
        timeoutMs: parsed.timeoutMs,
        ignoreExitCodes: parsed.ignoreExitCodes,
        outDir: parsed.outDir,
        noiseCheck: parsed.noiseCheck,
        signal,
      }),
    ))
  } catch (err) {
    await writeCliError("spawn-failed", `Run failed: ${errorMessage(err)}`)
    return 2
  }

  const emitCode = await emitDocument(doc, parsed)
  if (emitCode !== 0) return emitCode
  if (aborted) return 130

  // 2 (harness error), not 1: a command failing is "the harness couldn't
  // measure this cleanly", not a regression - 1 stays reserved for
  // compare/ci's verdict. Same rule `ostia ci` gates on (`isHarnessFailure`).
  const timingRuns = doc.workloads.map(
    (w) =>
      doc.measurements.find(
        (m) => m.workloadId === w.id && m.phase === "timing",
      ) ?? { trials: [], timing: undefined },
  )
  const anyUnmeasured = timingRuns.some((m) => !m.timing)
  const anyNonZero = timingRuns.some(
    (m) => m.timing && isHarnessFailure(m, parsed.ignoreExitCodes),
  )
  if (anyNonZero || anyUnmeasured) {
    const hasTimeout = doc.measurements.some((m) =>
      m.warnings.some((w) => w.code === "timeout"),
    )
    const hasNoMatch = doc.measurements.some((m) =>
      m.warnings.some((w) => w.code === "time-source-no-match"),
    )
    const code: CliErrorCode = anyNonZero
      ? "command-failed"
      : hasTimeout
        ? "timeout"
        : hasNoMatch
          ? "time-source-no-match"
          : "command-failed"
    await writeCliError(
      code,
      "One or more commands failed to produce a clean measurement; see the report above for details.",
    )
    return 2
  }
  return 0
}

interface BenchArgs {
  suites: string[]
  budgetMs?: number
  samples?: number
  minSamples?: number
  jobs?: number
  gc?: boolean
  cpu?: boolean
  cpuIntervalUs?: number
  alloc?: boolean
  peakMem?: boolean
  filter?: string
  isolate?: boolean
  preload: string[]
  bunFlags: string[]
  timeoutMs?: number
  outDir?: string
  noiseCheck: boolean
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
}

const BENCH_FLAGS: Record<string, FlagDef> = {
  "--budget": { dest: "budgetMs", spec: { kind: "int", min: 1 } },
  "--samples": { dest: "samples", spec: { kind: "int", min: 1 } },
  "--min-samples": { dest: "minSamples", spec: { kind: "int", min: 1 } },
  "--jobs": { dest: "jobs", spec: { kind: "int", min: 1, allowAuto: true } },
  "--gc": { dest: "gc", spec: { kind: "bool", value: true } },
  "--no-gc": { dest: "gc", spec: { kind: "bool", value: false } },
  "--cpu": { dest: "cpu", spec: { kind: "bool", value: true } },
  "--no-cpu": { dest: "cpu", spec: { kind: "bool", value: false } },
  "--cpu-interval": { dest: "cpuIntervalUs", spec: { kind: "int", min: 1 } },
  "--alloc": { dest: "alloc", spec: { kind: "bool", value: true } },
  "--no-alloc": { dest: "alloc", spec: { kind: "bool", value: false } },
  "--peak-mem": { dest: "peakMem", spec: { kind: "bool", value: true } },
  "--no-peak-mem": { dest: "peakMem", spec: { kind: "bool", value: false } },
  "--filter": { dest: "filter", spec: { kind: "string" } },
  "--isolate": { dest: "isolate", spec: { kind: "bool", value: true } },
  "--no-isolate": { dest: "isolate", spec: { kind: "bool", value: false } },
  "--preload": { dest: "preload", spec: { kind: "list" } },
  "--timeout": { dest: "timeoutMs", spec: { kind: "int", min: 1 } },
  "--out-dir": { dest: "outDir", spec: { kind: "string" } },
  "--no-noise-check": {
    dest: "noiseCheck",
    spec: { kind: "bool", value: false },
  },
  "--export-json": { dest: "exportJson", spec: { kind: "string" } },
  "--format": {
    dest: "format",
    spec: { kind: "enum", values: DOCUMENT_FORMATS },
  },
  "--quiet": { dest: "quiet", spec: { kind: "bool", value: true } },
  "--help": { dest: "help", spec: { kind: "bool", value: true } },
  "-h": { dest: "help", spec: { kind: "bool", value: true } },
}

function parseBenchArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = {
    suites: [],
    preload: [],
    bunFlags: [],
    noiseCheck: true,
    format: "table",
    quiet: false,
    help: false,
  }
  return parseFlags(
    argv,
    "bench",
    BENCH_FLAGS,
    args,
    (arg, a) => a.suites.push(arg),
    bunFlagsArg(argv),
  )
}

/** `--bun-flags FLAGS` / `--bun-flags=FLAGS`: whitespace-split and appended,
 * repeatable - a `special` handler, since a value like `--conditions=browser`
 * would otherwise be mistaken for a flag of its own. */
function bunFlagsArg(argv: string[]) {
  return (
    arg: string,
    i: number,
    a: { bunFlags: string[] },
  ): number | undefined => {
    if (arg === "--bun-flags") {
      a.bunFlags.push(...splitCommand(argv[i + 1] ?? ""))
      return i + 1
    }
    if (arg.startsWith("--bun-flags=")) {
      a.bunFlags.push(...splitCommand(arg.slice("--bun-flags=".length)))
      return i
    }
    return undefined
  }
}

async function benchCommand(argv: string[]): Promise<number> {
  const parsed = parseBenchArgs(argv)
  if (parsed.help) return showHelp(BENCH_HELP, true)

  const config = await loadConfig()
  const resolved = await resolveBenchOptions(parsed, config?.bench)

  if (resolved.suites.length === 0) return showHelp(BENCH_HELP, false)
  if (resolved.jobs !== undefined && !(resolved.jobs >= 1)) {
    await writeCliError(
      "invalid-flag",
      `--jobs expects a positive integer or "auto".`,
    )
    return 2
  }

  let doc: ProfileDocument
  let aborted: boolean
  try {
    ;({ result: doc, aborted } = await withSigintAbort((signal) =>
      bench({ ...resolved, signal }),
    ))
  } catch (err) {
    await writeCliError("spawn-failed", `Bench failed: ${errorMessage(err)}`)
    return 2
  }

  const emitCode = await emitDocument(doc, parsed)
  if (emitCode !== 0) return emitCode
  return aborted ? 130 : 0
}

interface AbArgs {
  suites: string[]
  base?: string
  baseSetup: string[]
  rounds?: number
  thresholdPct?: number
  geomeanThresholdPct?: number
  confirm?: number
  filter?: string
  preload: string[]
  bunFlags: string[]
  timeoutMs?: number
  outDir?: string
  noiseCheck: boolean
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
}

const AB_FLAGS: Record<string, FlagDef> = {
  "--base": { dest: "base", spec: { kind: "string" } },
  "--base-setup": { dest: "baseSetup", spec: { kind: "list" } },
  "--rounds": { dest: "rounds", spec: { kind: "int", min: 3 } },
  "--threshold": { dest: "thresholdPct", spec: { kind: "number", min: 0 } },
  "--geomean-threshold": {
    dest: "geomeanThresholdPct",
    spec: { kind: "number", min: 0 },
  },
  "--confirm": { dest: "confirm", spec: { kind: "int", min: 0 } },
  "--filter": { dest: "filter", spec: { kind: "string" } },
  "--preload": { dest: "preload", spec: { kind: "list" } },
  "--timeout": { dest: "timeoutMs", spec: { kind: "int", min: 1 } },
  "--out-dir": { dest: "outDir", spec: { kind: "string" } },
  "--no-noise-check": {
    dest: "noiseCheck",
    spec: { kind: "bool", value: false },
  },
  "--export-json": { dest: "exportJson", spec: { kind: "string" } },
  "--format": {
    dest: "format",
    spec: { kind: "enum", values: DOCUMENT_FORMATS },
  },
  "--quiet": { dest: "quiet", spec: { kind: "bool", value: true } },
  "--help": { dest: "help", spec: { kind: "bool", value: true } },
  "-h": { dest: "help", spec: { kind: "bool", value: true } },
}

function parseAbArgs(argv: string[]): AbArgs {
  const args: AbArgs = {
    suites: [],
    baseSetup: [],
    preload: [],
    bunFlags: [],
    noiseCheck: true,
    format: "table",
    quiet: false,
    help: false,
  }
  return parseFlags(
    argv,
    "ab",
    AB_FLAGS,
    args,
    (arg, a) => a.suites.push(arg),
    bunFlagsArg(argv),
  )
}

async function abCommand(argv: string[]): Promise<number> {
  const parsed = parseAbArgs(argv)
  if (parsed.help) return showHelp(AB_HELP, true)

  // The suite-level settings `ostia bench` reads from the config's `bench`
  // section apply here the same way; the sampling ones don't (pairing has
  // its own rounds).
  const fullConfig = await loadConfig()
  const config = fullConfig?.bench
  const suites =
    parsed.suites.length > 0
      ? parsed.suites
      : config?.suites
        ? await expandSuiteGlobs(config.suites, process.cwd())
        : []
  if (suites.length === 0) return showHelp(AB_HELP, false)

  let doc: ProfileDocument
  let aborted: boolean
  try {
    ;({ result: doc, aborted } = await withSigintAbort((signal) =>
      ab({
        suites,
        base: parsed.base,
        baseSetup:
          parsed.baseSetup.length > 0
            ? parsed.baseSetup
            : fullConfig?.ab?.setup,
        rounds: parsed.rounds,
        thresholdPct: parsed.thresholdPct,
        geomeanThresholdPct: parsed.geomeanThresholdPct,
        confirm: parsed.confirm,
        filter: parsed.filter ?? config?.filter,
        preload:
          parsed.preload.length > 0 ? parsed.preload : (config?.preload ?? []),
        bunFlags:
          parsed.bunFlags.length > 0
            ? parsed.bunFlags
            : (config?.bunFlags ?? []),
        timeoutMs: parsed.timeoutMs ?? config?.timeoutMs,
        outDir: parsed.outDir ?? config?.outDir,
        noiseCheck: parsed.noiseCheck,
        signal,
      }),
    ))
  } catch (err) {
    if (err instanceof AbBaseError) {
      await writeCliError("invalid-flag", `--base: ${err.message}`)
      return 2
    }
    if (err instanceof AbSetupError) {
      await writeCliError("command-failed", err.message)
      return 2
    }
    await writeCliError("spawn-failed", `A/B run failed: ${errorMessage(err)}`)
    return 2
  }

  const summary = doc.ab!
  // Decided before rendering, same as `compare`: `minimal`'s trailing
  // `summary` event needs the real exit code inline.
  const exitCode = aborted
    ? 130
    : summary.matched === 0 && !summary.threw
      ? 2
      : summary.verdict === "fail"
        ? 1
        : 0
  const byId = new Map(doc.workloads.map((w) => [w.id, w]))
  const workloadsFor = (ids: string[] = []) =>
    ids.flatMap((id) => byId.get(id) ?? [])
  const emitCode = await emitDocument(doc, parsed, {
    protocol: {
      command: "ab",
      exitCode,
      unmatched: {
        baseOnly: workloadsFor(doc.unmatched?.baseOnly),
        candOnly: workloadsFor(doc.unmatched?.candOnly),
      },
      ...(parsed.exportJson && { exportedTo: parsed.exportJson }),
    } satisfies MinimalProtocolContext,
  })
  if (emitCode !== 0) return emitCode
  if (exitCode === 2) {
    await writeCliError(
      "no-matches",
      `No task exists both at ${summary.base.ref} and in the working tree; nothing was paired.`,
    )
  }
  return exitCode
}

interface CompareArgs {
  paths: string[]
  baseline?: string
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
}

const COMPARE_FLAGS: Record<string, FlagDef> = {
  "--baseline": { dest: "baseline", spec: { kind: "string" } },
  "--export-json": { dest: "exportJson", spec: { kind: "string" } },
  "--format": {
    dest: "format",
    spec: { kind: "enum", values: DOCUMENT_FORMATS },
  },
  "--quiet": { dest: "quiet", spec: { kind: "bool", value: true } },
  "--help": { dest: "help", spec: { kind: "bool", value: true } },
  "-h": { dest: "help", spec: { kind: "bool", value: true } },
}

function parseCompareArgs(argv: string[]): CompareArgs {
  const args: CompareArgs = {
    paths: [],
    format: "table",
    quiet: false,
    help: false,
  }
  return parseFlags(argv, "compare", COMPARE_FLAGS, args, (arg, a) =>
    a.paths.push(arg),
  )
}

/** The `Thresholds` `ostia compare` gates on: the same `ostia.config.*`
 * `thresholds` `ostia ci` uses when a config is present, else
 * `DEFAULT_THRESHOLDS`, plus which of the two it was for the header line. */
async function resolveCompareThresholds(): Promise<{
  thresholds: Thresholds
  source: string
}> {
  const config = await loadConfig()
  if (!config) return { thresholds: DEFAULT_THRESHOLDS, source: "defaults" }
  return {
    thresholds: config.thresholds,
    source: (await configFilePath()) ?? "ostia.config.json",
  }
}

async function compareCommand(argv: string[]): Promise<number> {
  const parsed = parseCompareArgs(argv)
  if (parsed.help) return showHelp(COMPARE_HELP, true)

  let basePath: string | undefined
  let candPath: string | undefined
  if (parsed.baseline) {
    basePath = parsed.baseline
    candPath = parsed.paths[0]
  } else {
    basePath = parsed.paths[0]
    candPath = parsed.paths[1]
  }

  if (!basePath || !candPath) return showHelp(COMPARE_HELP, false)

  let base: ProfileDocument, cand: ProfileDocument
  try {
    ;[base, cand] = await Promise.all([
      loadDocument(basePath),
      loadDocument(candPath),
    ])
  } catch (err) {
    await writeCliError(
      "document-load-failed",
      `Failed to load documents: ${errorMessage(err)}`,
    )
    return 2
  }

  const { thresholds, source } = await resolveCompareThresholds()
  const result = compareDocuments(base, cand, thresholds)
  const outDoc: ProfileDocument = {
    ...cand,
    comparisons: result.comparisons,
    comparisonSummary: result.summary,
    unmatched: {
      baseOnly: result.unmatched.baseOnly.map((w) => w.id),
      candOnly: result.unmatched.candOnly.map((w) => w.id),
    },
  }

  // Prose banners are for the two human formats only: json/jsonl/minimal
  // must stay pure JSON on stdout, so this same information (thresholds,
  // git) travels inside the payload instead (summary.git, thresholds
  // resolved into effectiveTimingPct).
  const isHumanFormat =
    parsed.format === "table" || parsed.format === "markdown"
  if (!parsed.quiet && isHumanFormat) {
    await out(`thresholds: ${source}\n`)
    if (base.git && cand.git) {
      await out(`base ${formatGit(base.git)} → cand ${formatGit(cand.git)}\n`)
    }
    if (
      parsed.format === "table" &&
      result.summary.effectiveTimingPct > thresholds.timingPct
    ) {
      await out(
        `threshold ${thresholds.timingPct}% (widened to ${result.summary.effectiveTimingPct.toFixed(1)}% by noise floor)\n`,
      )
    }
  }

  // Decided before rendering (not after, like the other commands) because
  // `minimal`'s trailing `summary` event needs the real exit code inline -
  // there's no second pass over already-written stdout to patch it in.
  const exitCode =
    result.summary.matched === 0 ? 2 : result.summary.verdict === "fail" ? 1 : 0

  const emitCode = await emitDocument(outDoc, parsed, {
    protocol: {
      command: "compare",
      exitCode,
      unmatched: result.unmatched,
      baseGit: base.git,
      candGit: cand.git,
      ...(parsed.exportJson && { exportedTo: parsed.exportJson }),
    } satisfies MinimalProtocolContext,
  })
  if (emitCode !== 0) return emitCode

  if (
    !parsed.quiet &&
    (parsed.format === "table" || parsed.format === "markdown") &&
    (result.unmatched.baseOnly.length > 0 ||
      result.unmatched.candOnly.length > 0)
  ) {
    await out(renderUnmatchedSection(result.unmatched, parsed.format))
  }

  if (result.summary.matched === 0) {
    await writeCliError(
      "no-matches",
      "No workload matched between base and candidate; nothing was compared.",
    )
  }

  return exitCode
}

function renderUnmatchedSection(
  unmatched: { baseOnly: Workload[]; candOnly: Workload[] },
  format: "table" | "markdown",
): string {
  const labels = (ws: Workload[]) => ws.map((w) => workloadLabel(w)).join(", ")

  if (format === "markdown") {
    const lines = ["### Unmatched", ""]
    if (unmatched.baseOnly.length > 0)
      lines.push(`- baseline only: ${labels(unmatched.baseOnly)}`)
    if (unmatched.candOnly.length > 0)
      lines.push(`- candidate only: ${labels(unmatched.candOnly)}`)
    lines.push("")
    return `${lines.join("\n")}\n`
  }

  const lines = ["", "Unmatched:"]
  if (unmatched.baseOnly.length > 0)
    lines.push(`  baseline only: ${labels(unmatched.baseOnly)}`)
  if (unmatched.candOnly.length > 0)
    lines.push(`  candidate only: ${labels(unmatched.candOnly)}`)
  return `${lines.join("\n")}\n`
}

interface ReportArgs {
  path?: string
  format: FormatName
  measurementId?: string
  outDir?: string
  help: boolean
}

const REPORT_FLAGS: Record<string, FlagDef> = {
  "--format": {
    dest: "format",
    spec: { kind: "enum", values: REPORT_FORMATS },
  },
  "--measurement": { dest: "measurementId", spec: { kind: "string" } },
  "--out-dir": { dest: "outDir", spec: { kind: "string" } },
  "--help": { dest: "help", spec: { kind: "bool", value: true } },
  "-h": { dest: "help", spec: { kind: "bool", value: true } },
}

function parseReportArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = { format: "table", help: false }
  return parseFlags(argv, "report", REPORT_FLAGS, args, (arg, a) => {
    if (a.path !== undefined) {
      throw new CliUsageError(
        `"ostia report" takes exactly one document path, got "${a.path}" and "${arg}".`,
      )
    }
    a.path = arg
  })
}

async function reportCommand(argv: string[]): Promise<number> {
  const parsed = parseReportArgs(argv)
  if (parsed.help || !parsed.path) {
    return showHelp(REPORT_HELP, parsed.help)
  }

  let doc: ProfileDocument
  try {
    doc = await loadDocument(parsed.path)
  } catch (err) {
    await writeCliError(
      "document-load-failed",
      `Failed to load ${parsed.path}: ${errorMessage(err)}`,
    )
    return 2
  }

  if (
    (VIZ_FORMATS as readonly string[]).includes(parsed.format) &&
    !parsed.measurementId &&
    !hasCpuMeasurement(doc)
  ) {
    await writeCliError("no-cpu-evidence", NO_CPU_EVIDENCE)
    return 2
  }

  const renderer = renderers[parsed.format]
  const result = await renderer.render(doc, {
    measurementId: parsed.measurementId,
  })
  if (!result.text && (!result.files || result.files.length === 0)) {
    await writeCliError(
      "no-cpu-evidence",
      parsed.measurementId
        ? `No CPU evidence found for measurement "${parsed.measurementId}".`
        : NO_CPU_EVIDENCE,
    )
    return 2
  }
  await writeRenderResult(result, parsed.outDir)
  return 0
}

interface CiArgs {
  full: boolean
  baseline?: string
  saveBaseline: boolean
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
  noiseCheck: boolean
}

const CI_FLAGS: Record<string, FlagDef> = {
  "--full": { dest: "full", spec: { kind: "bool", value: true } },
  "--baseline": { dest: "baseline", spec: { kind: "string" } },
  "--save-baseline": {
    dest: "saveBaseline",
    spec: { kind: "bool", value: true },
  },
  "--export-json": { dest: "exportJson", spec: { kind: "string" } },
  "--format": {
    dest: "format",
    spec: { kind: "enum", values: DOCUMENT_FORMATS },
  },
  "--no-noise-check": {
    dest: "noiseCheck",
    spec: { kind: "bool", value: false },
  },
  "--quiet": { dest: "quiet", spec: { kind: "bool", value: true } },
  "--help": { dest: "help", spec: { kind: "bool", value: true } },
  "-h": { dest: "help", spec: { kind: "bool", value: true } },
}

/** `ci` has no positional arguments at all - unlike the other four commands,
 * a bare word is just as much an error as a `-`-prefixed one, so this always
 * throws with the same wording `parseFlags` already uses for unknown flags,
 * whether or not `arg` happens to start with "-". */
function parseCiArgs(argv: string[]): CiArgs {
  const args: CiArgs = {
    full: false,
    saveBaseline: false,
    format: "table",
    quiet: false,
    help: false,
    noiseCheck: true,
  }
  return parseFlags(argv, "ci", CI_FLAGS, args, (arg) => {
    throw new CliUsageError(`Unknown flag "${arg}" for "ostia ci".`)
  })
}

async function ciCommand(argv: string[]): Promise<number> {
  const parsed = parseCiArgs(argv)
  if (parsed.help) return showHelp(CI_HELP, true)

  const config = await requireConfig("ostia ci")
  if (!config) return 2

  const effectiveConfig: OstiaConfig = {
    ...config,
    ...(!parsed.noiseCheck && { noiseCheck: false }),
  }

  let outcome: Awaited<ReturnType<typeof runCi>>
  try {
    outcome = await runCi({
      config: effectiveConfig,
      full: parsed.full,
      baselineName: parsed.baseline,
    })
  } catch (err) {
    if (
      err instanceof BaselineNotFoundError ||
      err instanceof MissingBaselineError
    ) {
      await writeCliError("baseline-missing", err.message)
      return 2
    }
    if (err instanceof OstiaDocumentError) {
      await writeCliError("document-load-failed", err.message)
      return 2
    }
    await writeCliError("spawn-failed", `CI run failed: ${errorMessage(err)}`)
    return 2
  }

  // As in emitDocument: `--format json` prints exactly what `--export-json`
  // writes, so serialize once when both are wanted.
  const jsonText =
    parsed.format === "json" && !parsed.quiet
      ? serializeDocument(outcome.document)
      : undefined
  if (parsed.exportJson) {
    if (jsonText) await saveDocumentText(jsonText, parsed.exportJson)
    else await saveDocument(outcome.document, parsed.exportJson)
  }

  if (
    parsed.saveBaseline &&
    outcome.summary.regressed === 0 &&
    outcome.summary.failed === 0
  ) {
    await saveDocument(
      outcome.document,
      baselinePath(effectiveConfig, parsed.baseline),
    )
  }

  // Decided before rendering, same as `compare`: `minimal`'s trailing
  // `summary` event needs the real exit code inline.
  const exitCode =
    outcome.summary.failed > 0 ? 2 : outcome.summary.regressed > 0 ? 1 : 0

  if (outcome.summary.failed > 0) {
    const failedLabels = outcome.summary.results
      .filter((r) => r.harnessFailed)
      .map((r) => workloadLabel(r.workload))
    await writeCliError(
      "command-failed",
      `${outcome.summary.failed} workload(s) failed (harness error, a command exited non-zero or produced no samples): ${failedLabels.join(", ")}`,
    )
  }

  if (!parsed.quiet) {
    const resolvedBaselineName = parsed.baseline ?? effectiveConfig.baseline
    if (parsed.format === "table") {
      await out(renderCiReport(outcome.summary))
      if (
        outcome.document.comparisons &&
        outcome.document.comparisons.length > 0
      ) {
        await writeRenderResult(
          await renderers.table.render(outcome.document, {}),
        )
      }
    } else if (jsonText !== undefined) {
      await out(jsonText)
    } else if (parsed.format === "markdown") {
      await out(
        `## ostia ci\n\nBaseline: \`${resolvedBaselineName}\` (\`${baselinePath(effectiveConfig, parsed.baseline)}\`) · ${outcome.summary.cached} cached, ${outcome.summary.executed} executed\n\n`,
      )
      await writeRenderResult(
        await renderers.markdown.render(outcome.document, {}),
      )
    } else {
      await writeRenderResult(
        await renderers[parsed.format].render(outcome.document, {
          protocol: {
            command: "ci",
            exitCode,
            unmatched: outcome.summary.unmatched,
            baseGit: outcome.baseline.git,
            candGit: outcome.document.git,
            baseline: {
              name: resolvedBaselineName,
              path: baselinePath(effectiveConfig, parsed.baseline),
            },
            cached: outcome.summary.cached,
            executed: outcome.summary.executed,
            failed: outcome.summary.failed,
            missingBaseline: outcome.summary.missingBaseline,
            ...(parsed.exportJson && { exportedTo: parsed.exportJson }),
          } satisfies MinimalProtocolContext,
        }),
      )
    }
  }

  return exitCode
}

const BASELINE_NAME_RE = /^[A-Za-z0-9._-]+$/

/** `ostia baseline save|show`'s name argument isn't parsed like a flag, so a
 * typo'd flag (`--verbose`) would otherwise become a literal, surprising
 * baseline filename instead of an error. */
function validateBaselineName(name: string): string | undefined {
  if (name.startsWith("-")) {
    return `Invalid baseline name "${name}": names can't start with "-".`
  }
  if (!BASELINE_NAME_RE.test(name)) {
    return `Invalid baseline name "${name}": expected to match ${BASELINE_NAME_RE}.`
  }
  return undefined
}

async function baselineSaveCommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    return showHelp(BASELINE_HELP, true)
  }
  if (argv.length > 1) {
    await writeCliError(
      "invalid-flag",
      `"ostia baseline save" takes at most one name argument, got ${argv.length}.\nRun 'ostia baseline --help'.`,
    )
    return 2
  }
  const name = argv[0]
  if (name !== undefined) {
    const nameErr = validateBaselineName(name)
    if (nameErr) {
      await writeCliError(
        "invalid-flag",
        `${nameErr}\nRun 'ostia baseline --help'.`,
      )
      return 2
    }
  }

  const config = await requireConfig("ostia baseline save")
  if (!config) return 2

  const path = await saveBaseline(config, name)
  await out(`Wrote ${path}\n`)
  return 0
}

async function baselineListCommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    return showHelp(BASELINE_HELP, true)
  }

  const config = await requireConfig()
  if (!config) return 2

  const infos = await listBaselines(config)
  if (infos.length === 0) {
    await out(`No baselines found in ${config.baselineDir}.\n`)
    return 0
  }
  for (const info of infos) {
    const gitSuffix = info.git ? `\t${formatGit(info.git)}` : ""
    await out(
      `${info.name}\t${info.workloads} workloads\tcreated ${info.createdAt}\ttoolVersion ${info.toolVersion}${gitSuffix}\n`,
    )
  }
  return 0
}

async function baselineShowCommand(argv: string[]): Promise<number> {
  const [name, ...rest] = argv
  if (!name || name === "--help" || name === "-h") {
    return showHelp(BASELINE_HELP, !!name)
  }
  const nameErr = validateBaselineName(name)
  if (nameErr) {
    await writeCliError(
      "invalid-flag",
      `${nameErr}\nRun 'ostia baseline --help'.`,
    )
    return 2
  }

  const config = await requireConfig()
  if (!config) return 2

  return reportCommand([baselinePath(config, name), ...rest])
}

/** Shared shape of `main()` and `baselineCommand()`: no sub-name (or bare
 * `--help`/`-h`) prints `help` and exits 0/2, a matching name in `handlers`
 * runs it, anything else is an `unknownMessage`-worded exit 2. */
async function dispatchSubcommand(
  sub: string | undefined,
  rest: string[],
  handlers: Record<string, (argv: string[]) => Promise<number>>,
  help: string,
  unknownMessage: (sub: string) => string,
  commandPrefix = "",
): Promise<number> {
  if (sub === undefined || sub === "--help" || sub === "-h") {
    return showHelp(help, sub !== undefined)
  }
  const handler = handlers[sub]
  if (!handler) {
    await writeCliError("invalid-flag", unknownMessage(sub))
    return 2
  }
  try {
    return await handler(rest)
  } catch (err) {
    if (err instanceof ConfigError) {
      await writeCliError("config-invalid", err.message)
      return 2
    }
    // Every command's argument parsing throws CliUsageError; this is the
    // one place that turns it into the "message + Run 'ostia <cmd> --help'"
    // exit-2 report. Anything else is a bug, but still honours the exit-code
    // contract rather than crashing with a bare stack trace.
    if (err instanceof CliUsageError) {
      return reportUsageError(err, `${commandPrefix}${sub}`)
    }
    await writeCliError(
      "internal",
      `Internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    )
    return 2
  }
}

async function baselineCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  return dispatchSubcommand(
    sub,
    rest,
    {
      save: baselineSaveCommand,
      list: baselineListCommand,
      show: baselineShowCommand,
    },
    BASELINE_HELP,
    (s) => `Unknown "ostia baseline ${s}". Run "ostia baseline --help".`,
    "baseline ",
  )
}

const MAIN_HELP = `ostia - profiling and benchmarking for Bun

Commands:
  time      Time commands N times and report timing/CPU/heap
  bench     Run in-process benchmark suites (group()/task())
  ab        Pair suites against a git ref in one process, gate on regressions
  compare   Compare two ProfileDocuments
  report    Render a saved ProfileDocument (table/json/markdown/collapsed/mermaid/speedscope/...)
  ci        Run configured workloads against a baseline, gate on regressions
  baseline  Manage baseline ProfileDocuments (save/list/show)

Run "ostia <command> --help" for details.
`

async function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2)
  cliArgv = rest
  return dispatchSubcommand(
    subcommand,
    rest,
    {
      time: timeCommand,
      bench: benchCommand,
      ab: abCommand,
      compare: compareCommand,
      report: reportCommand,
      ci: ciCommand,
      baseline: baselineCommand,
    },
    MAIN_HELP,
    (s) => `Unknown subcommand "${s}". Run "ostia --help".`,
  )
}

if (import.meta.main) {
  main().then((code) => process.exit(code))
}
