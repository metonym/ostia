import { writeSync } from "node:fs"
import {
  AbBaseError,
  type AbProgress,
  AbSetupError,
  AbSuiteError,
  ab,
  cleanAbTrees,
} from "../ab/index.ts"
import { listBaselines, saveBaseline } from "../baseline/index.ts"
import { bench, resolveBenchOptions } from "../bench/index.ts"
import {
  BaselineError,
  BaselineNotFoundError,
  renderCiReport,
  runCi,
} from "../ci/index.ts"
import { compareDocuments, DEFAULT_THRESHOLDS } from "../compare/index.ts"
import {
  baselinePath,
  CONFIG_FILES,
  ConfigError,
  configFilePath,
  loadConfig,
  type OstiaConfig,
} from "../config/index.ts"
import { errorMessage } from "../errors.ts"
import { type CommandSpec, time } from "../index.ts"
import {
  loadDocument,
  OstiaDocumentError,
  saveDocument,
} from "../ir/document.ts"
import type { ProfileDocument, Workload } from "../ir/types.ts"
import { sideLabel } from "../measure/paired.ts"
import { isHarnessFailure } from "../measure/timing.ts"
import { formatGit, workloadLabel } from "../renderers/format.ts"
import { type FormatName, renderers } from "../renderers/index.ts"
import type { MinimalProtocolContext } from "../renderers/minimal/index.ts"
import type { TimeSource, TimeUnit } from "../spawn/index.ts"
import {
  CliUsageError,
  CONFIG_FLAGS,
  type ConfigArgs,
  flag,
  HELP_FLAGS,
  NOISE_CHECK_FLAGS,
  OUTPUT_DEFAULTS,
  OUTPUT_FLAGS,
  type OutputArgs,
  parseFlags,
  REPORT_FORMATS,
  RUN_DEFAULTS,
  RUN_FLAGS,
  type RunArgs,
  SUITE_FLAGS,
  VIZ_FORMATS,
} from "./flags.ts"
import {
  AB_HELP,
  BASELINE_HELP,
  BENCH_HELP,
  CI_HELP,
  COMPARE_HELP,
  MAIN_HELP,
  REPORT_HELP,
  TIME_HELP,
} from "./help.ts"
import {
  CliError,
  type CliErrorCode,
  emitDocument,
  exportDocument,
  orFail,
  out,
  showHelp,
  writeCliError,
  writeRenderResult,
} from "./output.ts"

const isHelpArg = (arg: string | undefined) => arg === "--help" || arg === "-h"

