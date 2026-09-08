#!/usr/bin/env bun
import { listBaselines, saveBaseline } from "../baseline/index.ts"
import { availableJobs, bench, resolveBenchOptions } from "../bench/index.ts"
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
  configFilePath,
  loadConfig,
  type OstiaConfig,
} from "../config/index.ts"
import { type CommandSpec, time } from "../index.ts"
import { loadDocument, saveDocument } from "../ir/document.ts"
import type { ProfileDocument, Workload } from "../ir/types.ts"
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

/** Thrown by an argument parser for a malformed flag; every `xCommand`
 * catches it, prints the message plus a `--help` pointer, and exits 2. */
export class CliUsageError extends Error {}

/** Every code a `writeCliError` call may use, one per distinct exit-2 cause
 * across every subcommand - see the machine-output-protocol spec's `error`
 * event. */
export type CliErrorCode =
  | "invalid-flag"
  | "config-missing"
  | "baseline-missing"
  | "no-matches"
  | "spawn-failed"
  | "command-failed"
  | "timeout"
  | "time-source-no-match"
  | "document-load-failed"
  | "no-cpu-evidence"
  | "internal"

/** Writes `message` to stderr exactly as before (prose, possibly
 * multi-line - e.g. with a trailing "Run '... --help'." hint), then one more
 * JSON line with a machine-readable `code` for the same failure - every
 * exit-2 path writes both, in this order, so a script/agent parsing stderr
 * can `JSON.parse` the last line instead of pattern-matching prose. Never
 * written to stdout, which stays pure JSON for `json`/`jsonl`/`minimal` (see
 * the "pure stdout" fix above). The JSON `message` is just `message`'s first
 * line - a "Run --help" hint belongs to a human at a terminal, not to a
 * script's error object. */
