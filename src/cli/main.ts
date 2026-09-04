#!/usr/bin/env bun
import { bench } from "../bench/index.ts"
import { BaselineNotFoundError, renderCiReport, runCi } from "../ci/index.ts"
import { compareDocuments } from "../compare/index.ts"
import { loadConfig } from "../config/index.ts"
import { run } from "../index.ts"
import { loadDocument, saveDocument } from "../ir/document.ts"
import type { ProfileDocument } from "../ir/types.ts"
import {
  type FormatName,
  type RenderResult,
  renderers,
} from "../renderers/index.ts"

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

const RUN_HELP = `ostia run [flags] <command...>

Run one or more commands N times with warmup and report timing statistics.

Flags:
  --runs N            exact number of timed trials (default: hyperfine-style auto)
  --warmup N          warmup trials, discarded (default: 3)
  --cpu               capture one instrumented CPU-profile trial (subprocess --cpu-prof)
  --heap              capture one instrumented heap-snapshot trial (subprocess --heap-prof)
  --cpu-interval USEC CPU sampling interval in microseconds (default: 1000)
  --out-dir PATH      directory for captured artifacts (default: .ostia)
  --export-json PATH  write the full ProfileDocument to PATH
  --format FORMAT     table | json (default: table)
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

Instrumented runs (--cpu, --heap) are labeled separately from clean timing and never
mixed into the timing statistics.

Examples:
  ostia run "bun ./fixtures/work.ts"
  ostia run --runs 25 --warmup 3 "bun a.ts" "bun b.ts"
  ostia run --cpu --heap "bun src/server.ts"
  ostia run --format json "bun a.ts"
`

const BENCH_HELP = `ostia bench [flags] <suite.ts...>

Run in-process benchmark suites (registered via group()/task()). Each suite file runs
in its own spawned child process (isolated from CLI startup state).

Flags:
  --time-budget MS    time budget per task, min-samples permitting (default: 500)
  --min-samples N     minimum samples per task (default: 20)
  --gc                Bun.gc(true) between trials (default: off - hides allocation cost)
  --out-dir PATH      directory for scratch IPC files (default: .ostia)
  --export-json PATH  write the full ProfileDocument to PATH
  --format FORMAT     table | json (default: table)
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

Suite files register tasks like:
  import { group, task } from "<pkg>"
  group("parse", () => {
    task("small input", () => parse(smallBuf))
  })

Examples:
  ostia bench benches/parse.ts
  ostia bench --time-budget 1000 --min-samples 50 benches/*.ts
`

const COMPARE_HELP = `ostia compare <base.json> <candidate.json>
ostia compare <candidate.json> --baseline <path.json>

Compare two ProfileDocuments (matched by workload id) and rank timing/frame/heap deltas.

Flags:
  --export-json PATH  write the resulting document (with comparisons) to PATH
  --format FORMAT     table | json (default: table)
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

Examples:
  ostia compare before.json after.json
  ostia compare after.json --baseline .ostia/baselines/main.json
`

const REPORT_HELP = `ostia report <document.json> [--format table|json|markdown|jsonl]

Render a saved ProfileDocument.
`

const VIZ_HELP = `ostia viz <document.json> --format FORMAT [--run <id>] [--out-dir PATH]

Render CPU evidence from a saved ProfileDocument as a visualization artifact. Files,
not a GUI - hand the output to speedscope.app, flamegraph.pl, or
a Mermaid renderer.

Formats:
  ascii        ranked self-time table (alias for the table renderer)
  collapsed    folded stacks: "root;a;b 42" - flamegraph.pl and most flame tooling
  mermaid      call tree, top-15 frames by total time (never the whole profile)
  speedscope   sampled profile JSON for speedscope.app
  cpuprofile   verbatim .cpuprofile pass-through (cpu-prof/inspector origins only)

Flags:
  --run <id>    render only this run (default: every CPU run in the document)
  --out-dir PATH  write artifacts here instead of stdout
  --help        show this message

Examples:
  ostia viz run.json --format speedscope --out-dir .ostia/viz
  ostia viz run.json --format collapsed | flamegraph.pl > flame.svg
`