/** Runs `run` with SIGINT wired to its `AbortSignal`, so Ctrl-C cancels cleanly with partial results. */
async function withSigintAbort<T>(
  failure: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<{ result: T; aborted: boolean }> {
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on("SIGINT", onSigint)
  try {
    const result = await orFail("spawn-failed", failure, () =>
      run(controller.signal),
    )
    return { result, aborted: controller.signal.aborted }
  } finally {
    process.off("SIGINT", onSigint)
  }
}

/** `--config PATH`, else discovery (`undefined` when it finds nothing); a `--config` path that doesn't exist is `config-missing`. */
async function loadProjectConfig(
  configPath?: string,
): Promise<OstiaConfig | undefined> {
  const config = await loadConfig(configPath)
  if (!config && configPath !== undefined) {
    throw new CliError("config-missing", `Config file ${configPath} not found.`)
  }
  return config
}

/** Loads the project config; with `needsWorkloadsFor`, also requires at least one workload. */
async function requireConfig(
  needsWorkloadsFor?: string,
  configPath?: string,
): Promise<OstiaConfig> {
  const config = await loadProjectConfig(configPath)
  if (!config) {
    const names = CONFIG_FILES.join(" or ")
    throw new CliError(
      "config-missing",
      needsWorkloadsFor
        ? `No ${names} found. "${needsWorkloadsFor}" needs configured workloads.`
        : `No ${names} found.`,
    )
  }
  if (needsWorkloadsFor && config.workloads.length === 0) {
    const configFile = configPath ?? (await configFilePath()) ?? CONFIG_FILES[1]
    throw new CliError(
      "config-missing",
      `${configFile} has no "workloads" configured.`,
    )
  }
  return config
}

/** compare/ab/ci exit code: 2 nothing matched, 1 gate failed, 0 pass. */
function gateExitCode(summary: { matched: number; verdict: string }): number {
  return summary.matched === 0 ? 2 : summary.verdict === "fail" ? 1 : 0
}

const TIME_UNITS: readonly TimeUnit[] = ["ns", "us", "ms", "s"]

interface TimeArgs extends RunArgs {
  commands: string[]
  /** Everything after `--`: one more command, whose argv is never whitespace-split. */
  argvCommand: string[]
  /** One entry applies to every command; otherwise one per command. */
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
}

const TIME_FLAGS = {
  ...RUN_FLAGS,
  "--samples": flag.int("samples"),
  "--budget": flag.int("budgetMs"),
  "--min-samples": flag.int("minSamples"),
  "--warmup": flag.int("warmup", 0),
  "--no-interleave": flag.off("interleave"),
  "--prepare": flag.list("prepare"),
  "--time-source": flag.str("timeSource"),
  "--time-unit": flag.oneOf("timeUnit", TIME_UNITS),
  "--cpu": flag.on("cpu"),
  "--heap": flag.on("heap"),
  "--cpu-interval": flag.int("cpuIntervalUs"),
  "--ignore-failure": flag.exitCodes("ignoreExitCodes"),
}

function parseTimeArgs(argv: string[]): TimeArgs {
  const args: TimeArgs = {
    ...RUN_DEFAULTS,
    commands: [],
    argvCommand: [],
    prepare: [],
    interleave: true,
    cpu: false,
    heap: false,
    ignoreExitCodes: [],
  }
  return parseFlags(argv, {
    command: "time",
    flags: TIME_FLAGS,
    args,
    positional: (arg, a) => a.commands.push(arg),
    rest: (rest, a) => {
      a.argvCommand = rest
    },
  })
}

async function timeCommand(argv: string[]): Promise<number> {
  const parsed = parseTimeArgs(argv)
  const commandList: Array<string | string[]> = [
    ...parsed.commands,
    ...(parsed.argvCommand.length > 0 ? [parsed.argvCommand] : []),
  ]
  if (parsed.help || commandList.length === 0) {
    return showHelp(TIME_HELP, parsed.help)
  }

  if (
    parsed.prepare.length > 1 &&
    parsed.prepare.length !== commandList.length
  ) {
    throw new CliError(
      "invalid-flag",
      `--prepare given ${parsed.prepare.length} times for ${commandList.length} command(s): give it once (applies to all) or once per command.`,
    )
  }
  if (parsed.timeUnit !== undefined && parsed.timeSource === undefined) {
    throw new CliError(
      "invalid-flag",
      "--time-unit only applies with --time-source.",
    )
  }
  if (parsed.cpuIntervalUs !== undefined && !parsed.cpu) {
    throw new CliError(
      "invalid-flag",
      "--cpu-interval only applies with --cpu.",
    )
  }
  if (parsed.timeSource !== undefined) {
    try {
      new RegExp(parsed.timeSource)
    } catch (err) {
      throw new CliError(
        "invalid-flag",
        `Invalid --time-source regex: ${errorMessage(err)}`,
      )
    }
  }
  const timeSource: TimeSource | undefined =
    parsed.timeSource !== undefined
      ? { pattern: parsed.timeSource, unit: parsed.timeUnit }
      : undefined
  const commands: CommandSpec[] = commandList.map((command, i) => ({
    command,
    prepare:
      parsed.prepare.length === 1 ? parsed.prepare[0] : parsed.prepare[i],
  }))

  const { result: doc, aborted } = await withSigintAbort(
    "Run failed",
    (signal) =>
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
  )

  await emitDocument(doc, parsed)
  if (aborted) return 130

  // A failing command is exit 2 (couldn't measure), not 1: 1 is reserved for
  // compare/ci's regression verdict.
  const timingRuns = doc.workloads.map((w) =>
    doc.measurements.find((m) => m.workloadId === w.id && m.phase === "timing"),
  )
  const nonZero = timingRuns.some(
    (m) => m?.timing && isHarnessFailure(m, parsed.ignoreExitCodes),
  )
  if (nonZero || timingRuns.some((m) => !m?.timing)) {
    const warned = (code: string) =>
      doc.measurements.some((m) => m.warnings.some((w) => w.code === code))
    const code: CliErrorCode = nonZero
      ? "command-failed"
      : warned("timeout")
        ? "timeout"
        : warned("time-source-no-match")
          ? "time-source-no-match"
          : "command-failed"
    throw new CliError(
      code,
      "One or more commands failed to produce a clean measurement; see the report above for details.",
    )
  }
  return 0
}

interface SuiteArgs extends RunArgs, ConfigArgs {
  suites: string[]
  filter?: string
  preload: string[]
  bunFlags: string[]
  timeoutMs?: number
  outDir?: string
}

interface BenchArgs extends SuiteArgs {
  budgetMs?: number
  samples?: number
  minSamples?: number
  jobs?: number
  gc?: boolean
  cpu?: boolean
  cpuIntervalUs?: number
  alloc?: boolean
  peakMem?: boolean
  isolate?: boolean
}

const BENCH_FLAGS = {
  ...SUITE_FLAGS,
  "--budget": flag.int("budgetMs"),
  "--samples": flag.int("samples"),
  "--min-samples": flag.int("minSamples"),
  "--jobs": flag.int("jobs", 1, true),
  "--gc": flag.on("gc"),
  "--no-gc": flag.off("gc"),
  "--cpu": flag.on("cpu"),
  "--no-cpu": flag.off("cpu"),
  "--cpu-interval": flag.int("cpuIntervalUs"),
  "--alloc": flag.on("alloc"),
  "--no-alloc": flag.off("alloc"),
  "--peak-mem": flag.on("peakMem"),
  "--no-peak-mem": flag.off("peakMem"),
  "--isolate": flag.on("isolate"),
  "--no-isolate": flag.off("isolate"),
}

function parseBenchArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = {
    ...RUN_DEFAULTS,
    suites: [],
    preload: [],
    bunFlags: [],
  }
  return parseFlags(argv, {
    command: "bench",
    flags: BENCH_FLAGS,
    args,
    positional: (arg, a) => a.suites.push(arg),
  })
}