function writeCliError(
  code: CliErrorCode,
  message: string,
  data?: Record<string, unknown>,
): void {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`)
  process.stderr.write(
    `${JSON.stringify({
      event: "error",
      protocolVersion: MINIMAL_PROTOCOL_VERSION,
      code,
      message: message.split("\n")[0],
      ...(data && { data }),
    })}\n`,
  )
}

function reportUsageError(err: unknown, command: string): number {
  if (!(err instanceof CliUsageError)) throw err
  writeCliError(
    "invalid-flag",
    `${err.message}\nRun 'ostia ${command} --help'.`,
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

/** Parses `raw` as a finite float flag value (`--timing-pct`, `--alpha`),
 * throwing `CliUsageError` with a uniform message when it isn't one (or is
 * below `opts.min`, default 0). Unlike `parseIntFlag`, fractional values are
 * valid - a threshold percent or a significance level is rarely a whole
 * number. */
function parseFloatFlag(
  name: string,
  raw: string | undefined,
  opts: { min?: number } = {},
): number {
  const min = opts.min ?? 0
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) {
    throw new CliUsageError(
      `Invalid ${name} "${raw}": expected a number ≥ ${min}`,
    )
  }
  return n
}

/** Formats that render a `ProfileDocument`'s timing/CPU/heap numbers as a
 * report - what `time`/`bench`/`compare` accept. */
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

function checkFormat(
  format: string,
  allowed: readonly FormatName[],
): format is FormatName {
  if ((allowed as readonly string[]).includes(format)) return true
  writeCliError(
    "invalid-flag",
    `Unknown --format "${format}". Expected one of: ${allowed.join(", ")}`,
  )
  return false
}

const NO_CPU_EVIDENCE =
  "No CPU evidence in this document; rerun with --cpu (ostia time) or --cpu (ostia bench)\n"

function hasCpuMeasurement(doc: ProfileDocument): boolean {
  return doc.measurements.some((m) => m.phase === "cpu")
}

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
  if (args.exportJson) await saveDocument(doc, args.exportJson)
  if (args.quiet) return 0
  if (
    (VIZ_FORMATS as readonly string[]).includes(args.format) &&
    !hasCpuMeasurement(doc)
  ) {
    writeCliError("no-cpu-evidence", NO_CPU_EVIDENCE)
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
    writeCliError(
      "config-missing",
      command
        ? `No ostia.config.json found. "${command}" needs configured workloads.`
        : `No ostia.config.json found.`,
    )
    return undefined
  }
  if (command && config.workloads.length === 0) {
    const configFile = (await configFilePath()) ?? "ostia.config.json"
    writeCliError(
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
  if (result.text) process.stdout.write(result.text)

  if (!result.files || result.files.length === 0) return

  if (outDir) {
    for (const f of result.files) {
      const path = f.path ? `${outDir}/${f.path}` : outDir
      await Bun.write(path, f.content)
      process.stdout.write(`wrote ${path}\n`)
    }
  } else if (result.files.length === 1) {
    process.stdout.write(result.files[0]!.content)
  } else {
    for (const f of result.files) {
      process.stdout.write(`--- ${f.path ?? "(unnamed)"} ---\n${f.content}\n`)
    }
  }
}

const TIME_HELP = `ostia time [flags] <command...>
ostia time [flags] -- <argv...>

Time one or more commands N times with warmup and report timing statistics. Each
<command> is a string, whitespace-split into argv exactly like hyperfine -N (no shell,
so no quoting/globbing/pipes/redirection) - it can't express an argument containing a
space. \`-- <argv...>\` is the escape hatch: everything after -- is one command's argv
verbatim, space-preserving, not further flag-parsed. It's one more command alongside any
given as regular arguments, not a replacement for them.

Flags:
  --samples N         exact number of timed trials per command (each command gets its
                       own N trials, not a total split across them)
  --budget MS         wall-clock time budget for the sampling loop (default: a
                       hyperfine-style ~3s min-total-time loop when neither
                       --samples nor --budget is given)
  --min-samples N     hard floor on trials when --samples is not given
  --warmup N          warmup trials, discarded (default: 3)
  --no-interleave     run each command's whole trial loop to completion before the next
                       command starts, instead of round-robin (one trial per command,
                       repeated). Round-robin is the default with 2+ commands: it spreads
                       drift over the run's wall-clock span (thermal throttling, a noisy
                       neighbor process) evenly across every command instead of favoring
                       whichever ran first or last. Meaningless (and ignored) with one
                       command. Interleaved measurements carry Measurement.interleaved: true.
  --prepare CMD       run CMD before every trial (warmup and --cpu/--heap trials
                       included), unmeasured, in the same cwd; it must exit 0. Whitespace-
                       split like the commands themselves (no shell) - there's no --
                       equivalent for --prepare, so a hook needing an argument with a
                       space needs ostia.config.ts's array form (prepare: ["a", "b c"])
                       instead. Given once it applies to every command; given once per
                       command it pairs up in order, so the same command can be timed
                       warm and cold side by side. Its stderr is captured (bounded to
                       1 MiB) rather than streamed live, and folded into the error on a
                       trial where it times out or exits non-zero.
  --time-source REGEX take each trial's time from the first REGEX match in the command's
                       own stdout (then stderr), capture group 1, instead of its wall clock -
                       e.g. --time-source "built in (\\d+)ms" for a build tool whose own
                       summary excludes runtime startup. A trial whose output doesn't match
                       contributes no sample (a time-source-no-match warning records it); if
                       every trial misses, that command has no timing stats. Trials keep
                       wallNs alongside the reported value.
  --time-unit UNIT    unit of the --time-source number: ns | us | ms | s (default: ms)
  --cpu               capture one instrumented CPU-profile trial (subprocess --cpu-prof)
  --heap              capture one instrumented heap-snapshot trial (subprocess --heap-prof)
  --cpu-interval USEC CPU sampling interval in microseconds (default: 1000)
  --timeout MS        kill a trial (or --prepare hook) with SIGKILL if it hasn't finished
                       after this many ms. No default: unset never times out. A timed-out
                       trial contributes no sample; if every trial of a command times out,
                       that command has no timing stats.
  --ignore-failure[=CODE,...]
                       treat the given exit codes as success (default with no value: every
                       code). A matching trial still contributes its sample and gets no
                       nonzero-exit warning, as if it had exited 0. Repeatable.
  --fail-on-nonzero   stop a command's trial loop after its first non-zero, non-ignored
                       exit (that trial's sample is still recorded) instead of always
                       running its full sample count.
  --out-dir PATH      directory for captured artifacts (default: node_modules/.cache/ostia)
  --no-noise-check    skip the ~200ms machine noise floor reference measurement
  --export-json PATH  write the full ProfileDocument to PATH
  --format FORMAT     table | json | jsonl | markdown | minimal (default: table)
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

Instrumented runs (--cpu, --heap) are labeled separately from clean timing and never
mixed into the timing statistics.

Exit codes: 0 pass, 2 harness error (a command had a non-zero, non-ignored exit; a
timed-out or --time-source-mismatched command had no timing stats at all; or a bad flag).
130 if cancelled with Ctrl-C. 1 is never returned by "time" - it's reserved for
"compare"/"ci" regressions.

Examples:
  ostia time "bun ./fixtures/work.ts"
  ostia time --samples 25 --warmup 3 "bun a.ts" "bun b.ts"
  ostia time --no-interleave "bun a.ts" "bun b.ts"
  ostia time --prepare "rm -rf dist" "bun build.ts"
  ostia time --time-source "built in (\\d+)ms" "bun build.ts"
  ostia time --cpu --heap "bun src/server.ts"
  ostia time --format json "bun a.ts"
  ostia time --ignore-failure=3 "bun flaky.ts"
  ostia time --fail-on-nonzero "bun might-hang-if-broken.ts"
  ostia time -- bun -e "console.log('a b')"      # argument with a space, unsplit
`

/** `--ignore-failure` given bare (no `=CODE,...`) means "ignore any exit code" -
 * POSIX exit codes are 0-255, so listing every non-zero one is exact. */
const IGNORE_ALL_EXIT_CODES = Array.from({ length: 255 }, (_, i) => i + 1)

const BENCH_HELP = `ostia bench [flags] <suite.ts...>

Run in-process benchmark suites (registered via group()/task()). Each suite file runs
in its own spawned child process (isolated from CLI startup state).

Flags:
  --budget MS         sampling budget per task; always runs at least this long (default: 500).
  --samples N         exact trial count per task; when set, the budget is ignored -
                       the in-process equivalent of "ostia time"'s --samples.
  --min-samples N     hard floor on samples per task, kept even when it overruns the
                       budget. Default: cost-aware - as many as fit in the budget (max 20),
                       but never below the floor the task's per-trial cost earns it: 3 at
                       <=1ms, +2 per decade of cost, 10 from ~3s up. Cheap tasks are
                       time-bound and collect thousands either way; only the few expensive
                       tasks in a suite pay for the extra rigor. A run that ends below its
                       cost-class floor (only possible with an explicit --min-samples or
                       per-task minSamples) carries a "low-sample-count" warning.
  --jobs N|auto       suite files to run at once, each still in its own process (default: 1).
                       Concurrent CPU-bound processes contend for cores, caches and turbo
                       headroom, so numbers taken at --jobs > 1 are noisier and not
                       like-for-like with a baseline measured at 1. "auto" = CPU count.
  --gc / --no-gc      Bun.gc(true) between trials (default: off - hides allocation cost).
                       Per-task { gc } / per-group { gc } override this default; --no-gc /
                       --gc on the CLI overrides those and ostia.config.json individually,
                       so a config-wide default can be turned off for one invocation.
  --cpu / --no-cpu    capture an extra phase: "cpu" measurement per task (200ms of the
                       task looped under the JSC sampling profiler, JIT tiers included) on
                       top of its timing numbers. Per-task { cpu } / per-group { cpu }
                       override this default. Once captured, "ostia compare" reports
                       per-frame CPU deltas the same way it already does for "ostia time --cpu".
  --alloc / --no-alloc  capture an extra phase: "memstats" measurement per task: bytes
                       allocated per call, from a Bun.gc(true)-bracketed batch of 100 calls.
                       Per-task { alloc } / per-group { alloc } override this default.
  --filter REGEX      only run tasks whose "group/name" id matches this regex (substring,
                       case-sensitive; unmatched tasks are skipped, not timed)
  --isolate / --no-isolate  give every task its own subprocess instead of sharing its
                       suite file's, isolating JIT tier state and heap shape between tasks
                       the way suite files are already isolated from each other. Per-task
                       { isolate } / per-group { isolate } override this default.
                       --jobs then pools across those per-task processes, so pair a
                       higher --jobs with --isolate deliberately: overhead now scales
                       with task count, not file count.
  --timeout MS        kill a suite file's subprocess (or, under --isolate, one task's
                       dedicated subprocess) with SIGKILL if it hasn't finished after this
                       many ms. No default: unset never times out.
  --preload PATH      script imported before each suite file loads, in the same
                       subprocess (repeatable; runs in the order given). Use it to
                       install globals (jsdom's document/window) or register a
                       Bun.plugin() file-loader before the suite's own code runs.
  --bun-flags FLAGS   extra flags passed through to the \`bun\` invocation that runs each
                       suite file (repeatable; space-separated flags in one value are all
                       appended). Useful for packages whose exports map branches on a
                       resolution condition Bun doesn't set by default, e.g. Svelte/Vue's
                       "browser" vs "default" build: --bun-flags="--conditions=browser"
  --out-dir PATH      directory for scratch IPC files (default: node_modules/.cache/ostia)
  --no-noise-check    skip the ~200ms machine noise floor reference measurement
  --export-json PATH  write the full ProfileDocument to PATH
  --format FORMAT     table | json | jsonl | markdown | minimal (default: table)
                       "minimal" is protocol v1 (see README's "Using ostia from an AI
                       agent"): one JSON "run" event per task, {event, protocolVersion,
                       schemaVersion, workloadId, task, group, description, params,
                       samples, batch, mean, median, stddevPct, relative,
                       warnings[{code,data}]} in ns, no raw sample array - built to pipe
                       into an LLM agent's context.
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

Suite files register tasks like:
  import { group, task } from "<pkg>"
  group("parse", () => {
    task("small input", () => parse(smallBuf))
    task("full pipeline", () => build(), { budgetMs: 2000, minSamples: 10 })
  }, { description: "parser throughput on representative inputs" })
Per-task options override --budget / --min-samples / --gc / --isolate / --cpu / --alloc
for that task only; per-group { gc } / { isolate } / { cpu } / { alloc } set the default for
every task in that group.
Optional { description } on group() and task() flows into the document (Workload.description
/ Workload.groupDescription) so the intent travels with the numbers.

Sweep one or more dimensions with sweep(dims, fn): a cartesian product over the
dimensions, calling fn once per point. task() calls inside automatically inherit the
point as Workload.params (an explicit { params } on a task merges over it):
  import { group, task, range, sweep } from "<pkg>"
  group("parse", () => {
    sweep({ size: range(100, 10_000), impl: ["current", "fast"] }, ({ size, impl }) => {
      const input = buildInput(size) // setup, runs once per point, unmeasured
      task(\`\${impl}\`, () => impls[impl](input))
    })
  })
range(start, end, multiplier?) is the geometric point generator that feeds sweep()
(mitata's .range(), default multiplier 8, always ending on the end value).

task.skip(...) / group.skip(...) register without measuring: the document still
carries the workload (marked skipped) instead of it being absent, so a renderer
prints "- skipped" and compare reports it as unchanged with a warning rather than
silently passing. task.only(...) / group.only(...) restrict the suite file to only
the selected tasks (--filter still applies on top) and print a one-line notice to
stderr, so a forgotten .only is visible.

Project defaults: with no suite files given on the command line, ostia falls back to
ostia.config.json's "bench" section in the current directory - suites is a list of globs
(expanded with Bun.Glob), the rest are the same defaults as their matching flag:
  { "bench": { "suites": ["bench/**/*.bench.ts"], "preload": ["./bench/setup.ts"], "jobs": "auto" } }
Any suite files given on the command line replace (not merge with) the config's "suites"
list; every other flag/config field is overridden individually, so "ostia bench --jobs 1"
still works as a one-off override without editing the config.

Examples:
  ostia bench benches/parse.ts
  ostia bench --budget 1000 --min-samples 50 benches/*.ts
  ostia bench benches/*.ts --filter parse
  ostia bench benches/*.ts --jobs auto --format minimal
  ostia bench benches/*.ts --cpu --alloc
  ostia bench --preload ./bench/jsdom-setup.ts benches/*.dom.bench.ts
  ostia bench --bun-flags="--conditions=browser" bench/*.dom.bench.ts
  ostia bench                 # picks up suites/preload/jobs from ostia.config.json
`

const COMPARE_HELP = `ostia compare <base.json> <candidate.json>
ostia compare <candidate.json> --baseline <path.json>

Compare two ProfileDocuments (matched by workload id) and rank timing/frame/heap deltas.

Flags:
  --export-json PATH  write the resulting document (with comparisons) to PATH
  --format FORMAT     table | json | jsonl | markdown | minimal (default: table)
                       "minimal" is protocol v1 (see README's "Using ostia from an AI
                       agent"): a "run" event per task with delta: {medianPct, meanPct,
                       verdict, pass, ci95?, pValue?, effectiveTimingPct, matched}, an
                       "unmatched" event per workload absent from one side, and a
                       trailing "summary" event with the overall verdict and exitCode.
  --timing-pct N       override thresholds.timingPct (percent)
  --alpha N            override thresholds.alpha (Mann-Whitney significance level)
  --no-config          ignore ostia.config.ts/.json; use DEFAULT_THRESHOLDS
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

Reads ostia.config.ts/.json's "thresholds" when present (same discovery as "ostia ci"),
else DEFAULT_THRESHOLDS; --timing-pct/--alpha override individual fields on top.

Exit codes: 0 pass, 1 at least one workload regressed, 2 nothing was compared (zero
matched workloads) or a harness error (documents failed to load, or a bad flag).

Examples:
  ostia compare before.json after.json
  ostia compare after.json --baseline .ostia/baselines/main.json
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

const CI_HELP = `ostia ci [--full] [--baseline NAME] [--save-baseline]

Load ostia.config.json, run configured workloads (reusing cached results when their
fingerprint is unchanged), compare against the named baseline, and gate on regressions.

Flags:
  --full                       ignore the cache; rerun every configured workload
  --baseline NAME              baseline name (default: config's "baseline" field, or "main")
  --save-baseline              after a pass (no regressions, no harness failures), write the
                                just-measured document as the new baseline at the same path
                                just compared against - promotes today's numbers to
                                tomorrow's floor in one step.
  --export-json PATH           write the resulting document (with comparisons) to PATH
  --format FORMAT               table | json | jsonl | markdown | minimal (default: table)
  --on-missing-baseline POLICY "warn" or "fail" when a configured workload has no matching
                                row in the baseline (default: "fail" when every configured
                                workload is missing, "warn" otherwise)
  --no-noise-check             skip the ~200ms noise-floor reference measurement (default:
                                on; same as ostia.config's noiseCheck: false)
  --quiet                      suppress the rendered report entirely (still writes --export-json)
  --help                       show this message

Exit codes: 0 pass, 1 regression, 2 harness error (missing config/baseline, every trial of
a workload exited non-zero, an "onMissingBaseline: fail" mismatch, or a spawn failure).
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
  failOnNonzero: boolean
  outDir?: string
  noiseCheck: boolean
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
}

function parseTimeArgs(argv: string[]): TimeArgs {
  const args: TimeArgs = {
    commands: [],
    prepare: [],
    interleave: true,
    cpu: false,
    heap: false,
    ignoreExitCodes: [],
    failOnNonzero: false,
    noiseCheck: true,
    format: "table",
    quiet: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      // Everything after `--` is one command's argv, verbatim - not
      // whitespace-split, not further flag-parsed (an argument that happens
      // to look like a flag still belongs to the command).
      args.argvCommand = argv.slice(i + 1)
      break
    }
    if (arg === "--ignore-failure" || arg.startsWith("--ignore-failure=")) {
      const value = arg.startsWith("--ignore-failure=")
        ? arg.slice("--ignore-failure=".length)
        : undefined
      args.ignoreExitCodes.push(
        ...(value === undefined
          ? IGNORE_ALL_EXIT_CODES
          : value.split(",").map(Number)),
      )
      continue
    }
    switch (arg) {
      case "--samples":
        args.samples = parseIntFlag("--samples", argv[++i], { min: 1 })
        break
      case "--budget":
        args.budgetMs = parseIntFlag("--budget", argv[++i], { min: 1 })
        break
      case "--min-samples":
        args.minSamples = parseIntFlag("--min-samples", argv[++i], { min: 1 })
        break
      case "--warmup":
        args.warmup = parseIntFlag("--warmup", argv[++i], { min: 0 })
        break
      case "--no-interleave":
        args.interleave = false
        break
      case "--prepare":
        args.prepare.push(argv[++i] ?? "")
        break
      case "--time-source":
        args.timeSource = argv[++i]
        break
      case "--time-unit":
        args.timeUnit = argv[++i] as TimeUnit
        break
      case "--cpu":
        args.cpu = true
        break
      case "--heap":
        args.heap = true
        break
      case "--cpu-interval":
        args.cpuIntervalUs = parseIntFlag("--cpu-interval", argv[++i], {
          min: 1,
        })
        break
      case "--timeout":
        args.timeoutMs = Number(argv[++i])
        break
      case "--fail-on-nonzero":
        args.failOnNonzero = true
        break
      case "--out-dir":
        args.outDir = argv[++i]
        break
      case "--no-noise-check":
        args.noiseCheck = false
        break
      case "--export-json":
        args.exportJson = argv[++i]
        break
      case "--format":
        args.format = argv[++i] as FormatName
        break
      case "--quiet":
        args.quiet = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
      default:
        if (arg.startsWith("-")) {
          throw new CliUsageError(`Unknown flag "${arg}" for "ostia time".`)
        }
        args.commands.push(arg)
    }
  }

  return args
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

const TIME_UNITS: readonly TimeUnit[] = ["ns", "us", "ms", "s"]

async function timeCommand(argv: string[]): Promise<number> {
  let parsed: TimeArgs
  try {
    parsed = parseTimeArgs(argv)
  } catch (err) {
    return reportUsageError(err, "time")
  }
  const hasArgvCommand = (parsed.argvCommand?.length ?? 0) > 0
  if (parsed.help || (parsed.commands.length === 0 && !hasArgvCommand)) {
    process.stdout.write(TIME_HELP)
    return parsed.help ? 0 : 2
  }

  if (!checkFormat(parsed.format, DOCUMENT_FORMATS)) return 2

  const totalCommands = parsed.commands.length + (hasArgvCommand ? 1 : 0)
  if (parsed.prepare.length > 1 && parsed.prepare.length !== totalCommands) {
    writeCliError(
      "invalid-flag",
      `--prepare given ${parsed.prepare.length} times for ${totalCommands} command(s): give it once (applies to all) or once per command.`,
    )
    return 2
  }
  if (parsed.timeUnit !== undefined && !TIME_UNITS.includes(parsed.timeUnit)) {
    writeCliError(
      "invalid-flag",
      `Unknown --time-unit "${parsed.timeUnit}". Expected one of: ${TIME_UNITS.join(", ")}`,
    )
    return 2
  }
  if (parsed.timeSource !== undefined) {
    try {
      new RegExp(parsed.timeSource)
    } catch (err) {
      writeCliError(
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
        failOnNonzero: parsed.failOnNonzero,
        outDir: parsed.outDir,
        noiseCheck: parsed.noiseCheck,
        signal,
      }),
    ))
  } catch (err) {
    writeCliError("spawn-failed", `Run failed: ${errorMessage(err)}`)
    return 2
  }

  const emitCode = await emitDocument(doc, parsed)
  if (emitCode !== 0) return emitCode
  if (aborted) return 130

  // 2 (harness error), not 1: a command failing is "the harness couldn't
  // measure this cleanly", not a regression - 1 stays reserved for
  // compare/ci's verdict. A workload with no timing stats at all (every
  // trial timed out, or every trial missed --time-source) is the same kind
  // of harness-level non-result.
  const ignore = new Set(parsed.ignoreExitCodes)
  const anyUnmeasured = doc.workloads.some(
    (w) => !doc.measurements.some((m) => m.workloadId === w.id && m.timing),
  )
  const anyNonZero = doc.measurements.some((r) =>
    r.trials.some(
      (t) =>
        t.exitCode !== undefined && t.exitCode !== 0 && !ignore.has(t.exitCode),
    ),
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
    writeCliError(
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
  alloc?: boolean
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

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--bun-flags" || arg.startsWith("--bun-flags=")) {
      const value = arg.startsWith("--bun-flags=")
        ? arg.slice("--bun-flags=".length)
        : (argv[++i] ?? "")
      args.bunFlags.push(...splitCommand(value))
      continue
    }
    switch (arg) {
      case "--budget":
        args.budgetMs = parseIntFlag("--budget", argv[++i], { min: 1 })
        break
      case "--samples":
        args.samples = parseIntFlag("--samples", argv[++i], { min: 1 })
        break
      case "--min-samples":
        args.minSamples = parseIntFlag("--min-samples", argv[++i], { min: 1 })
        break
      case "--jobs":
        args.jobs = parseIntFlag("--jobs", argv[++i], {
          min: 1,
          allowAuto: true,
        })
        break
      case "--gc":
        args.gc = true
        break
      case "--no-gc":
        args.gc = false
        break
      case "--cpu":
        args.cpu = true
        break
      case "--no-cpu":
        args.cpu = false
        break
      case "--alloc":
        args.alloc = true
        break
      case "--no-alloc":
        args.alloc = false
        break
      case "--filter":
        args.filter = argv[++i]
        break
      case "--isolate":
        args.isolate = true
        break
      case "--no-isolate":
        args.isolate = false
        break
      case "--preload":
        args.preload.push(argv[++i]!)
        break
      case "--timeout":
        args.timeoutMs = Number(argv[++i])
        break
      case "--out-dir":
        args.outDir = argv[++i]
        break
      case "--no-noise-check":
        args.noiseCheck = false
        break
      case "--export-json":
        args.exportJson = argv[++i]
        break
      case "--format":
        args.format = argv[++i] as FormatName
        break
      case "--quiet":
        args.quiet = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
      default:
        if (arg.startsWith("-")) {
          throw new CliUsageError(`Unknown flag "${arg}" for "ostia bench".`)
        }
        args.suites.push(arg)
    }
  }

  return args
}

