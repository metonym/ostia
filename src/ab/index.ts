import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from "node:fs"
import { mkdir } from "node:fs/promises"
import { relative, sep } from "node:path"
import {
  absolutePath,
  assertSuiteExists,
  captureRunEnvironment,
  median,
  PEAK_MEM_PROCESSES,
  peakHiddenWarning,
  removeDir,
  runRunnerProcess,
  stampRunWarnings,
  uniqueTmpDir,
} from "../bench/support.ts"
import { DEFAULT_OUT_DIR } from "../config/index.ts"
import { OstiaUsageError } from "../errors.ts"
import { createDocument, loadDocument } from "../ir/document.ts"
import { fp } from "../ir/fp.ts"
import type {
  AbSummary,
  Measurement,
  PairedEvidence,
  ProfileDocument,
  Workload,
} from "../ir/types.ts"
import { comparable, memoryChange, type Side } from "../measure/paired.ts"
import { assertSamplingOptions } from "../measure/timing.ts"
import type {
  AbMemoryResult,
  AbMemoryTask,
  AbRunnerOpts,
  AbRunnerPlan,
  AbRunnerProgress,
} from "./ab-runner.ts"

/** What `ab()` is doing, for `onProgress`. Counts start at 1. */
export type AbProgress =
  | { phase: "setup"; command: string }
  | {
      phase: "measure"
      suite: number
      suites: number
      file: string
      task: number
      tasks: number
      label: string
    }
  | { phase: "confirm"; repeat: number; repeats: number; label: string }
  | { phase: "memory"; run: number; runs: number; side: Side; label: string }

export interface AbOptions {
  suites: string[]
  /** Git ref whose committed tree is the base side (default: `"HEAD"`); the
   * candidate is the working tree, uncommitted changes included. */
  base?: string
  /** Rounds per workload, each one base batch and one candidate batch of
   * about 10ms (default: 15). */
  rounds?: number
  /** Flag a workload whose median candidate/base ratio moves past this many
   * percent (default: 10). */
  thresholdPct?: number
  /** Fail when the geometric mean of all workloads' ratios is slower than
   * this many percent (default: 1.5): a broad slowdown too small to flag any
   * one workload. */
  geomeanThresholdPct?: number
  /** Fresh-process repeats of each flagged workload, which only counts when
   * every repeat flags it the same way (default: 2; 0 trusts the first). */
  confirm?: number
  filter?: string
  preload?: string[]
  bunFlags?: string[]
  outDir?: string
  cwd?: string
  noiseCheck?: boolean
  /** Also compare each side's retained heap per call (see
   * `bench({ alloc })`) and how far its first call raises RSS (see
   * `bench({ peakMem })`), each the median of 3 fresh processes per side.
   * Task/group options override these. */
  alloc?: boolean
  peakMem?: boolean
  /** Flag a memory reading that moves past this many percent of the base's
   * and past its noise floor (default: 10). A memory regression fails the
   * run. */
  memThresholdPct?: number
  /** Shell commands run once, in order, in a freshly extracted base tree
   * before it's used: to build what the suites import but git doesn't hold
   * (generated or gitignored files). Each runs with its cwd at the tree's
   * counterpart of `cwd`, the project's `node_modules` linked in, and
   * `OSTIA_AB_SHA` / `OSTIA_AB_CANDIDATE_DIR` (the working tree's `cwd`) in
   * its environment. The tree is cached per commit and command list. */
  baseSetup?: string | string[]
  /** Base trees to keep under `<outDir>/ab`, counting this run's: after a
   * run, older ones go, least recently used first, unless one was used in
   * the last hour (another run may still need it). Default: 5. */
  keepTrees?: number
  /** SIGKILLs a runner process (one suite file or repeat), or a `baseSetup`
   * command, after this many ms. */
  timeoutMs?: number
  /** Aborting kills the running process and resolves with the suites that
   * had finished, plus an `aborted` warning; unrun repeats leave their
   * workloads unconfirmed. */
  signal?: AbortSignal
  /** Called as each setup command, task, confirmation repeat and memory
   * process starts. */
  onProgress?: (progress: AbProgress) => void
}

/** `ab()` can't run: not in a git repository, or `base` isn't a commit. */
export class AbBaseError extends OstiaUsageError {}

/** A `baseSetup` command exited non-zero or timed out. The message names
 * the command and ends with the tail of its output. */