const CI_HELP = `ostia ci [--full] [--baseline NAME]

Load ostia.config.json, run configured workloads (reusing cached results when their
fingerprint is unchanged), compare against the named baseline, and gate on regressions.

Flags:
  --full              ignore the cache; rerun every configured workload
  --baseline NAME      baseline name (default: config's "baseline" field, or "main")
  --export-json PATH  write the resulting document (with comparisons) to PATH
  --quiet             suppress the rendered report (still writes --export-json)
  --help              show this message

Exit codes: 0 pass, 1 regression, 2 harness error (missing config/baseline, spawn failure).
`

interface RunArgs {
  commands: string[]
  runs?: number
  warmup?: number
  cpu: boolean
  heap: boolean
  cpuIntervalUs?: number
  outDir?: string
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
}

function parseRunArgs(argv: string[]): RunArgs {
  const commands: string[] = []
  let runs: number | undefined
  let warmup: number | undefined
  let cpu = false
  let heap = false
  let cpuIntervalUs: number | undefined
  let outDir: string | undefined
  let exportJson: string | undefined
  let format: FormatName = "table"
  let quiet = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--runs":
        runs = Number(argv[++i])
        break
      case "--warmup":
        warmup = Number(argv[++i])
        break
      case "--cpu":
        cpu = true
        break
      case "--heap":
        heap = true
        break
      case "--cpu-interval":
        cpuIntervalUs = Number(argv[++i])
        break
      case "--out-dir":
        outDir = argv[++i]
        break
      case "--export-json":
        exportJson = argv[++i]
        break
      case "--format":
        format = argv[++i] as FormatName
        break
      case "--quiet":
        quiet = true
        break
      case "--help":
      case "-h":
        help = true
        break
      default:
        commands.push(arg)
    }
  }

  return {
    commands,
    runs,
    warmup,
    cpu,
    heap,
    cpuIntervalUs,
    outDir,
    exportJson,
    format,
    quiet,
    help,
  }
}

