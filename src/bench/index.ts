import type { BenchConfig } from "../config/index.ts"
import { loadDocument, newDocument } from "../ir/document.ts"
import { fp } from "../ir/fp.ts"
import type { Measurement, ProfileDocument, Workload } from "../ir/types.ts"
import type { RunnerOpts } from "./runner.ts"

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
   * are noisier and not like-for-like with a baseline measured at 1. When
   * `isolate` puts some tasks in their own subprocess, `jobs` pools across
   * those per-task processes the same way - so the same noise/wall-clock
   * tradeoff now scales with task count, not just file count. */
  jobs?: number
  outDir?: string
  cwd?: string
  /** Give every task its own subprocess instead of sharing its suite file's,
   * isolating each task's JIT tier state, inline caches and heap shape from
   * every other task the way suite files are already isolated from each
   * other. `TaskOptions.isolate` / `GroupOptions.isolate` override this per
   * task or group for mixed suites (e.g. a few outlier-prone tasks isolated,
   * many cheap ones sharing a process). Multiplies process-spawn overhead by
   * task count instead of file count. */
  isolate?: boolean
  /** Scripts run, in order, before each suite file loads - in the same
   * subprocess, so they can install globals (jsdom's `document`/`window`) or
   * register a `Bun.plugin()` file-loader (e.g. for `.svelte`/`.vue`) ahead
   * of the suite's own top-level code. Consumer-authored; ostia ships no
   * preload scripts itself. */
  preload?: string[]
  /** Extra flags passed through to the `bun` invocation that runs each suite
   * file (e.g. `["--conditions", "browser"]`), inserted before the runner
   * script path so `bun` itself parses them rather than the runner. Useful
   * for suites that import packages whose `exports` map branches on a
   * resolution condition Bun doesn't set by default (e.g. Svelte/Vue's
   * `browser` vs `default` builds). */
  bunFlags?: string[]
  /** Measure this machine's noise floor before the first task per suite
   * subprocess (default: true) and stamp it on the document as
   * `environment`. Set false to skip the ~200ms reference measurement. */
  noiseCheck?: boolean
}

const RUNNER_PATH = new URL("./runner.ts", import.meta.url).pathname
const DEFAULT_OUT_DIR = "node_modules/.cache/ostia"

/** Logical CPUs available to this process, for `--jobs auto`. */
export function availableJobs(): number {
  return Math.max(1, navigator.hardwareConcurrency || 1)
}

/** Expands suite file globs (e.g. from `ostia.config.json`'s `bench.suites`)
 * against `cwd`, deduped and sorted for a deterministic run order. */
export async function expandSuiteGlobs(
  patterns: string[],
  cwd: string,
): Promise<string[]> {
  const paths = new Set<string>()
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern)
    for await (const path of glob.scan({ cwd, absolute: false })) {
      paths.add(path)
    }
  }
  return [...paths].sort()
}

/** The subset of `ostia bench`'s CLI flags that have a config-file
 * counterpart in `BenchConfig`. */
export interface BenchCliOverrides {
  suites: string[]
  timeBudgetMs?: number
  minSamples?: number
  jobs?: number
  gc: boolean
  filter?: string
  isolate: boolean
  preload: string[]
  bunFlags?: string[]
  outDir?: string
  noiseCheck: boolean
}

function resolveConfigJobs(
  value: number | "auto" | undefined,
): number | undefined {
  if (value === undefined) return undefined
  return value === "auto" ? availableJobs() : value
}

/** Merges CLI flags with `ostia.config.json`'s `bench` section: an explicit
 * CLI value always wins per field, falling back to the config value, then to
 * `bench()`'s own built-in defaults (left undefined here). `suites` and
 * `preload` are whole-list overrides rather than merged - CLI args replace
 * the config's list rather than appending to it. */
export async function resolveBenchOptions(
  cli: BenchCliOverrides,
  config: BenchConfig | undefined,
  cwd: string = process.cwd(),
): Promise<BenchOptions> {
  const suites =
    cli.suites.length > 0
      ? cli.suites
      : config?.suites
        ? await expandSuiteGlobs(config.suites, cwd)
        : []

  return {
    suites,
    timeBudgetMs: cli.timeBudgetMs ?? config?.timeBudgetMs,
    minSamples: cli.minSamples ?? config?.minSamples,
    jobs: cli.jobs ?? resolveConfigJobs(config?.jobs),
    gc: cli.gc || (config?.gc ?? false),
    filter: cli.filter ?? config?.filter,
    isolate: cli.isolate || (config?.isolate ?? false),
    preload: cli.preload.length > 0 ? cli.preload : (config?.preload ?? []),
    bunFlags: cli.bunFlags,
    outDir: cli.outDir ?? config?.outDir,
    noiseCheck: cli.noiseCheck,
    cwd,
  }
}

interface PlannedTask {
  id: string
  isolate: boolean
}