export class AbSetupError extends Error {}

const RUNNER_PATH = new URL("./ab-runner.ts", import.meta.url).pathname

const DEFAULTS = {
  keepTrees: 5,
  base: "HEAD",
  rounds: 15,
  thresholdPct: 10,
  geomeanThresholdPct: 1.5,
  memThresholdPct: 10,
  confirm: 2,
}

// RSS moves by pages and allocator chunks, and fresh processes differ by
// a few hundred KiB on small readings. A peak change smaller than this
// isn't counted.
const PEAK_NOISE_BYTES = 1024 * 1024
// The JSC heap grows in blocks, so a batch that keeps nothing can still
// read a block or two of growth. A retained change smaller than this over
// the batch isn't counted.
const RETAINED_NOISE_BYTES = 16 * 1024

function git(args: string[], cwd: string): string | undefined {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  })
  return proc.success ? proc.stdout.toString().trim() : undefined
}

// Appended to every base-tree script so no file is byte-identical to its
// working-tree copy: JSC's code cache shares compiled code between identical
// sources, and whichever copy was imported (and warmed) first ran 5-15%
// faster in A/A runs. A statement, not a comment: Bun's transpiler strips
// comments and inert expressions.
const BASE_SALT = "\n;globalThis.__ostia_ab_base__;\n"
const SCRIPT_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"

async function saltScripts(dir: string): Promise<void> {
  for await (const file of new Bun.Glob(SCRIPT_GLOB).scan({
    cwd: dir,
    dot: true,
    absolute: true,
  })) {
    // A committed symlink can point outside the tree.
    if (/\.d\.[mc]?ts$/.test(file) || !lstatSync(file).isFile()) continue
    appendFileSync(file, BASE_SALT)
  }
}

interface TreeSetup {
  commands: string[]
  /** The project root and the directory `ab()` runs from, in the working
   * tree. */
  toplevel: string
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (progress: AbProgress) => void
}

/** Where the base tree for `sha` lives: `<sha>`, or with setup commands,
 * `<sha>-<hash of the commands>`, so changing them builds a new tree. */
function treeDir(abDir: string, sha: string, commands: string[]): string {
  if (commands.length === 0) return `${abDir}/${sha}`
  return `${abDir}/${sha}-${fp("ab-setup", commands).slice(-8)}`
}

const SETUP_OUTPUT_LINES = 20
// A failed command shows only the tail of its output, so no more is kept.
const SETUP_OUTPUT_BYTES = 64 * 1024
// How long a command's output may stay open once its process group is
// killed. Only a descendant that left the group can hold it open longer.
const SETUP_DRAIN_MS = 1000

/** Reads `stream` as text in the background, keeping its last
 * `SETUP_OUTPUT_BYTES`. `stop()` cancels the read and returns the text. */
function readTail(stream: ReadableStream<Uint8Array>): {
  done: Promise<void>
  stop: () => Promise<string>
} {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        text = (text + decoder.decode(chunk.value, { stream: true })).slice(
          -SETUP_OUTPUT_BYTES,
        )
      }
    } catch {
      // Cancelled by `stop()`.
    }
  })()
  return {
    done,
    stop: async () => {
      await reader.cancel().catch(() => {})
      await done
      return text
    },
  }
}

/** Runs one setup command in its own process group. A timeout, a cancel,
 * or the command's own exit kills the whole group, so no child it started
 * can hold the output pipes open or write into the tree later. */
async function runSetupCommand(
  command: string,
  dir: string,
  env: Record<string, string | undefined>,
  setup: TreeSetup,
): Promise<{ exitCode: number; timedOut: boolean; output: string }> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  })
  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      // The whole group has exited already.
    }
  }
  let timedOut = false
  const timer =
    setup.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          killGroup()
        }, setup.timeoutMs)
  setup.signal?.addEventListener("abort", killGroup)
  if (setup.signal?.aborted) killGroup()
  const stdout = readTail(proc.stdout)
  const stderr = readTail(proc.stderr)
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const exitCode = await proc.exited
    killGroup()
    await Promise.race([
      Promise.all([stdout.done, stderr.done]),
      new Promise((resolve) => {
        drainTimer = setTimeout(resolve, SETUP_DRAIN_MS)
      }),
    ])
    const [out, err] = await Promise.all([stdout.stop(), stderr.stop()])
    return { exitCode, timedOut, output: err.trim() || out.trim() }
  } finally {
    clearTimeout(timer)
    clearTimeout(drainTimer)
    setup.signal?.removeEventListener("abort", killGroup)
  }
}

