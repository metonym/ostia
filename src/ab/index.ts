import {
  appendFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  statSync,
  utimesSync,
} from "node:fs"
import { mkdir, readdir } from "node:fs/promises"
import { relative, sep } from "node:path"
import {
  absolutePath,
  assertSuiteExists,
  captureRunEnvironment,
  median,
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
import { assertSamplingOptions } from "../measure/timing.ts"
import type { AbRunnerOpts } from "./ab-runner.ts"

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
  /** SIGKILLs a runner process (one suite file or repeat) after this many ms. */
  timeoutMs?: number
  /** Aborting kills the running process and resolves with the suites that
   * had finished, plus an `aborted` warning; unrun repeats leave their
   * workloads unconfirmed. */
  signal?: AbortSignal
}

/** `ab()` can't run: not in a git repository, or `base` isn't a commit. */
export class AbBaseError extends OstiaUsageError {}

const RUNNER_PATH = new URL("./ab-runner.ts", import.meta.url).pathname

const DEFAULTS = {
  base: "HEAD",
  rounds: 15,
  thresholdPct: 10,
  geomeanThresholdPct: 1.5,
  confirm: 2,
}

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

/** Extracts the committed tree at `sha` under `dir` (reused by later runs
 * against the same commit), scripts salted. Renamed into place from a temp
 * directory, so a directory at `dir` is always complete. */