async function benchCommand(argv: string[]): Promise<number> {
  let parsed: BenchArgs
  try {
    parsed = parseBenchArgs(argv)
  } catch (err) {
    return reportUsageError(err, "bench")
  }
  if (parsed.help) {
    process.stdout.write(BENCH_HELP)
    return 0
  }

  if (!checkFormat(parsed.format, DOCUMENT_FORMATS)) return 2

  const config = await loadConfig()
  const resolved = await resolveBenchOptions(parsed, config?.bench)

  if (resolved.suites.length === 0) {
    process.stdout.write(BENCH_HELP)
    return 2
  }
  if (resolved.jobs !== undefined && !(resolved.jobs >= 1)) {
    writeCliError(
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
    writeCliError("spawn-failed", `Bench failed: ${errorMessage(err)}`)
    return 2
  }

  const emitCode = await emitDocument(doc, parsed)
  if (emitCode !== 0) return emitCode
  return aborted ? 130 : 0
}

interface CompareArgs {
  paths: string[]
  baseline?: string
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
  timingPct?: number
  alpha?: number
  noConfig: boolean
}

function parseCompareArgs(argv: string[]): CompareArgs {
  const args: CompareArgs = {
    paths: [],
    format: "table",
    quiet: false,
    help: false,
    noConfig: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--baseline":
        args.baseline = argv[++i]
        break
      case "--export-json":
        args.exportJson = argv[++i]
        break
      case "--format":
        args.format = argv[++i] as FormatName
        break
      case "--timing-pct":
        args.timingPct = parseFloatFlag("--timing-pct", argv[++i])
        break
      case "--alpha":
        args.alpha = parseFloatFlag("--alpha", argv[++i])
        break
      case "--no-config":
        args.noConfig = true
        break
      case "--quiet":
        args.quiet = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
      default:
        if (arg.startsWith("-")) {
          throw new CliUsageError(`Unknown flag "${arg}" for "ostia compare".`)
        }
        args.paths.push(arg)
    }
  }

  return args
}