async function benchCommand(argv: string[]): Promise<number> {
  const parsed = parseBenchArgs(argv)
  if (parsed.help) return showHelp(BENCH_HELP, true)

  const config = await loadProjectConfig(parsed.config)
  const resolved = await resolveBenchOptions(parsed, config?.bench)

  if (resolved.suites.length === 0) return showHelp(BENCH_HELP, false)

  const { result: doc, aborted } = await withSigintAbort(
    "Bench failed",
    (signal) => bench({ ...resolved, signal }),
  )

  await emitDocument(doc, parsed)
  return aborted ? 130 : 0
}

interface AbArgs extends SuiteArgs {
  base?: string
  baseSetup: string[]
  rounds?: number
  thresholdPct?: number
  geomeanThresholdPct?: number
  confirm?: number
  alloc?: boolean
  peakMem?: boolean
  memThresholdPct?: number
  keepTrees?: number
  clean: boolean
  progress?: boolean
}

const AB_FLAGS = {
  ...SUITE_FLAGS,
  "--base": flag.str("base"),
  "--base-setup": flag.list("baseSetup"),
  "--rounds": flag.int("rounds", 3),
  "--threshold": flag.num("thresholdPct", 0),
  "--geomean-threshold": flag.num("geomeanThresholdPct", 0),
  "--confirm": flag.int("confirm", 0),
  "--alloc": flag.on("alloc"),
  "--no-alloc": flag.off("alloc"),
  "--peak-mem": flag.on("peakMem"),
  "--no-peak-mem": flag.off("peakMem"),
  "--mem-threshold": flag.num("memThresholdPct", 0),
  "--keep-trees": flag.int("keepTrees"),
  "--clean": flag.on("clean"),
  "--progress": flag.on("progress"),
  "--no-progress": flag.off("progress"),
}