/** Runs `setup.commands` in the extracted tree at `tree`. Build scripts
 * often read `./node_modules/...` by relative path, which walking up to the
 * project's `node_modules` doesn't satisfy, so the project's is linked into
 * the tree while they run and unlinked before the salt pass. Returns false
 * when `signal` aborted a command. */
async function runSetup(
  tree: string,
  sha: string,
  setup: TreeSetup,
): Promise<boolean> {
  const toplevel = realpathSync(setup.toplevel)
  const cwd = realpathSync(setup.cwd)
  const sub = relative(toplevel, cwd)
  const dir = sub && existsSync(`${tree}/${sub}`) ? `${tree}/${sub}` : tree
  const links: string[] = []
  for (const [from, to] of [
    [`${toplevel}/node_modules`, `${tree}/node_modules`],
    [`${cwd}/node_modules`, `${dir}/node_modules`],
  ] as const) {
    if (!existsSync(from) || existsSync(to)) continue
    symlinkSync(from, to)
    links.push(to)
  }
  try {
    for (const command of setup.commands) {
      setup.onProgress?.({ phase: "setup", command })
      const { exitCode, timedOut, output } = await runSetupCommand(
        command,
        dir,
        { ...process.env, OSTIA_AB_SHA: sha, OSTIA_AB_CANDIDATE_DIR: cwd },
        setup,
      )
      if (setup.signal?.aborted) return false
      if (exitCode === 0 && !timedOut) continue
      const excerpt = output.split("\n").slice(-SETUP_OUTPUT_LINES).join("\n")
      const why = timedOut
        ? `timed out after ${setup.timeoutMs}ms`
        : `exited ${exitCode}`
      throw new AbSetupError(
        `Base setup ${why}: ${command}${excerpt ? `\n${excerpt}` : ""}`,
      )
    }
    return true
  } finally {
    for (const link of links) unlinkSync(link)
  }
}

/** The committed tree at `sha`, extracted once under `dir` and reused by
 * every later run against the same commit (and setup commands), with each
 * script salted (see `BASE_SALT`). Extracted and set up in a temp directory
 * and renamed into place, so a directory at `dir` is always complete; a
 * failed or cancelled setup leaves nothing behind. Returns false when
 * `setup.signal` aborted a setup command. */