async function runCommand(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv)
  if (parsed.help || parsed.commands.length === 0) {
    process.stdout.write(RUN_HELP)
    return parsed.help ? 0 : 2
  }

  if (!(parsed.format in renderers)) {
    process.stderr.write(
      `Unknown --format "${parsed.format}". Expected one of: ${Object.keys(renderers).join(", ")}\n`,
    )
    return 2
  }

  let doc: ProfileDocument
  try {
    doc = await run({
      commands: parsed.commands,
      runs: parsed.runs,
      warmup: parsed.warmup,
      cpu: parsed.cpu,
      heap: parsed.heap,
      cpuIntervalUs: parsed.cpuIntervalUs,
      outDir: parsed.outDir,
    })
  } catch (err) {
    process.stderr.write(
      `Run failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }

  if (parsed.exportJson) {
    await saveDocument(doc, parsed.exportJson)
  }

  if (!parsed.quiet) {
    const renderer = renderers[parsed.format]
    const result = await renderer.render(doc, {})
    await writeRenderResult(result)
  }

  const anyNonZero = doc.runs.some((r) =>
    r.trials.some((t) => t.exitCode !== undefined && t.exitCode !== 0),
  )
  return anyNonZero ? 1 : 0
}

interface BenchArgs {
  suites: string[]
  timeBudgetMs?: number
  minSamples?: number
  gc: boolean
  outDir?: string
  exportJson?: string
  format: FormatName
  quiet: boolean
  help: boolean
}

function parseBenchArgs(argv: string[]): BenchArgs {
  const suites: string[] = []
  let timeBudgetMs: number | undefined
  let minSamples: number | undefined
  let gc = false
  let outDir: string | undefined
  let exportJson: string | undefined
  let format: FormatName = "table"
  let quiet = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--time-budget":
        timeBudgetMs = Number(argv[++i])
        break
      case "--min-samples":
        minSamples = Number(argv[++i])
        break
      case "--gc":
        gc = true
        break
      case "--out-dir":
        outDir = argv[++i]
        break
      case "--export-json":
        exportJson = argv[++i]
        break
      case "--format":
        format = argv[++i] as FormatName
        break
      case "--quiet":
        quiet = true
        break
      case "--help":
      case "-h":
        help = true
        break
      default:
        suites.push(arg)
    }
  }

  return {
    suites,
    timeBudgetMs,
    minSamples,
    gc,
    outDir,
    exportJson,
    format,
    quiet,
    help,
  }
}

async function benchCommand(argv: string[]): Promise<number> {
  const parsed = parseBenchArgs(argv)
  if (parsed.help || parsed.suites.length === 0) {
    process.stdout.write(BENCH_HELP)
    return parsed.help ? 0 : 2
  }

  if (!(parsed.format in renderers)) {
    process.stderr.write(
      `Unknown --format "${parsed.format}". Expected one of: ${Object.keys(renderers).join(", ")}\n`,
    )
    return 2
  }

  let doc: ProfileDocument
  try {
    doc = await bench({
      suites: parsed.suites,
      timeBudgetMs: parsed.timeBudgetMs,
      minSamples: parsed.minSamples,
      gc: parsed.gc,
      outDir: parsed.outDir,
    })
  } catch (err) {
    process.stderr.write(
      `Bench failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }

  if (parsed.exportJson) {
    await saveDocument(doc, parsed.exportJson)
  }

  if (!parsed.quiet) {
    const renderer = renderers[parsed.format]
    const result = await renderer.render(doc, {})
    await writeRenderResult(result)
  }

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
  const paths: string[] = []
  let baseline: string | undefined
  let exportJson: string | undefined
  let format: FormatName = "table"
  let quiet = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--baseline":
        baseline = argv[++i]
        break
      case "--export-json":
        exportJson = argv[++i]
        break
      case "--format":
        format = argv[++i] as FormatName
        break
      case "--quiet":
        quiet = true
        break
      case "--help":
      case "-h":
        help = true
        break
      default:
        paths.push(arg)
    }
  }

  return { paths, baseline, exportJson, format, quiet, help }
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
    process.stderr.write(
      `Failed to load documents: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }

  const comparisons = compareDocuments(base, cand)
  const outDoc = { ...cand, comparisons }

  if (parsed.exportJson) {
    await saveDocument(outDoc, parsed.exportJson)
  }

  if (!parsed.quiet) {
    const renderer = renderers[parsed.format]
    const result = await renderer.render(outDoc, {})
    await writeRenderResult(result)
  }

  const anyFail = comparisons.some((c) => c.verdict === "fail")
  return anyFail ? 1 : 0
}

interface ReportArgs {
  path?: string
  format: FormatName
  help: boolean
}

function parseReportArgs(argv: string[]): ReportArgs {
  let path: string | undefined
  let format: FormatName = "table"
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--format":
        format = argv[++i] as FormatName
        break
      case "--help":
      case "-h":
        help = true
        break
      default:
        path = arg
    }
  }

  return { path, format, help }
}

async function reportCommand(argv: string[]): Promise<number> {
  const parsed = parseReportArgs(argv)
  if (parsed.help || !parsed.path) {
    process.stdout.write(REPORT_HELP)
    return parsed.help ? 0 : 2
  }

  let doc: ProfileDocument
  try {
    doc = await loadDocument(parsed.path)
  } catch (err) {
    process.stderr.write(
      `Failed to load ${parsed.path}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }

  const renderer = renderers[parsed.format]
  const result = await renderer.render(doc, {})
  await writeRenderResult(result)
  return 0
}

interface VizArgs {
  path?: string
  format?: FormatName
  runId?: string
  outDir?: string
  help: boolean
}

const VIZ_FORMAT_ALIASES: Record<string, FormatName> = { ascii: "table" }

