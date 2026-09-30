import {
  appendFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
} from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import { DEFAULT_OUT_DIR } from "../config/index.ts"
import { loadDocument, newDocument } from "../ir/document.ts"
import { fp } from "../ir/fp.ts"
import type {
  AbSummary,
  Measurement,
  PairedEvidence,
  ProfileDocument,
  Workload,
} from "../ir/types.ts"
import {
  captureEnvironment,
  noisyMachineWarning,
} from "../measure/environment.ts"
import { killSwitch } from "../spawn/index.ts"
import { percentile } from "../stats/index.ts"
import type { AbRunnerOpts } from "./runner.ts"

export interface AbOptions {
  suites: string[]
  /** Git ref whose committed tree is the base side (default: `"HEAD"`). The
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
  /** Fresh-process repeats of each flagged workload; it only counts when
   * every repeat flags it the same way (default: 2; 0 trusts the first
   * process). */
  confirm?: number
  filter?: string
  preload?: string[]
  bunFlags?: string[]
  outDir?: string
  cwd?: string
  noiseCheck?: boolean
  /** Kills a runner process (one suite file, or one repeat) after this many
   * ms. No default. */
  timeoutMs?: number
  /** Aborting kills the running process and resolves with the suites that
   * had finished, plus an `aborted` warning; repeats not yet run leave their
   * workloads unconfirmed. */
  signal?: AbortSignal
}

/** `ab()` can't run: not in a git repository, or `base` isn't a commit. */
export class AbBaseError extends Error {}

const RUNNER_PATH = new URL("./runner.ts", import.meta.url).pathname

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

// Appended to every script in the base tree, so no file is byte-identical to
// its working-tree copy. JSC's code cache reuses compiled code between
// identical sources, and identical copies didn't measure independently: on
// caligula, with no change at all, whichever copy the runner imported first
// (and so warmed first, in the suite's module-scope setup) ran 5-15% faster,
// reproducibly in fresh processes. With the copies' text differing, the same
// A/A run read +0.1% whichever went first. A statement, not a comment: Bun's
// transpiler strips comments and inert expressions. Reading an absent global
// has no effect.
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

/** The committed tree at `sha`, extracted once under `dir` and reused by
 * every later run against the same commit, with each script salted (see
 * `BASE_SALT`). Extracted into a temp directory and renamed into place, so a
 * directory at `dir` is always complete. */
async function extractTree(sha: string, dir: string, cwd: string) {
  if (existsSync(dir)) return
  const tmp = `${dir}.tmp-${process.pid}`
  await Bun.spawn(["rm", "-rf", tmp]).exited
  await Bun.spawn(["mkdir", "-p", tmp]).exited
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
    await Bun.spawn(["rm", "-rf", tmp]).exited
    throw new Error(`Could not extract ${sha}: ${stderr.trim()}`)
  }
  await saltScripts(tmp)
  try {
    renameSync(tmp, dir)
  } catch {
    // Another run extracted the same commit first; its copy is complete.
    await Bun.spawn(["rm", "-rf", tmp]).exited
  }
}

function median(values: number[]): number {
  return percentile(Float64Array.from(values).sort(), 0.5)
}

/** A workload's best estimate of its ratio: the median over its main run
 * and any fresh-process repeats, so one process's JIT luck moves the
 * geomean less. */
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
  let logSum = 0
  for (const p of paired) logSum += Math.log(ratioEstimate(p))
  const geomeanPct =
    paired.length > 0 ? (Math.exp(logSum / paired.length) - 1) * 100 : null
  const regressed = paired.filter((p) => p.verdict === "regressed").length
  const improved = paired.filter((p) => p.verdict === "improved").length
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
 * ratio. Drift that makes two runs minutes apart disagree cancels within a
 * round. What pairing can't cancel is how the JIT happened to compile each
 * side in that process, so every flagged workload is measured again in
 * `confirm` fresh processes and only counts when they all agree. */
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

  const cwd = opts.cwd ?? process.cwd()
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  const absOutDir = isAbsolute(outDir) ? outDir : `${cwd}/${outDir}`
  const tmpDir = `${absOutDir}/ab-tmp`

  const toplevel = git(["rev-parse", "--show-toplevel"], cwd)
  if (toplevel === undefined) {
    throw new AbBaseError(`${cwd} is not inside a git repository.`)
  }
  const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)
  if (sha === undefined) {
    throw new AbBaseError(`"${ref}" is not a commit in ${toplevel}.`)
  }
  // Under the project's node_modules, so a bare import from the base tree
  // (a dependency, or `ostia` itself) walks up to the same package the
  // working tree uses.
  const checkout = `${absOutDir}/ab/${sha}`
  await extractTree(sha, checkout, cwd)

  const environment =
    opts.noiseCheck === false ? undefined : captureEnvironment()

  // Plain string join, not path.resolve: the suite path is hashed into every
  // workload id, so these ids match `ostia bench`'s for the same files.
  const absolute = (file: string) =>
    isAbsolute(file) ? file : `${cwd}/${file}`
  const candSuites = opts.suites.map(absolute)
  // "" when the file doesn't exist at the base ref: all its tasks are new.
  const baseSuites = candSuites.map((suite, i) => {
    if (!existsSync(suite)) {
      throw new Error(`Suite not found: ${opts.suites[i]}`)
    }
    const inRepo = relative(toplevel, realpathSync(suite))
    if (inRepo === ".." || inRepo.startsWith(`..${sep}`)) {
      throw new AbBaseError(`${opts.suites[i]} is outside ${toplevel}.`)
    }
    return existsSync(`${checkout}/${inRepo}`) ? `${checkout}/${inRepo}` : ""
  })
  const preload = (opts.preload ?? []).map(absolute)
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
    const kill = killSwitch(opts.timeoutMs, opts.signal)
    const proc = Bun.spawn(
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
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        ...kill.spawn,
      },
    )
    const exitCode = await proc.exited
    if (opts.signal?.aborted) return undefined
    if (kill.timedOut()) {
      throw new Error(
        `A/B suite timed out after ${opts.timeoutMs}ms: ${opts.suites[s]}`,
      )
    }
    if (exitCode !== 0) {
      throw new Error(
        `A/B suite failed: ${opts.suites[s]} (runner exited ${exitCode})`,
      )
    }
    return loadDocument(outPath)
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
          p25: repeat.p25,
          p75: repeat.p75,
          ...(repeat.flagged && { flagged: repeat.flagged }),
        })
      }
      p.confirmed =
        p.repeats.length === confirm &&
        p.repeats.every((r) => r.flagged === p.flagged)
      p.verdict = p.confirmed ? p.flagged : "unchanged"
    }

    const noiseWarning = environment && noisyMachineWarning(environment)
    if (noiseWarning && measurements.length > 0) {
      measurements[0]!.warnings.push(noiseWarning)
    }
    if (opts.signal?.aborted && measurements.length > 0) {
      measurements[measurements.length - 1]!.warnings.push({
        code: "aborted",
        message:
          "Run was cancelled before it finished; this document holds whatever suites had already completed.",
      })
    }

    const doc = newDocument(workloads, measurements, environment)
    doc.unmatched = { baseOnly, candOnly }
    doc.ab = summarizePaired(measurements, {
      base: { ref, sha },
      rounds,
      thresholdPct,
      geomeanThresholdPct,
    })
    return doc
  } finally {
    await Bun.spawn(["rm", "-rf", tmpDir]).exited
  }
}