/** `[ab] suite 4/13 bench/search.bench.ts · task 3/7 search/regex` */
function formatAbProgress(p: AbProgress): string {
  switch (p.phase) {
    case "setup":
      return `[ab] base setup: ${p.command}`
    case "measure":
      return `[ab] suite ${p.suite}/${p.suites} ${p.file} · pass ${p.pass}/${p.passes} · task ${p.task}/${p.tasks} ${p.label}`
    case "confirm":
      return `[ab] confirming flagged tasks · repeat ${p.repeat}/${p.repeats} ${p.label}`
    case "memory":
      return `[ab] memory · process ${p.run}/${p.runs} ${sideLabel(p.side)} ${p.label}`
  }
}

/** Progress lines on stderr, so stdout stays the report alone. On a
 * terminal, each line replaces the last, and `done()` clears it before the
 * report prints; elsewhere (a log, an agent reading a pipe), one line each.
 * Synchronous writes, so lines never interleave out of order. */
function progressWriter(tty: boolean): {
  onProgress: (p: AbProgress) => void
  done: () => void
} {
  let shown = false
  return {
    onProgress: (p) => {
      const line = formatAbProgress(p)
      if (!tty) {
        writeSync(2, `${line}\n`)
        return
      }
      const width = process.stderr.columns || 80
      writeSync(2, `\r\x1b[K${line.slice(0, width - 1)}`)
      shown = true
    },
    done: () => {
      if (shown) writeSync(2, "\r\x1b[K")
      shown = false
    },
  }
}

function parseAbArgs(argv: string[]): AbArgs {
  const args: AbArgs = {
    ...RUN_DEFAULTS,
    suites: [],
    baseSetup: [],
    preload: [],
    bunFlags: [],
    clean: false,
  }
  return parseFlags(argv, {
    command: "ab",
    flags: AB_FLAGS,
    args,
    positional: (arg, a) => a.suites.push(arg),
  })
}

