#!/usr/bin/env bun
import { listBaselines, saveBaseline } from "../baseline/index.ts"
import { availableJobs, bench, resolveBenchOptions } from "../bench/index.ts"
import { BaselineNotFoundError, renderCiReport, runCi } from "../ci/index.ts"
import { compareDocuments } from "../compare/index.ts"
import { baselinePath, loadConfig, type OstiaConfig } from "../config/index.ts"
import { type CommandSpec, time } from "../index.ts"
import { loadDocument, saveDocument } from "../ir/document.ts"
import type { ProfileDocument } from "../ir/types.ts"
import { formatGit } from "../renderers/format.ts"
import {
  type FormatName,
  type RenderResult,
  renderers,
} from "../renderers/index.ts"
import { splitCommand, type TimeSource, type TimeUnit } from "../spawn/index.ts"

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function checkFormat(format: string): format is FormatName {
  if (format in renderers) return true
  process.stderr.write(
    `Unknown --format "${format}". Expected one of: ${Object.keys(renderers).join(", ")}\n`,
  )
  return false
}

/** Shared tail of time/bench/compare: optional --export-json, then the
 * rendered report unless --quiet. */
async function emitDocument(
  doc: ProfileDocument,
  args: { exportJson?: string; format: FormatName; quiet: boolean },
): Promise<void> {
  if (args.exportJson) await saveDocument(doc, args.exportJson)
  if (args.quiet) return
  await writeRenderResult(await renderers[args.format].render(doc, {}))
}

/** Loads the project config, printing the standard "not found" message
 * (and, when `command` is given, requiring at least one workload). */