function parseVizArgs(argv: string[]): VizArgs {
  let path: string | undefined
  let format: FormatName | undefined
  let runId: string | undefined
  let outDir: string | undefined
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--format": {
        const raw = argv[++i] ?? ""
        format = VIZ_FORMAT_ALIASES[raw] ?? (raw as FormatName)
        break
      }
      case "--run":
        runId = argv[++i]
        break
      case "--out-dir":
        outDir = argv[++i]
        break
      case "--help":
      case "-h":
        help = true
        break
      default:
        path = arg
    }
  }

  return { path, format, runId, outDir, help }
}

async function vizCommand(argv: string[]): Promise<number> {
  const parsed = parseVizArgs(argv)
  if (parsed.help || !parsed.path || !parsed.format) {
    process.stdout.write(VIZ_HELP)
    return parsed.help ? 0 : 2
  }

  if (!(parsed.format in renderers)) {
    process.stderr.write(
      `Unknown --format "${parsed.format}". Expected one of: ${Object.keys(renderers).join(", ")}, ascii\n`,
    )
    return 2
  }

  let doc: ProfileDocument
  try {
    doc = await loadDocument(parsed.path)
  } catch (err) {
    process.stderr.write(
      `Failed to load ${parsed.path}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }

  const renderer = renderers[parsed.format]
  const result = await renderer.render(doc, { runId: parsed.runId })
  if (!result.text && (!result.files || result.files.length === 0)) {
    process.stderr.write(
      parsed.runId
        ? `No CPU evidence found for run "${parsed.runId}".\n`
        : `No CPU evidence found in this document (no cpu-phase runs). Capture some with "ostia run --cpu ...".\n`,
    )
    return 2
  }
  await writeRenderResult(result, parsed.outDir)
  return 0
}

interface CiArgs {
  full: boolean
  baseline?: string
  exportJson?: string
  quiet: boolean
  help: boolean
}

function parseCiArgs(argv: string[]): CiArgs {
  let full = false
  let baseline: string | undefined
  let exportJson: string | undefined
  let quiet = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "--full":
        full = true
        break
      case "--baseline":
        baseline = argv[++i]
        break
      case "--export-json":
        exportJson = argv[++i]
        break
      case "--quiet":
        quiet = true
        break
      case "--help":
      case "-h":
        help = true
        break
    }
  }

  return { full, baseline, exportJson, quiet, help }
}

async function ciCommand(argv: string[]): Promise<number> {
  const parsed = parseCiArgs(argv)
  if (parsed.help) {
    process.stdout.write(CI_HELP)
    return 0
  }

  const config = await loadConfig()
  if (!config) {
    process.stderr.write(
      `No ostia.config.json found. "ostia ci" needs configured workloads.\n`,
    )
    return 2
  }
  if (config.workloads.length === 0) {
    process.stderr.write(`ostia.config.json has no "workloads" configured.\n`)
    return 2
  }

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
    process.stderr.write(
      `CI run failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }

  if (parsed.exportJson) {
    await saveDocument(outcome.document, parsed.exportJson)
  }

  if (!parsed.quiet) {
    process.stdout.write(renderCiReport(outcome.summary))
  }

  return outcome.summary.regressed > 0 ? 1 : 0
}

async function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2)

  switch (subcommand) {
    case "run":
      return runCommand(rest)
    case "bench":
      return benchCommand(rest)
    case "compare":
      return compareCommand(rest)
    case "report":
      return reportCommand(rest)
    case "ci":
      return ciCommand(rest)
    case "viz":
      return vizCommand(rest)
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(
        `ostia - Bun-native profile IR engine\n\nCommands:\n  run       Run commands N times and report timing/CPU/heap\n  bench     Run in-process benchmark suites (group()/task())\n  compare   Compare two ProfileDocuments\n  report    Render a saved ProfileDocument\n  ci        Run configured workloads against a baseline, gate on regressions\n  viz       Render CPU evidence as collapsed/mermaid/speedscope/cpuprofile\n\nRun "ostia <command> --help" for details.\n`,
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