async function abCommand(argv: string[]): Promise<number> {
  const parsed = parseAbArgs(argv)
  if (parsed.help) return showHelp(AB_HELP, true)

  const config = await loadProjectConfig(parsed.config)
  if (parsed.clean) {
    const removed = await cleanAbTrees({
      outDir: parsed.outDir ?? config?.bench?.outDir,
    })
    if (!parsed.quiet) {
      await Bun.write(Bun.stderr, `Removed ${removed} cached base tree(s).\n`)
    }
    return 0
  }
  // The config's suite-level `bench` settings apply; its sampling ones don't (pairing has its own rounds).
  const { suites, filter, preload, bunFlags, timeoutMs, outDir, noiseCheck } =
    await resolveBenchOptions(parsed, config?.bench)
  if (suites.length === 0) return showHelp(AB_HELP, false)

  const { isatty } = await import("node:tty")
  const tty = isatty(2)
  const progress =
    (parsed.progress ?? (tty && !parsed.quiet))
      ? progressWriter(tty)
      : undefined

  const { result: doc, aborted } = await withSigintAbort(
    "A/B run failed",
    async (signal) => {
      try {
        return await ab({
          suites,
          base: parsed.base,
          baseSetup:
            parsed.baseSetup.length > 0 ? parsed.baseSetup : config?.ab?.setup,
          rounds: parsed.rounds,
          thresholdPct: parsed.thresholdPct,
          geomeanThresholdPct: parsed.geomeanThresholdPct,
          confirm: parsed.confirm,
          alloc: parsed.alloc ?? config?.ab?.alloc,
          peakMem: parsed.peakMem ?? config?.ab?.peakMem,
          memThresholdPct:
            parsed.memThresholdPct ?? config?.ab?.memThresholdPct,
          filter,
          preload,
          bunFlags,
          timeoutMs,
          outDir,
          keepTrees: parsed.keepTrees ?? config?.ab?.keepTrees,
          noiseCheck,
          signal,
          onProgress: progress?.onProgress,
        })
      } catch (err) {
        if (err instanceof AbBaseError) {
          throw new CliError("invalid-flag", `--base: ${err.message}`)
        }
        if (err instanceof AbSetupError) {
          throw new CliError("command-failed", err.message)
        }
        if (err instanceof AbSuiteError) {
          throw new CliError("suite-failed", err.message, { side: err.side })
        }
        throw err
      } finally {
        progress?.done()
      }
    },
  )

  const summary = doc.ab!
  // Computed before rendering: `minimal`'s trailing `summary` event carries
  // it. A task that threw ran on both sides, so it counts as paired here.
  const exitCode = aborted
    ? 130
    : gateExitCode({
        matched: summary.matched + summary.threw,
        verdict: summary.verdict,
      })
  const byId = new Map(doc.workloads.map((w) => [w.id, w]))
  const workloadsFor = (ids: string[] = []) =>
    ids.flatMap((id) => byId.get(id) ?? [])
  await emitDocument(doc, parsed, {
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
  if (exitCode === 2) {
    const allNew = summary.newSuites?.length === suites.length
    await writeCliError(
      "no-matches",
      allNew
        ? `No suite exists at ${summary.base.ref}; nothing was paired. Use "ostia bench" to time new suites.`
        : `No task exists both at ${summary.base.ref} and in the working tree; nothing was paired.`,
    )
  }
  return exitCode
}

interface CompareArgs extends OutputArgs, ConfigArgs {
  paths: string[]
  baseline?: string
}

const COMPARE_FLAGS = {
  ...OUTPUT_FLAGS,
  ...CONFIG_FLAGS,
  "--baseline": flag.str("baseline"),
}

function parseCompareArgs(argv: string[]): CompareArgs {
  const args: CompareArgs = { ...OUTPUT_DEFAULTS, paths: [] }
  return parseFlags(argv, {
    command: "compare",
    flags: COMPARE_FLAGS,
    args,
    positional: (arg, a) => a.paths.push(arg),
  })
}

async function compareCommand(argv: string[]): Promise<number> {
  const parsed = parseCompareArgs(argv)
  if (parsed.help) return showHelp(COMPARE_HELP, true)

  const maxPaths = parsed.baseline ? 1 : 2
  if (parsed.paths.length > maxPaths) {
    throw new CliUsageError(
      parsed.baseline
        ? `"ostia compare --baseline" takes one candidate path, got ${parsed.paths.length}.`
        : `"ostia compare" takes two document paths, got ${parsed.paths.length}.`,
    )
  }
  const [basePath, candPath] = parsed.baseline
    ? [parsed.baseline, parsed.paths[0]]
    : parsed.paths
  if (!basePath || !candPath) return showHelp(COMPARE_HELP, false)

  const [base, cand] = await orFail(
    "document-load-failed",
    "Failed to load documents",
    () => Promise.all([loadDocument(basePath), loadDocument(candPath)]),
  )

  const config = await loadProjectConfig(parsed.config)
  const thresholds = config?.thresholds ?? DEFAULT_THRESHOLDS
  const thresholdsSource = config
    ? (parsed.config ?? (await configFilePath()) ?? CONFIG_FILES[1])
    : "defaults"
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

  // json/jsonl/minimal stay pure JSON on stdout, so only the human formats get prose banners.
  const humanFormat =
    !parsed.quiet && (parsed.format === "table" || parsed.format === "markdown")
  if (humanFormat) {
    await out(`thresholds: ${thresholdsSource}\n`)
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

  // Computed before rendering: `minimal`'s trailing `summary` event carries it.
  const exitCode = gateExitCode(result.summary)

  await emitDocument(outDoc, parsed, {
    protocol: {
      command: "compare",
      exitCode,
      unmatched: result.unmatched,
      baseGit: base.git,
      candGit: cand.git,
      ...(parsed.exportJson && { exportedTo: parsed.exportJson }),
    } satisfies MinimalProtocolContext,
  })

  if (
    humanFormat &&
    (result.unmatched.baseOnly.length > 0 ||
      result.unmatched.candOnly.length > 0)
  ) {
    await out(
      renderUnmatchedSection(result.unmatched, parsed.format === "markdown"),
    )
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
  markdown: boolean,
): string {
  const labels = (ws: Workload[]) => ws.map((w) => workloadLabel(w)).join(", ")
  const bullet = markdown ? "- " : "  "
  const lines = markdown ? ["### Unmatched", ""] : ["", "Unmatched:"]
  if (unmatched.baseOnly.length > 0)
    lines.push(`${bullet}baseline only: ${labels(unmatched.baseOnly)}`)
  if (unmatched.candOnly.length > 0)
    lines.push(`${bullet}candidate only: ${labels(unmatched.candOnly)}`)
  if (markdown) lines.push("")
  return `${lines.join("\n")}\n`
}

interface ReportArgs extends ConfigArgs {
  path?: string
  format: FormatName
  measurementId?: string
  outDir?: string
  help: boolean
}

const REPORT_FLAGS = {
  ...HELP_FLAGS,
  "--format": flag.oneOf("format", REPORT_FORMATS),
  "--measurement": flag.str("measurementId"),
  "--out-dir": flag.str("outDir"),
}

function parseReportArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = { format: "table", help: false }
  return parseFlags(argv, {
    command: "report",
    flags: REPORT_FLAGS,
    args,
    positional: (arg, a) => {
      if (a.path !== undefined) {
        throw new CliUsageError(
          `"ostia report" takes exactly one document path, got "${a.path}" and "${arg}".`,
        )
      }
      a.path = arg
    },
  })
}

const NO_CPU_EVIDENCE =
  "No CPU evidence in this document; rerun with --cpu (ostia time) or --cpu (ostia bench)"

/** Renders `path`; shared by `report` and `baseline show`. */
async function renderReport(
  path: string,
  { format, measurementId, outDir }: ReportArgs,
): Promise<number> {
  const viz = (VIZ_FORMATS as readonly string[]).includes(format)
  const inapplicable = [
    measurementId !== undefined && "--measurement",
    outDir !== undefined && "--out-dir",
  ].filter((name) => name !== false)
  if (!viz && inapplicable.length > 0) {
    throw new CliUsageError(
      `${inapplicable.join(" and ")} only apply to the visualization formats (${VIZ_FORMATS.join(", ")}), not --format ${format}.`,
    )
  }

  const doc = await orFail(
    "document-load-failed",
    `Failed to load ${path}`,
    () => loadDocument(path),
  )

  if (
    viz &&
    !measurementId &&
    !doc.measurements.some((m) => m.phase === "cpu")
  ) {
    throw new CliError("no-cpu-evidence", NO_CPU_EVIDENCE)
  }

  const result = await renderers[format].render(doc, { measurementId })
  if (!result.text && (!result.files || result.files.length === 0)) {
    throw new CliError(
      "no-cpu-evidence",
      measurementId
        ? `No CPU evidence found for measurement "${measurementId}".`
        : NO_CPU_EVIDENCE,
    )
  }
  await writeRenderResult(result, outDir)
  return 0
}

async function reportCommand(argv: string[]): Promise<number> {
  const parsed = parseReportArgs(argv)
  if (parsed.help || !parsed.path) return showHelp(REPORT_HELP, parsed.help)
  return renderReport(parsed.path, parsed)
}

interface CiArgs extends RunArgs, ConfigArgs {
  full: boolean
  baseline?: string
  saveBaseline: boolean
}

const CI_FLAGS = {
  ...OUTPUT_FLAGS,
  ...NOISE_CHECK_FLAGS,
  ...CONFIG_FLAGS,
  "--full": flag.on("full"),
  "--baseline": flag.str("baseline"),
  "--save-baseline": flag.on("saveBaseline"),
}

function parseCiArgs(argv: string[]): CiArgs {
  const args: CiArgs = { ...RUN_DEFAULTS, full: false, saveBaseline: false }
  return parseFlags(argv, { command: "ci", flags: CI_FLAGS, args })
}

const baselineMissing = (err: BaselineError) =>
  new CliError("baseline-missing", err.message)

/** Gives the two baseline problems and an unreadable baseline their own codes; anything else (a suite-not-found usage error included) falls through to `withSigintAbort`'s `orFail` like every other command. */
function ciFailure(err: unknown): never {
  if (err instanceof BaselineError) throw baselineMissing(err)
  if (err instanceof OstiaDocumentError) {
    throw new CliError("document-load-failed", err.message)
  }
  throw err
}

async function ciCommand(argv: string[]): Promise<number> {
  const parsed = parseCiArgs(argv)
  if (parsed.help) return showHelp(CI_HELP, true)

  const loaded = await requireConfig("ostia ci", parsed.config)
  const config: OstiaConfig = parsed.noiseCheck
    ? loaded
    : { ...loaded, noiseCheck: false }

  // A saved baseline must be fresh measurements, never a cached run.
  const full = parsed.full || parsed.saveBaseline
  const { result: outcome, aborted } = await withSigintAbort(
    "CI run failed",
    (signal) =>
      runCi({
        config,
        full,
        baselineName: parsed.baseline,
        signal,
      }).catch(ciFailure),
  )
  const { document, summary } = outcome
  if (aborted) {
    // Partial: no comparison, no gate, never a baseline.
    await emitDocument(document, parsed)
    return 130
  }
  const baselineName = parsed.baseline ?? config.baseline
  const baselineFile = baselinePath(config, baselineName)

  const jsonText = await exportDocument(document, parsed)

  if (parsed.saveBaseline && summary.regressed === 0 && summary.failed === 0) {
    await saveDocument(document, baselineFile)
  }

  // Computed before rendering: `minimal`'s trailing `summary` event carries it.
  const exitCode = summary.failed > 0 ? 2 : summary.regressed > 0 ? 1 : 0

  if (summary.failed > 0) {
    const failedLabels = summary.results
      .filter((r) => r.harnessFailed)
      .map((r) => workloadLabel(r.workload))
    await writeCliError(
      "command-failed",
      `${summary.failed} workload(s) failed (harness error, a command exited non-zero or produced no samples): ${failedLabels.join(", ")}`,
    )
  }

  if (parsed.quiet) return exitCode

  if (jsonText !== undefined) {
    await out(jsonText)
  } else if (parsed.format === "table") {
    await out(renderCiReport(summary))
    if (document.comparisons && document.comparisons.length > 0) {
      await writeRenderResult(await renderers.table.render(document, {}))
    }
  } else if (parsed.format === "markdown") {
    await out(
      `## ostia ci\n\nBaseline: \`${baselineName}\` (\`${baselineFile}\`) · ${summary.cached} cached, ${summary.executed} executed\n\n`,
    )
    await writeRenderResult(await renderers.markdown.render(document, {}))
  } else {
    await writeRenderResult(
      await renderers[parsed.format].render(document, {
        protocol: {
          command: "ci",
          exitCode,
          unmatched: summary.unmatched,
          baseGit: outcome.baseline.git,
          candGit: document.git,
          baseline: { name: baselineName, path: baselineFile },
          cached: summary.cached,
          executed: summary.executed,
          failed: summary.failed,
          missingBaseline: summary.missingBaseline,
          ...(parsed.exportJson && { exportedTo: parsed.exportJson }),
        } satisfies MinimalProtocolContext,
      }),
    )
  }
  return exitCode
}

const BASELINE_NAME_RE = /^[A-Za-z0-9._-]+$/

function baselineUsageError(message: string): CliError {
  return new CliError(
    "invalid-flag",
    `${message}\nRun 'ostia baseline --help'.`,
  )
}

/** The name argument isn't flag-parsed, so reject a typo'd flag instead of using it as a filename. */
function assertBaselineName(name: string): void {
  if (name.startsWith("-")) {
    throw baselineUsageError(
      `Invalid baseline name "${name}": names can't start with "-".`,
    )
  }
  if (!BASELINE_NAME_RE.test(name)) {
    throw baselineUsageError(
      `Invalid baseline name "${name}": expected to match ${BASELINE_NAME_RE}.`,
    )
  }
}

interface BaselineArgs extends ConfigArgs {
  name?: string
  help: boolean
}

const BASELINE_FLAGS = { ...HELP_FLAGS, ...CONFIG_FLAGS }

/** `baseline save`/`list`: `--config`, and for `save` one optional name (`takesName`); anything else is a usage error. */
function parseBaselineArgs(
  argv: string[],
  command: string,
  takesName: boolean,
): BaselineArgs {
  return parseFlags(argv, {
    command,
    flags: BASELINE_FLAGS,
    args: { help: false } as BaselineArgs,
    positional: (arg, a) => {
      if (!takesName) {
        throw baselineUsageError(
          `"ostia ${command}" takes no arguments, got "${arg}".`,
        )
      }
      if (a.name !== undefined) {
        throw baselineUsageError(
          `"ostia ${command}" takes at most one name argument, got "${a.name}" and "${arg}".`,
        )
      }
      a.name = arg
    },
  })
}

async function baselineSaveCommand(argv: string[]): Promise<number> {
  const {
    name,
    help,
    config: configPath,
  } = parseBaselineArgs(argv, "baseline save", true)
  if (help) return showHelp(BASELINE_HELP, true)
  if (name !== undefined) assertBaselineName(name)

  const config = await requireConfig("ostia baseline save", configPath)
  await out(`Wrote ${await saveBaseline(config, name)}\n`)
  return 0
}

async function baselineListCommand(argv: string[]): Promise<number> {
  const { help, config: configPath } = parseBaselineArgs(
    argv,
    "baseline list",
    false,
  )
  if (help) return showHelp(BASELINE_HELP, true)

  const config = await requireConfig(undefined, configPath)
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
  if (!name || isHelpArg(name)) return showHelp(BASELINE_HELP, !!name)
  assertBaselineName(name)

  const parsed = parseFlags(rest, {
    command: "baseline show",
    flags: { ...REPORT_FLAGS, ...CONFIG_FLAGS },
    args: { format: "table", help: false } as ReportArgs,
    positional: (arg) => {
      throw baselineUsageError(
        `"ostia baseline show" takes one name, got "${name}" and "${arg}".`,
      )
    },
  })
  if (parsed.help) return showHelp(REPORT_HELP, true)

  const config = await requireConfig(undefined, parsed.config)
  const path = baselinePath(config, name)
  if (!(await Bun.file(path).exists())) {
    throw baselineMissing(new BaselineNotFoundError(path))
  }
  return renderReport(path, parsed)
}

type Handler = (argv: string[]) => Promise<number>

/** Shared by `main()` and `baselineCommand()`: no sub-name prints `help`, a known one runs, anything else is exit 2. */
async function dispatchSubcommand(
  sub: string | undefined,
  rest: string[],
  handlers: Record<string, Handler>,
  help: string,
  unknownMessage: (sub: string) => string,
  commandPrefix = "",
): Promise<number> {
  if (sub === undefined || isHelpArg(sub))
    return showHelp(help, sub !== undefined)
  const handler = Object.hasOwn(handlers, sub) ? handlers[sub] : undefined
  try {
    if (!handler) throw new CliError("invalid-flag", unknownMessage(sub))
    return await handler(rest)
  } catch (err) {
    if (err instanceof CliError) {
      await writeCliError(err.code, err.message, err.data)
    } else if (err instanceof ConfigError) {
      await writeCliError("config-invalid", err.message)
    } else if (err instanceof CliUsageError) {
      await writeCliError(
        "invalid-flag",
        `${err.message}\nRun 'ostia ${commandPrefix}${sub} --help'.`,
      )
    } else {
      await writeCliError(
        "internal",
        `Internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      )
    }
    return 2
  }
}

function baselineCommand(argv: string[]): Promise<number> {
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

export function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2)
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