async function extractTree(sha: string, dir: string, cwd: string) {
  if (existsSync(dir)) {
    markUsed(dir)
    return
  }
  const tmp = `${dir}${TMP_MARK}${process.pid}-${crypto.randomUUID().slice(0, 8)}`
  await removeDir(tmp)
  await mkdir(tmp, { recursive: true })
  const archive = Bun.spawn(["git", "archive", "--format=tar", sha], {
    cwd,
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
  await saltScripts(tmp)
  try {
    renameSync(tmp, dir)
  } catch {
    // Another run extracted the same commit first.
    await removeDir(tmp)
  }
  markUsed(dir)
}

// Extracted trees kept besides any a concurrent run could still be using.
const KEEP_TREES = 5
const IN_USE_WINDOW_MS = 60 * 60 * 1000
const TMP_MARK = ".tmp-"

// Last use is the directory's mtime: reading a tree never changes it.
function markUsed(dir: string): void {
  try {
    const now = new Date()
    utimesSync(dir, now, now)
  } catch {
    // Pruning is best-effort.
  }
}

/** Removes extracted trees beyond the `KEEP_TREES` most recently used, and
 * abandoned half-extracted ones, but never one used within the last hour (a
 * concurrent run may be reading it). Best-effort: a failure leaves them. */
async function pruneTrees(root: string): Promise<void> {
  try {
    const now = Date.now()
    const entries = (await readdir(root))
      .map((name) => ({
        name,
        stat: statSync(`${root}/${name}`, { throwIfNoEntry: false }),
      }))
      .filter((e) => e.stat?.isDirectory())
      .map((e) => ({ name: e.name, mtimeMs: e.stat!.mtimeMs }))
    const trees = entries
      .filter((e) => !e.name.includes(TMP_MARK))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const leftovers = entries.filter((e) => e.name.includes(TMP_MARK))
    await Promise.all(
      [...trees.slice(KEEP_TREES), ...leftovers]
        .filter((e) => now - e.mtimeMs > IN_USE_WINDOW_MS)
        .map((e) => removeDir(`${root}/${e.name}`)),
    )
  } catch {
    // Pruning is best-effort.
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
    rounds: number
    thresholdPct: number
    geomeanThresholdPct: number
  },
): AbSummary {
  const paired = measurements
    .map((m) => m.paired)
    .filter((p): p is PairedEvidence => p !== undefined)
  const count = (verdict: PairedEvidence["verdict"]) =>
    paired.filter((p) => p.verdict === verdict).length
  const logSum = paired.reduce((sum, p) => sum + Math.log(ratioEstimate(p)), 0)
  const geomeanPct =
    paired.length > 0 ? (Math.exp(logSum / paired.length) - 1) * 100 : null
  const regressed = count("regressed")
  const improved = count("improved")
  return {
    ...settings,
    matched: paired.length,
    regressed,
    improved,
    unchanged: paired.length - regressed - improved,
    unconfirmed: paired.filter((p) => p.confirmed === false).length,
    outputDiffers: paired.filter((p) => !p.sameOutput).length,
    geomeanPct,
    verdict:
      regressed > 0 ||
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
  const confirm = opts.confirm ?? DEFAULTS.confirm
  if (!Number.isInteger(rounds) || rounds < 3) {
    throw new RangeError(`ab: rounds must be an integer >= 3, got ${rounds}`)
  }
  if (!Number.isInteger(confirm) || confirm < 0) {
    throw new RangeError(`ab: confirm must be an integer >= 0, got ${confirm}`)
  }
  for (const [key, value] of Object.entries({
    thresholdPct,
    geomeanThresholdPct,
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
  const checkout = `${absOutDir}/ab/${sha}`
  await extractTree(sha, checkout, cwd)
  await pruneTrees(`${absOutDir}/ab`)

  const { environment, noiseWarning } = captureRunEnvironment(opts.noiseCheck)

  // "" when the file doesn't exist at the base ref: all its tasks are new.
  const baseSuites = candSuites.map((suite, i) => {
    const inRepo = relative(toplevel, realpathSync(suite))
    if (inRepo === ".." || inRepo.startsWith(`..${sep}`)) {
      throw new OstiaUsageError(`${opts.suites[i]} is outside ${toplevel}.`)
    }
    return existsSync(`${checkout}/${inRepo}`) ? `${checkout}/${inRepo}` : ""
  })
  const preload = (opts.preload ?? []).map((file) => absolutePath(cwd, file))
  const bunFlags = opts.bunFlags ?? []

  let spawned = 0
  const runSuite = async (
    s: number,
    extra: Partial<AbRunnerOpts> = {},
  ): Promise<ProfileDocument | undefined> => {
    const outPath = `${tmpDir}/${fp("ab-run", candSuites[s]!, spawned++)}.json`
    const runnerOpts: AbRunnerOpts = {
      filter: opts.filter,
      rounds,
      thresholdPct,
      preload,
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
        label: "A/B suite",
        name: opts.suites[s]!,
        cwd,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      },
    )
    return ran ? loadDocument(outPath) : undefined
  }

  try {
    const workloads: Workload[] = []
    const measurements: Measurement[] = []
    const suiteOf = new Map<string, number>()
    const baseOnly: string[] = []
    const candOnly: string[] = []
    for (let s = 0; s < candSuites.length; s++) {
      const doc = await runSuite(s)
      if (!doc) break
      workloads.push(...doc.workloads)
      measurements.push(...doc.measurements)
      for (const m of doc.measurements) suiteOf.set(m.workloadId, s)
      baseOnly.push(...(doc.unmatched?.baseOnly ?? []))
      candOnly.push(...(doc.unmatched?.candOnly ?? []))
    }

    for (const m of measurements) {
      const p = m.paired
      if (!p?.flagged || confirm === 0) continue
      p.repeats = []
      for (let r = 0; r < confirm && !opts.signal?.aborted; r++) {
        const doc = await runSuite(suiteOf.get(m.workloadId)!, {
          workloadIds: [m.workloadId],
        })
        const repeat = doc?.measurements[0]?.paired
        if (!repeat) break
        p.repeats.push({
          medianRatio: repeat.medianRatio,
          ratioP25: repeat.ratioP25,
          ratioP75: repeat.ratioP75,
          ...(repeat.flagged && { flagged: repeat.flagged }),
        })
      }
      p.confirmed =
        p.repeats.length === confirm &&
        p.repeats.every((r) => r.flagged === p.flagged)
      p.verdict = p.confirmed ? p.flagged : "unchanged"
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
      base: { ref, sha },
      rounds,
      thresholdPct,
      geomeanThresholdPct,
    })
    return doc
  } finally {
    await removeDir(tmpDir)
  }
}