/** Resolves the `Thresholds` `ostia compare` gates on: `ostia.config.*`'s
 * `thresholds` when present (same discovery as `ostia ci`) and not
 * `--no-config`, else `DEFAULT_THRESHOLDS` - then `--timing-pct`/`--alpha`
 * override individual fields on top of whichever base was picked. Returns
 * the source label a header line reports (`"ostia.config.ts"` /
 * `"ostia.config.json"` / `"defaults"`), separate from any per-flag
 * override, since a flag tweaks one field rather than switching sources. */
async function resolveCompareThresholds(
  parsed: CompareArgs,
): Promise<{ thresholds: Thresholds; source: string }> {
  let thresholds: Thresholds = DEFAULT_THRESHOLDS
  let source = "defaults"
  if (!parsed.noConfig) {
    const config = await loadConfig()
    if (config) {
      thresholds = config.thresholds
      source = (await configFilePath()) ?? "ostia.config.json"
    }
  }
  if (parsed.timingPct !== undefined || parsed.alpha !== undefined) {
    thresholds = {
      ...thresholds,
      ...(parsed.timingPct !== undefined && { timingPct: parsed.timingPct }),
      ...(parsed.alpha !== undefined && { alpha: parsed.alpha }),
    }
  }
  return { thresholds, source }
}