async function requireConfig(
  command?: string,
): Promise<OstiaConfig | undefined> {
  const config = await loadConfig()
  if (!config) {
    process.stderr.write(
      command
        ? `No ostia.config.json found. "${command}" needs configured workloads.\n`
        : `No ostia.config.json found.\n`,
    )
    return undefined
  }
  if (command && config.workloads.length === 0) {
    process.stderr.write(`ostia.config.json has no "workloads" configured.\n`)
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

Time one or more commands N times with warmup and report timing statistics.

Flags:
  --samples N         exact number of timed trials
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
                       split like the commands themselves (no shell). Given once it applies
                       to every command; given once per command it pairs up in order, so the
                       same command can be timed warm and cold side by side.
  --time-source REGEX take each trial's time from the first REGEX match in the command's
                       own stdout (then stderr), capture group 1, instead of its wall clock -
                       e.g. --time-source "built in (\\d+)ms" for a build tool whose own
                       summary excludes runtime startup. Every trial must match or the run
                       aborts. Trials keep wallNs alongside the reported value.
  --time-unit UNIT    unit of the --time-source number: ns | us | ms | s (default: ms)
  --cpu               capture one instrumented CPU-profile trial (subprocess --cpu-prof)
  --heap              capture one instrumented heap-snapshot trial (subprocess --heap-prof)
  --cpu-interval USEC CPU sampling interval in microseconds (default: 1000)
  --out-dir PATH      directory for captured artifacts (default: node_modules/.cache/ostia)
  --no-noise-check    skip the ~200ms machine noise floor reference measurement
  --export-json PATH  write the full ProfileDocument to PATH
  --format FORMAT     table | json | jsonl | markdown | minimal (default: table)
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

Instrumented runs (--cpu, --heap) are labeled separately from clean timing and never
mixed into the timing statistics.

Examples:
  ostia time "bun ./fixtures/work.ts"
  ostia time --samples 25 --warmup 3 "bun a.ts" "bun b.ts"
  ostia time --no-interleave "bun a.ts" "bun b.ts"
  ostia time --prepare "rm -rf dist" "bun build.ts"
  ostia time --time-source "built in (\\d+)ms" "bun build.ts"
  ostia time --cpu --heap "bun src/server.ts"
  ostia time --format json "bun a.ts"
`

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
  --gc                Bun.gc(true) between trials (default: off - hides allocation cost).
                       Per-task { gc } / per-group { gc } override this default.
  --cpu               capture an extra phase: "cpu" measurement per task (200ms of the
                       task looped under the JSC sampling profiler, JIT tiers included) on
                       top of its timing numbers. Per-task { cpu } / per-group { cpu }
                       override this default. Once captured, "ostia compare" reports
                       per-frame CPU deltas the same way it already does for "ostia time --cpu".
  --alloc             capture an extra phase: "memstats" measurement per task: bytes
                       allocated per call, from a Bun.gc(true)-bracketed batch of 100 calls.
                       Per-task { alloc } / per-group { alloc } override this default.
  --filter REGEX      only run tasks whose "group/name" id matches this regex (substring,
                       case-sensitive; unmatched tasks are skipped, not timed)
  --isolate           give every task its own subprocess instead of sharing its suite
                       file's, isolating JIT tier state and heap shape between tasks the
                       way suite files are already isolated from each other. Per-task
                       { isolate } / per-group { isolate } override this default.
                       --jobs then pools across those per-task processes, so pair a
                       higher --jobs with --isolate deliberately: overhead now scales
                       with task count, not file count.
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
                       "minimal" is one compact JSON object per task with no raw sample
                       array: {task, group, description, params, samples, mean, median,
                       stddevPct, relative, warnings[{code,data}]} in ns - built to pipe
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
                       "minimal" adds delta: {medianPct, verdict, pass} to each task line
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

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
  --full              ignore the cache; rerun every configured workload
  --baseline NAME      baseline name (default: config's "baseline" field, or "main")
  --save-baseline     after a pass (no regressions), write the just-measured document as
                       the new baseline at the same path just compared against - promotes
                       today's numbers to tomorrow's floor in one step.
  --export-json PATH  write the resulting document (with comparisons) to PATH
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

Exit codes: 0 pass, 1 regression, 2 harness error (missing config/baseline, spawn failure).
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
  /** One entry applies to every command; N entries pair with N commands. */
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
    noiseCheck: true,
    format: "table",
    quiet: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--samples":
        args.samples = Number(argv[++i])
        break
      case "--budget":
        args.budgetMs = Number(argv[++i])
        break
      case "--min-samples":
        args.minSamples = Number(argv[++i])
        break
      case "--warmup":
        args.warmup = Number(argv[++i])
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
        args.cpuIntervalUs = Number(argv[++i])
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
        args.commands.push(arg)
    }
  }

  return args
}

const TIME_UNITS: readonly TimeUnit[] = ["ns", "us", "ms", "s"]

async function timeCommand(argv: string[]): Promise<number> {
  const parsed = parseTimeArgs(argv)
  if (parsed.help || parsed.commands.length === 0) {
    process.stdout.write(TIME_HELP)
    return parsed.help ? 0 : 2
  }

  if (!checkFormat(parsed.format)) return 2

  if (
    parsed.prepare.length > 1 &&
    parsed.prepare.length !== parsed.commands.length
  ) {
    process.stderr.write(
      `--prepare given ${parsed.prepare.length} times for ${parsed.commands.length} command(s): give it once (applies to all) or once per command.\n`,
    )
    return 2
  }
  if (parsed.timeUnit !== undefined && !TIME_UNITS.includes(parsed.timeUnit)) {
    process.stderr.write(
      `Unknown --time-unit "${parsed.timeUnit}". Expected one of: ${TIME_UNITS.join(", ")}\n`,
    )
    return 2
  }
  if (parsed.timeSource !== undefined) {
    try {
      new RegExp(parsed.timeSource)
    } catch (err) {
      process.stderr.write(
        `Invalid --time-source regex: ${errorMessage(err)}\n`,
      )
      return 2
    }
  }
  const timeSource: TimeSource | undefined =
    parsed.timeSource !== undefined
      ? { pattern: parsed.timeSource, unit: parsed.timeUnit }
      : undefined
  const commands: CommandSpec[] = parsed.commands.map((command, i) => ({
    command,
    prepare:
      parsed.prepare.length === 1 ? parsed.prepare[0] : parsed.prepare[i],
  }))

  let doc: ProfileDocument
  try {
    doc = await time({
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
      outDir: parsed.outDir,
      noiseCheck: parsed.noiseCheck,
    })
  } catch (err) {
    process.stderr.write(`Run failed: ${errorMessage(err)}\n`)
    return 2
  }

  await emitDocument(doc, parsed)

  const anyNonZero = doc.measurements.some((r) =>
    r.trials.some((t) => t.exitCode !== undefined && t.exitCode !== 0),
  )
  return anyNonZero ? 1 : 0
}

interface BenchArgs {
  suites: string[]
  budgetMs?: number
  samples?: number
  minSamples?: number
  jobs?: number
  gc: boolean
  cpu: boolean
  alloc: boolean
  filter?: string
  isolate: boolean
  preload: string[]
  bunFlags: string[]
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
    gc: false,
    cpu: false,
    alloc: false,
    isolate: false,
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
        args.budgetMs = Number(argv[++i])
        break
      case "--samples":
        args.samples = Number(argv[++i])
        break
      case "--min-samples":
        args.minSamples = Number(argv[++i])
        break
      case "--jobs": {
        const raw = argv[++i]
        args.jobs = raw === "auto" ? availableJobs() : Number(raw)
        break
      }
      case "--gc":
        args.gc = true
        break
      case "--cpu":
        args.cpu = true
        break
      case "--alloc":
        args.alloc = true
        break
      case "--filter":
        args.filter = argv[++i]
        break
      case "--isolate":
        args.isolate = true
        break
      case "--preload":
        args.preload.push(argv[++i]!)
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
        args.suites.push(arg)
    }
  }

  return args
}

async function benchCommand(argv: string[]): Promise<number> {
  const parsed = parseBenchArgs(argv)
  if (parsed.help) {
    process.stdout.write(BENCH_HELP)
    return 0
  }

  if (!checkFormat(parsed.format)) return 2

  const config = await loadConfig()
  const resolved = await resolveBenchOptions(parsed, config?.bench)

  if (resolved.suites.length === 0) {
    process.stdout.write(BENCH_HELP)
    return 2
  }
  if (resolved.jobs !== undefined && !(resolved.jobs >= 1)) {
    process.stderr.write(`--jobs expects a positive integer or "auto".\n`)
    return 2
  }

  let doc: ProfileDocument
  try {
    doc = await bench(resolved)
  } catch (err) {
    process.stderr.write(`Bench failed: ${errorMessage(err)}\n`)
    return 2
  }

  await emitDocument(doc, parsed)
  return 0
}

interface CompareArgs {
  paths: string[]
  baseline?: string
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
}

function parseCompareArgs(argv: string[]): CompareArgs {
  const args: CompareArgs = {
    paths: [],
    format: "table",
    quiet: false,
    help: false,
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
      case "--quiet":
        args.quiet = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
      default:
        args.paths.push(arg)
    }
  }

  return args
}

async function compareCommand(argv: string[]): Promise<number> {
  const parsed = parseCompareArgs(argv)
  if (parsed.help) {
    process.stdout.write(COMPARE_HELP)
    return 0
  }

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
    process.stderr.write(`Failed to load documents: ${errorMessage(err)}\n`)
    return 2
  }

  const comparisons = compareDocuments(base, cand)
  const outDoc = { ...cand, comparisons }

  if (!parsed.quiet && base.git && cand.git) {
    process.stdout.write(
      `base ${formatGit(base.git)} → cand ${formatGit(cand.git)}\n`,
    )
  }
  await emitDocument(outDoc, parsed)

  const anyFail = comparisons.some((c) => c.verdict === "fail")
  return anyFail ? 1 : 0
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
        args.path = arg
    }
  }

  return args
}

async function reportCommand(argv: string[]): Promise<number> {
  const parsed = parseReportArgs(argv)
  if (parsed.help || !parsed.path) {
    process.stdout.write(REPORT_HELP)
    return parsed.help ? 0 : 2
  }

  if (!checkFormat(parsed.format)) return 2

  let doc: ProfileDocument
  try {
    doc = await loadDocument(parsed.path)
  } catch (err) {
    process.stderr.write(
      `Failed to load ${parsed.path}: ${errorMessage(err)}\n`,
    )
    return 2
  }

  const renderer = renderers[parsed.format]
  const result = await renderer.render(doc, {
    measurementId: parsed.measurementId,
  })
  if (!result.text && (!result.files || result.files.length === 0)) {
    process.stderr.write(
      parsed.measurementId
        ? `No CPU evidence found for measurement "${parsed.measurementId}".\n`
        : `No CPU evidence found in this document (no cpu-phase measurements). Capture some with "ostia time --cpu ...".\n`,
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
  quiet: boolean
  help: boolean
}

function parseCiArgs(argv: string[]): CiArgs {
  const args: CiArgs = {
    full: false,
    saveBaseline: false,
    quiet: false,
    help: false,
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
      case "--quiet":
        args.quiet = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
    }
  }

  return args
}

async function ciCommand(argv: string[]): Promise<number> {
  const parsed = parseCiArgs(argv)
  if (parsed.help) {
    process.stdout.write(CI_HELP)
    return 0
  }

  const config = await requireConfig("ostia ci")
  if (!config) return 2

  let outcome: Awaited<ReturnType<typeof runCi>>
  try {
    outcome = await runCi({
      config,
      full: parsed.full,
      baselineName: parsed.baseline,
    })
  } catch (err) {
    if (err instanceof BaselineNotFoundError) {
      process.stderr.write(`${err.message}\n`)
      return 2
    }
    process.stderr.write(`CI run failed: ${errorMessage(err)}\n`)
    return 2
  }

  if (parsed.exportJson) {
    await saveDocument(outcome.document, parsed.exportJson)
  }

  if (parsed.saveBaseline && outcome.summary.regressed === 0) {
    await saveDocument(outcome.document, baselinePath(config, parsed.baseline))
  }

  if (!parsed.quiet) {
    process.stdout.write(renderCiReport(outcome.summary))
  }

  return outcome.summary.regressed > 0 ? 1 : 0
}

async function baselineSaveCommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(BASELINE_HELP)
    return 0
  }
  const name = argv[0]

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
      process.stderr.write(
        `Unknown "ostia baseline ${sub}". Run "ostia baseline --help".\n`,
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
      process.stderr.write(
        `Unknown subcommand "${subcommand}". Run "ostia --help".\n`,
      )
      return 2
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code))
}
