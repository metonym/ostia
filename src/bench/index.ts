import { loadDocument, newDocument } from "../ir/document.ts"
import { fp } from "../ir/fp.ts"
import type { ProfileDocument, Run, Workload } from "../ir/types.ts"

export interface BenchOptions {
  suites: string[]
  timeBudgetMs?: number
  minSamples?: number
  gc?: boolean
  filter?: string
  /** Suite files to run at once, each still in its own child process (default:
   * 1). Files are independent by design, so this is a wall-clock win for
   * multi-file suites, but concurrent CPU-bound processes contend for cores,
   * caches, memory bandwidth and turbo headroom: timings taken under `jobs > 1`
   * are noisier and not like-for-like with a baseline measured at 1. */
  jobs?: number
  outDir?: string
  cwd?: string
}

const RUNNER_PATH = new URL("./runner.ts", import.meta.url).pathname
const DEFAULT_OUT_DIR = "node_modules/.cache/ostia"

/** Logical CPUs available to this process, for `--jobs auto`. */
export function availableJobs(): number {
  return Math.max(1, navigator.hardwareConcurrency || 1)
}

export async function bench(opts: BenchOptions): Promise<ProfileDocument> {
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  const tmpDir = `${outDir}/bench-tmp`
  const cwd = opts.cwd ?? process.cwd()
  const jobs = Math.max(1, Math.floor(opts.jobs ?? 1))

  const taskOpts = {
    timeBudgetMs: opts.timeBudgetMs,
    minSamples: opts.minSamples,
    gc: opts.gc,
    filter: opts.filter,
  }

  // Results land by suite index so the document's workload order matches the
  // suite order on the command line regardless of which child finishes first.
  const perSuite: ProfileDocument[] = new Array(opts.suites.length)
  const inFlight = new Set<ReturnType<typeof Bun.spawn>>()
  let next = 0
  let failure: Error | undefined

  const runSuite = async (index: number): Promise<void> => {
    const suiteFile = opts.suites[index]!
    const resolvedSuite = suiteFile.startsWith("/")
      ? suiteFile
      : `${cwd}/${suiteFile}`
    const outputPath = `${tmpDir}/${fp("bench-out", resolvedSuite)}.json`

    const proc = Bun.spawn(
      ["bun", RUNNER_PATH, resolvedSuite, outputPath, JSON.stringify(taskOpts)],
      {
        cwd,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
      },
    )
    inFlight.add(proc)
    const exitCode = await proc.exited
    inFlight.delete(proc)
    if (exitCode !== 0) {
      throw new Error(
        `Bench suite failed: ${suiteFile} (runner exited ${exitCode})`,
      )
    }
    perSuite[index] = await loadDocument(outputPath)
  }

  // A fixed pool of `jobs` workers pulling from a shared cursor. The first
  // failure stops the pool: remaining queued suites are skipped and in-flight
  // children are killed, so a broken file fails the run fast instead of after
  // every other suite has spent its budget.
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < opts.suites.length) {
      const index = next++
      try {
        await runSuite(index)
      } catch (err) {
        failure ??= err instanceof Error ? err : new Error(String(err))
        for (const proc of inFlight) proc.kill()
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(jobs, opts.suites.length) }, worker),
    )
    if (failure) throw failure
  } finally {
    await Bun.spawn(["rm", "-rf", tmpDir]).exited
  }

  const workloads: Workload[] = []
  const runs: Run[] = []
  for (const suiteDoc of perSuite) {
    workloads.push(...suiteDoc.workloads)
    runs.push(...suiteDoc.runs)
  }
  return newDocument(workloads, runs)
}