async function compareCommand(argv: string[]): Promise<number> {
  let parsed: CompareArgs
  try {
    parsed = parseCompareArgs(argv)
  } catch (err) {
    return reportUsageError(err, "compare")
  }
  if (parsed.help) {
    process.stdout.write(COMPARE_HELP)
    return 0
  }

  if (!checkFormat(parsed.format, DOCUMENT_FORMATS)) return 2

  let basePath: string | undefined
  let candPath: string | undefined
  if (parsed.baseline) {
    basePath = parsed.baseline
    candPath = parsed.paths[0]
  } else {
    basePath = parsed.paths[0]
    candPath = parsed.paths[1]
  }

  if (!basePath || !candPath) {
    process.stdout.write(COMPARE_HELP)
    return 2
  }

  let base: ProfileDocument, cand: ProfileDocument
  try {
    ;[base, cand] = await Promise.all([
      loadDocument(basePath),
      loadDocument(candPath),
    ])
  } catch (err) {
    writeCliError(
      "document-load-failed",
      `Failed to load documents: ${errorMessage(err)}`,
    )
    return 2
  }

  const { thresholds, source } = await resolveCompareThresholds(parsed)
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
    process.stdout.write(`thresholds: ${source}\n`)
    if (base.git && cand.git) {
      process.stdout.write(
        `base ${formatGit(base.git)} → cand ${formatGit(cand.git)}\n`,
      )
    }
    if (
      parsed.format === "table" &&
      result.summary.effectiveTimingPct > thresholds.timingPct
    ) {
      process.stdout.write(
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
    process.stdout.write(
      renderUnmatchedSection(result.unmatched, parsed.format),
    )
  }

  if (result.summary.matched === 0) {
    writeCliError(
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

function parseReportArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = { format: "table", help: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--format":
        args.format = (argv[++i] ?? "") as FormatName
        break
      case "--measurement":
        args.measurementId = argv[++i]
        break
      case "--out-dir":
        args.outDir = argv[++i]
        break
      case "--help":
      case "-h":
        args.help = true
        break
      default:
        if (arg.startsWith("-")) {
          throw new CliUsageError(`Unknown flag "${arg}" for "ostia report".`)
        }
        if (args.path !== undefined) {
          throw new CliUsageError(
            `"ostia report" takes exactly one document path, got "${args.path}" and "${arg}".`,
          )
        }
        args.path = arg
    }
  }

  return args
}

async function reportCommand(argv: string[]): Promise<number> {
  let parsed: ReportArgs
  try {
    parsed = parseReportArgs(argv)
  } catch (err) {
    return reportUsageError(err, "report")
  }
  if (parsed.help || !parsed.path) {
    process.stdout.write(REPORT_HELP)
    return parsed.help ? 0 : 2
  }

  if (!checkFormat(parsed.format, REPORT_FORMATS)) return 2

  let doc: ProfileDocument
  try {
    doc = await loadDocument(parsed.path)
  } catch (err) {
    writeCliError(
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
    writeCliError("no-cpu-evidence", NO_CPU_EVIDENCE)
    return 2
  }

  const renderer = renderers[parsed.format]
  const result = await renderer.render(doc, {
    measurementId: parsed.measurementId,
  })
  if (!result.text && (!result.files || result.files.length === 0)) {
    writeCliError(
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
  onMissingBaseline?: "warn" | "fail"
  noNoiseCheck: boolean
}

function parseCiArgs(argv: string[]): CiArgs {
  const args: CiArgs = {
    full: false,
    saveBaseline: false,
    format: "table",
    quiet: false,
    help: false,
    noNoiseCheck: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--full":
        args.full = true
        break
      case "--baseline":
        args.baseline = argv[++i]
        break
      case "--save-baseline":
        args.saveBaseline = true
        break
      case "--export-json":
        args.exportJson = argv[++i]
        break
      case "--format":
        args.format = argv[++i] as FormatName
        break
      case "--on-missing-baseline": {
        const raw = argv[++i]
        if (raw !== "warn" && raw !== "fail") {
          throw new CliUsageError(
            `Invalid --on-missing-baseline "${raw}": expected "warn" or "fail".`,
          )
        }
        args.onMissingBaseline = raw
        break
      }
      case "--no-noise-check":
        args.noNoiseCheck = true
        break
      case "--quiet":
        args.quiet = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
      default:
        throw new CliUsageError(`Unknown flag "${arg}" for "ostia ci".`)
    }
  }

  return args
}

async function ciCommand(argv: string[]): Promise<number> {
  let parsed: CiArgs
  try {
    parsed = parseCiArgs(argv)
  } catch (err) {
    return reportUsageError(err, "ci")
  }
  if (parsed.help) {
    process.stdout.write(CI_HELP)
    return 0
  }

  if (!checkFormat(parsed.format, DOCUMENT_FORMATS)) return 2

  const config = await requireConfig("ostia ci")
  if (!config) return 2

  const effectiveConfig: OstiaConfig = {
    ...config,
    ...(parsed.onMissingBaseline !== undefined && {
      onMissingBaseline: parsed.onMissingBaseline,
    }),
    ...(parsed.noNoiseCheck && { noiseCheck: false }),
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
      writeCliError("baseline-missing", err.message)
      return 2
    }
    writeCliError("spawn-failed", `CI run failed: ${errorMessage(err)}`)
    return 2
  }

  if (parsed.exportJson) {
    await saveDocument(outcome.document, parsed.exportJson)
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
    writeCliError(
      "command-failed",
      `${outcome.summary.failed} workload(s) failed (harness error, every trial exited non-zero): ${failedLabels.join(", ")}`,
    )
  }

  if (!parsed.quiet) {
    const resolvedBaselineName = parsed.baseline ?? effectiveConfig.baseline
    if (parsed.format === "table") {
      process.stdout.write(renderCiReport(outcome.summary))
      if (
        outcome.document.comparisons &&
        outcome.document.comparisons.length > 0
      ) {
        await writeRenderResult(
          await renderers.table.render(outcome.document, {}),
        )
      }
    } else if (parsed.format === "markdown") {
      process.stdout.write(
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
    process.stdout.write(BASELINE_HELP)
    return 0
  }
  if (argv.length > 1) {
    writeCliError(
      "invalid-flag",
      `"ostia baseline save" takes at most one name argument, got ${argv.length}.\nRun 'ostia baseline --help'.`,
    )
    return 2
  }
  const name = argv[0]
  if (name !== undefined) {
    const nameErr = validateBaselineName(name)
    if (nameErr) {
      writeCliError("invalid-flag", `${nameErr}\nRun 'ostia baseline --help'.`)
      return 2
    }
  }

  const config = await requireConfig("ostia baseline save")
  if (!config) return 2

  const path = await saveBaseline(config, name)
  process.stdout.write(`Wrote ${path}\n`)
  return 0
}

async function baselineListCommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(BASELINE_HELP)
    return 0
  }

  const config = await requireConfig()
  if (!config) return 2

  const infos = await listBaselines(config)
  if (infos.length === 0) {
    process.stdout.write(`No baselines found in ${config.baselineDir}.\n`)
    return 0
  }
  for (const info of infos) {
    const gitSuffix = info.git ? `\t${formatGit(info.git)}` : ""
    process.stdout.write(
      `${info.name}\t${info.workloads} workloads\tcreated ${info.createdAt}\ttoolVersion ${info.toolVersion}${gitSuffix}\n`,
    )
  }
  return 0
}

async function baselineShowCommand(argv: string[]): Promise<number> {
  const [name, ...rest] = argv
  if (!name || name === "--help" || name === "-h") {
    process.stdout.write(BASELINE_HELP)
    return name ? 0 : 2
  }
  const nameErr = validateBaselineName(name)
  if (nameErr) {
    writeCliError("invalid-flag", `${nameErr}\nRun 'ostia baseline --help'.`)
    return 2
  }

  const config = await requireConfig()
  if (!config) return 2

  return reportCommand([baselinePath(config, name), ...rest])
}

async function baselineCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  switch (sub) {
    case "save":
      return baselineSaveCommand(rest)
    case "list":
      return baselineListCommand(rest)
    case "show":
      return baselineShowCommand(rest)
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(BASELINE_HELP)
      return sub === undefined ? 2 : 0
    default:
      writeCliError(
        "invalid-flag",
        `Unknown "ostia baseline ${sub}". Run "ostia baseline --help".`,
      )
      return 2
  }
}

async function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2)

  switch (subcommand) {
    case "time":
      return timeCommand(rest)
    case "bench":
      return benchCommand(rest)
    case "compare":
      return compareCommand(rest)
    case "report":
      return reportCommand(rest)
    case "ci":
      return ciCommand(rest)
    case "baseline":
      return baselineCommand(rest)
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(
        `ostia - Bun-native profile IR engine\n\nCommands:\n  time      Time commands N times and report timing/CPU/heap\n  bench     Run in-process benchmark suites (group()/task())\n  compare   Compare two ProfileDocuments\n  report    Render a saved ProfileDocument (table/json/markdown/collapsed/mermaid/speedscope/...)\n  ci        Run configured workloads against a baseline, gate on regressions\n  baseline  Manage baseline ProfileDocuments (save/list/show)\n\nRun "ostia <command> --help" for details.\n`,
      )
      return subcommand === undefined ? 2 : 0
    default:
      writeCliError(
        "invalid-flag",
        `Unknown subcommand "${subcommand}". Run "ostia --help".`,
      )
      return 2
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code))
}