async function extractTree(
  sha: string,
  dir: string,
  setup: TreeSetup,
): Promise<boolean> {
  if (existsSync(dir)) return true
  const tmp = `${dir}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
  await removeDir(tmp)
  await mkdir(tmp, { recursive: true })
  const archive = Bun.spawn(["git", "archive", "--format=tar", sha], {
    cwd: setup.cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const tar = Bun.spawn(["tar", "-x", "-C", tmp], {
    stdin: archive.stdout,
    stderr: "pipe",
  })
  const [archiveCode, tarCode] = await Promise.all([archive.exited, tar.exited])
  if (archiveCode !== 0 || tarCode !== 0) {
    const stderr = await new Response(
      archiveCode !== 0 ? archive.stderr : tar.stderr,
    ).text()
    await removeDir(tmp)
    throw new Error(`Could not extract ${sha}: ${stderr.trim()}`)
  }
  try {
    if (!(await runSetup(tmp, sha, setup))) {
      await removeDir(tmp)
      return false
    }
  } catch (err) {
    await removeDir(tmp)
    throw err
  }
  await saltScripts(tmp)
  try {
    renameSync(tmp, dir)
  } catch {
    // Another run extracted the same commit first.
    await removeDir(tmp)
  }
  return true
}

// A tree used this recently may belong to a run still going.
const PRUNE_GRACE_MS = 60 * 60 * 1000

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Marks a base tree as just used: pruning goes by modification time,
 * which, unlike access time, every filesystem keeps. */
function touchTree(dir: string): void {
  const now = new Date()
  try {
    utimesSync(dir, now, now)
  } catch {
    // Gone already: nothing to keep fresh.
  }
}

/** Removes base trees under `abDir` past the `keep` most recently used,
 * except any used in the last hour, and temp directories whose process has
 * exited. Returns how many it removed. */
async function pruneAbTrees(abDir: string, keep: number): Promise<number> {
  if (!existsSync(abDir)) return 0
  const now = Date.now()
  const doomed: string[] = []
  const trees: { path: string; mtimeMs: number }[] = []
  for (const name of readdirSync(abDir)) {
    const path = `${abDir}/${name}`
    const tmp = /\.tmp-(\d+)(?:-\w+)?$/.exec(name)
    if (tmp) {
      if (!pidAlive(Number(tmp[1]))) doomed.push(path)
      continue
    }
    try {
      trees.push({ path, mtimeMs: statSync(path).mtimeMs })
    } catch {
      // Removed by another run in the meantime.
    }
  }
  trees.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const tree of trees.slice(keep)) {
    if (now - tree.mtimeMs > PRUNE_GRACE_MS) doomed.push(tree.path)
  }
  for (const path of doomed) await removeDir(path)
  return doomed.length
}

/** Removes every base tree `ab()` has cached under `<outDir>/ab`. Returns
 * how many there were. */
export async function cleanAbTrees(
  opts: { outDir?: string; cwd?: string } = {},
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const abDir = `${absolutePath(cwd, opts.outDir ?? DEFAULT_OUT_DIR)}/ab`
  if (!existsSync(abDir)) return 0
  const count = readdirSync(abDir).length
  await removeDir(abDir)
  return count
}

/** Puts a task's memory readings on its measurement: the median of each
 * side's processes, judged against the base's. */
function judgeMemory(
  m: Measurement,
  task: AbMemoryTask,
  readings: Record<Side, AbMemoryResult[]>,
  thresholdPct: number,
): void {
  const p = m.paired!
  const all = [...readings.base, ...readings.cand]
  const judge = (read: (r: AbMemoryResult) => number, floorBytes: number) => {
    const change = memoryChange(
      median(readings.base.map(read)),
      median(readings.cand.map(read)),
      thresholdPct,
      floorBytes,
    )
    if (!comparable(p)) change.verdict = "unchanged"
    return change
  }
  if (task.alloc) {
    const calls = Math.min(...all.map((r) => r.alloc!.calls))
    p.retained = judge((r) => r.alloc!.bytesPerOp, RETAINED_NOISE_BYTES / calls)
  }
  if (task.peakMem) {
    const peaks = all.map((r) => r.peak!)
    // Memory freed before the call can hide up to that much of its peak.
    const warning = peakHiddenWarning(peaks)
    const slack = Math.max(...peaks.map((r) => r.slackBytes))
    p.peak = judge(
      (r) => r.peak!.peakBytes,
      warning ? Math.max(PEAK_NOISE_BYTES, slack) : PEAK_NOISE_BYTES,
    )
    if (warning) m.warnings.push(warning)
  }
}

/** Median over the main run and any fresh-process repeats, so one process's
 * JIT luck moves the geomean less. */
function ratioEstimate(p: PairedEvidence): number {
  if (!p.repeats?.length) return p.medianRatio
  return median([p.medianRatio, ...p.repeats.map((r) => r.medianRatio)])
}

export function summarizePaired(
  measurements: Measurement[],
  settings: {
    base: AbSummary["base"]
    newSuites?: string[]
    rounds: number
    thresholdPct: number
    geomeanThresholdPct: number
    memThresholdPct?: number
  },
): AbSummary {
  // A task that threw, even in a confirmation repeat, isn't judged on time.
  const paired = measurements
    .filter((m) => !m.threw)
    .map((m) => m.paired)
    .filter((p): p is PairedEvidence => p !== undefined)
  const count = (verdict: PairedEvidence["verdict"]) =>
    paired.filter((p) => p.verdict === verdict).length
  const judged = paired.filter(comparable)
  const logSum = judged.reduce((sum, p) => sum + Math.log(ratioEstimate(p)), 0)
  const geomeanPct =
    judged.length > 0 ? (Math.exp(logSum / judged.length) - 1) * 100 : null
  const regressed = count("regressed")
  const improved = count("improved")
  const threw = measurements.filter((m) => m.threw)
  const candThrew = threw.some((m) => m.threw?.side === "cand")
  const { memThresholdPct, ...rest } = settings
  // Each task counts once: regressed if either reading regressed.
  const memVerdicts = paired
    .filter((p) => p.retained || p.peak)
    .map((p) => [p.retained?.verdict, p.peak?.verdict])
  const memRegressed = memVerdicts.filter((v) => v.includes("regressed"))
  const memory = memVerdicts.length > 0 && {
    thresholdPct: memThresholdPct ?? DEFAULTS.memThresholdPct,
    regressed: memRegressed.length,
    improved: memVerdicts.filter(
      (v) => v.includes("improved") && !v.includes("regressed"),
    ).length,
  }
  return {
    ...rest,
    matched: paired.length,
    regressed,
    improved,
    unchanged: paired.length - regressed - improved,
    unconfirmed: paired.filter((p) => p.confirmed === false).length,
    outputDiffers: paired.filter((p) => !p.sameOutput).length,
    notComparable: paired.length - judged.length,
    threw: threw.length,
    ...(memory && { memory }),
    geomeanPct,
    verdict:
      regressed > 0 ||
      candThrew ||
      memRegressed.length > 0 ||
      (geomeanPct !== null && geomeanPct > settings.geomeanThresholdPct)
        ? "fail"
        : "pass",
  }
}

/** Paired A/B timing of suite files against a git ref: every task runs on
 * the ref's committed tree (base) and the working tree (candidate) in one
 * process, alternating short batches, and is judged on the per-round time
 * ratio. Drift between two runs minutes apart cancels within a round. What
 * pairing can't cancel is how the JIT compiled each side in that process, so
 * every flagged workload is re-measured in `confirm` fresh processes and only
 * counts when they all agree. */
export async function ab(opts: AbOptions): Promise<ProfileDocument> {
  const ref = opts.base ?? DEFAULTS.base
  const rounds = opts.rounds ?? DEFAULTS.rounds
  const thresholdPct = opts.thresholdPct ?? DEFAULTS.thresholdPct
  const geomeanThresholdPct =
    opts.geomeanThresholdPct ?? DEFAULTS.geomeanThresholdPct
  const memThresholdPct = opts.memThresholdPct ?? DEFAULTS.memThresholdPct
  const confirm = opts.confirm ?? DEFAULTS.confirm
  const keepTrees = opts.keepTrees ?? DEFAULTS.keepTrees
  if (!Number.isInteger(keepTrees) || keepTrees < 1) {
    throw new RangeError(
      `ab: keepTrees must be an integer >= 1, got ${keepTrees}`,
    )
  }
  if (!Number.isInteger(rounds) || rounds < 3) {
    throw new RangeError(`ab: rounds must be an integer >= 3, got ${rounds}`)
  }
  if (!Number.isInteger(confirm) || confirm < 0) {
    throw new RangeError(`ab: confirm must be an integer >= 0, got ${confirm}`)
  }
  for (const [key, value] of Object.entries({
    thresholdPct,
    geomeanThresholdPct,
    memThresholdPct,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`ab: ${key} must be >= 0, got ${value}`)
    }
  }
  assertSamplingOptions("ab", { timeoutMs: opts.timeoutMs })

  const cwd = opts.cwd ?? process.cwd()
  const absOutDir = absolutePath(cwd, opts.outDir ?? DEFAULT_OUT_DIR)
  const tmpDir = uniqueTmpDir(absOutDir, "ab")

  // Same path join as `bench()`, so workload ids match `ostia bench`'s.
  const candSuites = opts.suites.map((file) => absolutePath(cwd, file))
  for (const [i, suite] of candSuites.entries()) {
    assertSuiteExists(opts.suites[i]!, suite)
  }

  const toplevel = git(["rev-parse", "--show-toplevel"], cwd)
  if (toplevel === undefined) {
    throw new AbBaseError(`${cwd} is not inside a git repository.`)
  }
  const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)
  if (sha === undefined) {
    throw new AbBaseError(`"${ref}" is not a commit in ${toplevel}.`)
  }
  // Under the project's node_modules, so a bare import from the base tree
  // resolves to the same packages (and `ostia` itself) as the working tree.
  const setup =
    typeof opts.baseSetup === "string"
      ? [opts.baseSetup]
      : (opts.baseSetup ?? [])
  const checkout = treeDir(`${absOutDir}/ab`, sha, setup)
  const extracted = await extractTree(sha, checkout, {
    commands: setup,
    toplevel,
    cwd,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onProgress: opts.onProgress,
  })
  const settings = {
    base: { ref, sha },
    rounds,
    thresholdPct,
    geomeanThresholdPct,
    memThresholdPct,
  }
  if (!extracted) {
    const doc = createDocument([], [])
    doc.unmatched = { baseOnly: [], candOnly: [] }
    doc.ab = summarizePaired([], settings)
    return doc
  }

  const { environment, noiseWarning } = captureRunEnvironment(opts.noiseCheck)

  // "" when the file doesn't exist at the base ref: all its tasks are new.
  const baseSuites = candSuites.map((suite, i) => {
    const inRepo = relative(toplevel, realpathSync(suite))
    if (inRepo === ".." || inRepo.startsWith(`..${sep}`)) {
      throw new OstiaUsageError(`${opts.suites[i]} is outside ${toplevel}.`)
    }
    return existsSync(`${checkout}/${inRepo}`) ? `${checkout}/${inRepo}` : ""
  })
  // A suite whose text changed may time something else on each side (a
  // fixed fixture, a new input), so its tasks are marked. The base copy
  // carries the salt; nothing else differs in an unchanged file.
  const suiteChanged = await Promise.all(
    candSuites.map(async (suite, s) => {
      if (!baseSuites[s]) return false
      const base = await Bun.file(baseSuites[s]).text()
      const cand = await Bun.file(suite).text()
      return (
        (base.endsWith(BASE_SALT) ? base.slice(0, -BASE_SALT.length) : base) !==
        cand
      )
    }),
  )
  const preload = (opts.preload ?? []).map((file) => absolutePath(cwd, file))
  const bunFlags = opts.bunFlags ?? []

  const onProgress = opts.onProgress
  let spawned = 0
  /** Runs the A/B runner on suite `s`; resolves with its output path, or
   * undefined when cancelled. */
  const runRunner = async (
    s: number,
    extra: Partial<AbRunnerOpts> = {},
    env?: Record<string, string>,
  ): Promise<string | undefined> => {
    touchTree(checkout)
    const outPath = `${tmpDir}/${fp("ab-run", candSuites[s]!, spawned++)}.json`
    const runnerOpts: AbRunnerOpts = {
      filter: opts.filter,
      rounds,
      thresholdPct,
      preload,
      // Per task only on the first pass; repeats report themselves.
      progress:
        onProgress !== undefined && !extra.workloadIds && !extra.memoryFor,
      ...extra,
    }
    const ran = await runRunnerProcess(
      [
        "bun",
        ...bunFlags,
        RUNNER_PATH,
        candSuites[s]!,
        baseSuites[s]!,
        outPath,
        JSON.stringify(runnerOpts),
      ],
      {
        cwd,
        label: "A/B suite",
        name: opts.suites[s]!,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        env,
        // The runner names the side that failed to load, when that's why.
        errorFile: `${outPath}.error`,
        ...(runnerOpts.progress && {
          ipc: (message: AbRunnerProgress) =>
            onProgress?.({
              phase: "measure",
              suite: s + 1,
              suites: candSuites.length,
              file: opts.suites[s]!,
              ...message,
            }),
        }),
      },
    )
    return ran ? outPath : undefined
  }
  const runSuite = async (
    s: number,
    extra: Partial<AbRunnerOpts> = {},
  ): Promise<ProfileDocument | undefined> => {
    const outPath = await runRunner(s, extra)
    return outPath ? loadDocument(outPath) : undefined
  }

  try {
    const workloads: Workload[] = []
    const measurements: Measurement[] = []
    const suiteOf = new Map<string, number>()
    const baseOnly: string[] = []
    const candOnly: string[] = []
    const wantsMemory: (AbMemoryTask & { suite: number })[] = []
    for (let s = 0; s < candSuites.length; s++) {
      const planPath = `${tmpDir}/${fp("ab-plan", candSuites[s]!)}.json`
      const doc = await runSuite(s, {
        alloc: opts.alloc,
        peakMem: opts.peakMem,
        planPath,
      })
      if (!doc) break
      const plan: AbRunnerPlan = await Bun.file(planPath).json()
      for (const m of plan.memory) wantsMemory.push({ ...m, suite: s })
      workloads.push(...doc.workloads)
      measurements.push(...doc.measurements)
      for (const m of doc.measurements) {
        suiteOf.set(m.workloadId, s)
        if (!suiteChanged[s] || !m.paired) continue
        m.paired.suiteChanged = true
        if (!comparable(m.paired)) m.paired.verdict = "unchanged"
        m.warnings.push({
          code: "suite-changed",
          message: comparable(m.paired)
            ? "The suite file differs from the base's copy, so each side may run a different benchmark."
            : "The suite file differs from the base's copy and so does the output: each side likely ran a different benchmark. Left out of the verdict, geomean and memory verdict.",
        })
      }
      baseOnly.push(...(doc.unmatched?.baseOnly ?? []))
      candOnly.push(...(doc.unmatched?.candOnly ?? []))
    }

    const toConfirm = measurements.filter(
      (m) => m.paired?.flagged && confirm > 0 && comparable(m.paired),
    )
    const labelOf = new Map(workloads.map((w) => [w.id, w.entry?.task ?? w.id]))
    let started = 0
    for (const m of toConfirm) {
      const p = m.paired!
      const flagged = p.flagged!
      p.repeats = []
      for (let r = 0; r < confirm && !opts.signal?.aborted; r++) {
        onProgress?.({
          phase: "confirm",
          repeat: ++started,
          repeats: toConfirm.length * confirm,
          label: labelOf.get(m.workloadId) ?? m.workloadId,
        })
        const doc = await runSuite(suiteOf.get(m.workloadId)!, {
          workloadIds: [m.workloadId],
        })
        const run = doc?.measurements[0]
        // A throw in a repeat counts like one in the first process; the
        // first process's timing stays for the record.
        if (run?.threw) {
          m.threw = { ...run.threw, repeat: r + 1 }
          break
        }
        const repeat = run?.paired
        if (!repeat) break
        p.repeats.push({
          medianRatio: repeat.medianRatio,
          ratioP25: repeat.ratioP25,
          ratioP75: repeat.ratioP75,
          ...(repeat.flagged && { flagged: repeat.flagged }),
        })
      }
      p.confirmed =
        !m.threw &&
        p.repeats.length === confirm &&
        p.repeats.every((r) => r.flagged === flagged)
      p.verdict = p.confirmed ? flagged : "unchanged"
    }

    // Memory, for tasks that timed without throwing: each side in its own
    // fresh processes, alternating sides.
    const byWorkload = new Map(measurements.map((m) => [m.workloadId, m]))
    const memoryTasks = wantsMemory.filter(({ workloadId }) => {
      const m = byWorkload.get(workloadId)
      return m?.paired && !m.threw
    })
    const memoryRuns = memoryTasks.length * PEAK_MEM_PROCESSES * 2
    let memoryRun = 0
    for (const task of memoryTasks) {
      const { workloadId, suite, peakMem } = task
      const readings: Record<Side, AbMemoryResult[]> = { base: [], cand: [] }
      for (let r = 0; r < PEAK_MEM_PROCESSES && !opts.signal?.aborted; r++) {
        for (const side of ["base", "cand"] as const) {
          if (opts.signal?.aborted) break
          onProgress?.({
            phase: "memory",
            run: ++memoryRun,
            runs: memoryRuns,
            side,
            label: labelOf.get(workloadId) ?? workloadId,
          })
          const outPath = await runRunner(
            suite,
            { memoryFor: { ...task, side } },
            // Lets a suite skip heavy module-scope work that would peak
            // before the measured call does.
            peakMem ? { OSTIA_PEAK_MEM: "1" } : undefined,
          )
          if (outPath) readings[side].push(await Bun.file(outPath).json())
        }
      }
      if (readings.base.length === 0 || readings.cand.length === 0) continue
      judgeMemory(byWorkload.get(workloadId)!, task, readings, memThresholdPct)
    }

    stampRunWarnings(
      measurements,
      noiseWarning,
      opts.signal?.aborted
        ? "Run was cancelled before it finished; this document holds whatever suites had already completed."
        : undefined,
    )

    const doc = createDocument(workloads, measurements, environment)
    doc.unmatched = { baseOnly, candOnly }
    doc.ab = summarizePaired(measurements, {
      ...settings,
      newSuites: opts.suites.filter((_, s) => !baseSuites[s]),
    })
    await pruneAbTrees(`${absOutDir}/ab`, keepTrees)
    return doc
  } finally {
    await removeDir(tmpDir)
  }
}