/** One subprocess spawn dedicated to a single isolated task. */
interface WorkItem {
  suiteIndex: number
  taskIds: string[]
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
    noiseCheck: opts.noiseCheck,
  }

  const resolvedSuites = opts.suites.map((suiteFile) =>
    suiteFile.startsWith("/") ? suiteFile : `${cwd}/${suiteFile}`,
  )
  const resolvedPreloads = (opts.preload ?? []).map((preloadFile) =>
    preloadFile.startsWith("/") ? preloadFile : `${cwd}/${preloadFile}`,
  )
  const bunFlags = opts.bunFlags ?? []

  // A pool of `jobs` workers pulling from a shared cursor of spawn targets.
  // The first failure stops the pool: remaining queued targets are skipped
  // and in-flight children are killed, so a broken target fails the run fast
  // instead of after every other target has spent its budget.
  const spawnPooled = async (
    argvList: string[][],
    describe: (index: number) => string,
  ): Promise<void> => {
    const inFlight = new Set<ReturnType<typeof Bun.spawn>>()
    let next = 0
    let failure: Error | undefined

    const worker = async (): Promise<void> => {
      while (failure === undefined && next < argvList.length) {
        const index = next++
        try {
          const proc = Bun.spawn(argvList[index]!, {
            cwd,
            stdout: "inherit",
            stderr: "inherit",
            stdin: "ignore",
          })
          inFlight.add(proc)
          const exitCode = await proc.exited
          inFlight.delete(proc)
          if (exitCode !== 0) {
            throw new Error(
              `Bench suite failed: ${describe(index)} (runner exited ${exitCode})`,
            )
          }
        } catch (err) {
          failure ??= err instanceof Error ? err : new Error(String(err))
          for (const proc of inFlight) proc.kill()
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(jobs, argvList.length) }, worker),
    )
    if (failure) throw failure
  }

  try {
    // Phase 1: for each suite file, import it exactly once. That single pass
    // discovers the registered tasks and each one's effective isolate
    // (task/group override, else the suite-wide default), writes that plan
    // out, and - in the same process, off the same import - runs every
    // non-isolated task right there. Isolated tasks are skipped here and
    // left to phase 2's dedicated subprocesses, so a suite file's
    // module-scope setup never runs twice just to learn what's isolated
    // before running anything.
    const planPaths = resolvedSuites.map(
      (suite) => `${tmpDir}/${fp("bench-plan", suite)}.json`,
    )
    const primaryPaths = resolvedSuites.map(
      (suite) => `${tmpDir}/${fp("bench-primary", suite)}.json`,
    )
    const primaryArgv = resolvedSuites.map((suite, i) => [
      "bun",
      ...bunFlags,
      RUNNER_PATH,
      suite,
      primaryPaths[i]!,
      JSON.stringify({
        ...taskOpts,
        filter: opts.filter,
        isolate: opts.isolate,
        preload: resolvedPreloads,
        planPath: planPaths[i],
      } satisfies RunnerOpts),
    ])
    await spawnPooled(primaryArgv, (i) => opts.suites[i]!)

    const plans: PlannedTask[][] = await Promise.all(
      planPaths.map(async (p) => {
        const { tasks } = (await Bun.file(p).json()) as {
          tasks: PlannedTask[]
        }
        return tasks
      }),
    )
    const primaryDocs = await Promise.all(primaryPaths.map(loadDocument))

    // Phase 2: each isolated task gets its own dedicated subprocess, pooled
    // the same way phase 1 was.
    const items: WorkItem[] = []
    for (let s = 0; s < plans.length; s++) {
      for (const t of plans[s]!) {
        if (t.isolate) items.push({ suiteIndex: s, taskIds: [t.id] })
      }
    }

    const itemPaths = items.map(
      (item, i) =>
        `${tmpDir}/${fp("bench-item", resolvedSuites[item.suiteIndex]!, i)}.json`,
    )
    const itemArgv = items.map((item, i) => [
      "bun",
      ...bunFlags,
      RUNNER_PATH,
      resolvedSuites[item.suiteIndex]!,
      itemPaths[i]!,
      JSON.stringify({
        ...taskOpts,
        taskIds: item.taskIds,
        preload: resolvedPreloads,
        markIsolated: true,
      } satisfies RunnerOpts),
    ])
    await spawnPooled(itemArgv, (i) => opts.suites[items[i]!.suiteIndex]!)

    const itemDocs = await Promise.all(itemPaths.map(loadDocument))

    // Reassemble each suite's contribution in the plan's order (registration
    // order, filtered) regardless of which item a task landed in, then
    // concatenate suites in command-line order - the same ordering guarantee
    // bench() has always made, now independent of isolate/spawn granularity.
    const workloads: Workload[] = []
    const measurements: Measurement[] = []
    for (let s = 0; s < plans.length; s++) {
      const sharedDoc = primaryDocs[s]!
      let sharedPtr = 0
      const isolatedDocById = new Map<string, ProfileDocument>()
      items.forEach((it, i) => {
        if (it.suiteIndex === s) {
          isolatedDocById.set(it.taskIds[0]!, itemDocs[i]!)
        }
      })

      for (const t of plans[s]!) {
        if (t.isolate) {
          const doc = isolatedDocById.get(t.id)!
          workloads.push(doc.workloads[0]!)
          measurements.push(doc.measurements[0]!)
        } else {
          workloads.push(sharedDoc.workloads[sharedPtr]!)
          measurements.push(sharedDoc.measurements[sharedPtr]!)
          sharedPtr++
        }
      }
    }

    return newDocument(workloads, measurements, primaryDocs[0]?.environment)
  } finally {
    await Bun.spawn(["rm", "-rf", tmpDir]).exited
  }
}
