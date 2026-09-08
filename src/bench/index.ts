import { type BenchConfig, DEFAULT_OUT_DIR } from "../config/index.ts"
import { scanGlobs } from "../glob.ts"
import { loadDocument, newDocument } from "../ir/document.ts"
import { fp } from "../ir/fp.ts"
import type { Measurement, ProfileDocument, Workload } from "../ir/types.ts"
import { combineSignals } from "../spawn/index.ts"
import type { RunnerOpts } from "./runner.ts"

export interface BenchOptions {
  suites: string[]
  /** Wall-clock sampling budget per task, ms (default 500). */
  budgetMs?: number
  /** Exact trial count per task. When set, the budget is ignored - the
   * in-process equivalent of `time()`'s `samples`. */
  samples?: number
  minSamples?: number
  gc?: boolean
  /** Capture one extra `phase: "cpu"` measurement per task (200ms of the
   * task looped under the JSC sampling profiler, JIT tiers included), never
   * mixed into the timing numbers. `TaskOptions.cpu` / `GroupOptions.cpu`
   * override this per task or group. */
  cpu?: boolean
  /** Capture one extra `phase: "memstats"` measurement per task: bytes
   * allocated per call, from a `Bun.gc(true)`-bracketed batch.
   * `TaskOptions.alloc` / `GroupOptions.alloc` override this per task or
   * group. */
  alloc?: boolean
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
  /** Kills a suite file's subprocess (or, under `isolate`, one task's
   * dedicated subprocess) with SIGKILL if it hasn't finished after this many
   * ms. No default: an unset `timeoutMs` never times out. Applies to the
   * whole subprocess, not per task - the same granularity `isolate` already
   * runs at. */
  timeoutMs?: number
  /** Aborting cancels the run: in-flight suite/isolated-task subprocesses
   * are killed with SIGKILL, no new ones are started, and `bench()` resolves
   * (never rejects) with whatever suites/tasks had already finished when the
   * signal fired, plus an `aborted` warning on the document's last
   * measurement. A suite subprocess killed mid-run contributes nothing (it
   * only writes its result once, at the end), so a suite that was in flight
   * when the signal fired is dropped entirely rather than partially
   * represented. */
  signal?: AbortSignal
}

const RUNNER_PATH = new URL("./runner.ts", import.meta.url).pathname

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
  return scanGlobs(patterns, cwd)
}

/** The subset of `ostia bench`'s CLI flags that have a config-file
 * counterpart in `BenchConfig`. */
export interface BenchCliOverrides {
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
  bunFlags?: string[]
  outDir?: string
  noiseCheck: boolean
  timeoutMs?: number
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
    budgetMs: cli.budgetMs ?? config?.budgetMs,
    samples: cli.samples ?? config?.samples,
    minSamples: cli.minSamples ?? config?.minSamples,
    jobs: cli.jobs ?? resolveConfigJobs(config?.jobs),
    gc: cli.gc ?? config?.gc ?? false,
    cpu: cli.cpu ?? config?.cpu ?? false,
    alloc: cli.alloc ?? config?.alloc ?? false,
    filter: cli.filter ?? config?.filter,
    isolate: cli.isolate ?? config?.isolate ?? false,
    preload: cli.preload.length > 0 ? cli.preload : (config?.preload ?? []),
    bunFlags: cli.bunFlags,
    outDir: cli.outDir ?? config?.outDir,
    noiseCheck: cli.noiseCheck,
    timeoutMs: cli.timeoutMs ?? config?.timeoutMs,
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
  if (
    opts.samples !== undefined &&
    (!Number.isFinite(opts.samples) || opts.samples < 1)
  ) {
    throw new RangeError(`bench: samples must be >= 1, got ${opts.samples}`)
  }
  if (
    opts.minSamples !== undefined &&
    (!Number.isFinite(opts.minSamples) || opts.minSamples < 1)
  ) {
    throw new RangeError(
      `bench: minSamples must be >= 1, got ${opts.minSamples}`,
    )
  }
  if (opts.budgetMs !== undefined && !Number.isFinite(opts.budgetMs)) {
    throw new RangeError(`bench: budgetMs must be finite, got ${opts.budgetMs}`)
  }

  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  const tmpDir = `${outDir}/bench-tmp`
  const cwd = opts.cwd ?? process.cwd()
  const jobs = Math.max(1, Math.floor(opts.jobs ?? 1))

  const taskOpts = {
    budgetMs: opts.budgetMs,
    samples: opts.samples,
    minSamples: opts.minSamples,
    gc: opts.gc,
    cpu: opts.cpu,
    alloc: opts.alloc,
    noiseCheck: opts.noiseCheck,
  }

  // Plain string join, not path.resolve: the suite path is hashed into every
  // workload id, so normalizing "./x" would orphan existing baselines.
  const absolute = (file: string) =>
    file.startsWith("/") ? file : `${cwd}/${file}`
  const resolvedSuites = opts.suites.map(absolute)
  const resolvedPreloads = (opts.preload ?? []).map(absolute)
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
      while (
        failure === undefined &&
        !opts.signal?.aborted &&
        next < argvList.length
      ) {
        const index = next++
        try {
          let timedOut = false
          const timeoutSignal =
            opts.timeoutMs !== undefined
              ? AbortSignal.timeout(opts.timeoutMs)
              : undefined
          timeoutSignal?.addEventListener(
            "abort",
            () => {
              timedOut = true
            },
            { once: true },
          )
          const signal = combineSignals(timeoutSignal, opts.signal)
          const proc = Bun.spawn(argvList[index]!, {
            cwd,
            stdout: "inherit",
            stderr: "inherit",
            stdin: "ignore",
            ...(signal && { signal, killSignal: "SIGKILL" as const }),
          })
          inFlight.add(proc)
          const exitCode = await proc.exited
          inFlight.delete(proc)
          // Killed by the caller's cancellation, not a timeout or a real
          // failure: the run is already stopping, so this isn't a new error
          // to surface - just stop pulling more work.
          if (opts.signal?.aborted) return
          if (timedOut) {
            throw new Error(
              `Bench suite timed out after ${opts.timeoutMs}ms: ${describe(index)}`,
            )
          }
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

    // A suite's subprocess writes its plan/primary files once, at the very
    // end of its run: if cancellation killed it mid-run, neither file
    // exists, and that suite contributes nothing to the document rather
    // than a partial/corrupt read.
    const plans: PlannedTask[][] = await Promise.all(
      planPaths.map(async (p) => {
        if (!(await Bun.file(p).exists())) return []
        const { tasks } = (await Bun.file(p).json()) as {
          tasks: PlannedTask[]
        }
        return tasks
      }),
    )
    const primaryDocs: (ProfileDocument | undefined)[] = await Promise.all(
      primaryPaths.map(async (p) =>
        (await Bun.file(p).exists()) ? loadDocument(p) : undefined,
      ),
    )

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

    const itemDocs: (ProfileDocument | undefined)[] = await Promise.all(
      itemPaths.map(async (p) =>
        (await Bun.file(p).exists()) ? loadDocument(p) : undefined,
      ),
    )

    // Reassemble each suite's contribution in the plan's order (registration
    // order, filtered) regardless of which item a task landed in, then
    // concatenate suites in command-line order - the same ordering guarantee
    // bench() has always made, now independent of isolate/spawn granularity.
    // Measurements are looked up by workloadId, not position: a task.skip()'d
    // task still gets a workload but no measurement, so the two arrays a
    // runner produces aren't always the same length.
    const workloads: Workload[] = []
    const measurements: Measurement[] = []
    for (let s = 0; s < plans.length; s++) {
      // Cancelled before this suite's subprocess finished: nothing was
      // written for it, so it's absent from the document entirely rather
      // than represented with zero workloads.
      const sharedDoc = primaryDocs[s]
      if (!sharedDoc) continue
      const sharedMeasurementsByWorkloadId = new Map<string, Measurement[]>()
      for (const m of sharedDoc.measurements) {
        const list = sharedMeasurementsByWorkloadId.get(m.workloadId) ?? []
        list.push(m)
        sharedMeasurementsByWorkloadId.set(m.workloadId, list)
      }
      let sharedPtr = 0
      const isolatedDocById = new Map<string, ProfileDocument>()
      items.forEach((it, i) => {
        const doc = itemDocs[i]
        if (it.suiteIndex === s && doc) {
          isolatedDocById.set(it.taskIds[0]!, doc)
        }
      })

      for (const t of plans[s]!) {
        if (t.isolate) {
          // Cancelled before this isolated task's dedicated subprocess
          // finished: drop just this task rather than the whole suite.
          const doc = isolatedDocById.get(t.id)
          if (!doc) continue
          const workload = doc.workloads[0]!
          workloads.push(workload)
          for (const m of doc.measurements) {
            if (m.workloadId === workload.id) measurements.push(m)
          }
        } else {
          const workload = sharedDoc.workloads[sharedPtr]!
          workloads.push(workload)
          sharedPtr++
          for (const m of sharedMeasurementsByWorkloadId.get(workload.id) ??
            []) {
            measurements.push(m)
          }
        }
      }
    }

    if (opts.signal?.aborted && measurements.length > 0) {
      const last = measurements[measurements.length - 1]!
      last.warnings = [
        ...last.warnings,
        {
          code: "aborted",
          message:
            "Run was cancelled before it finished; this document holds whatever suites/tasks had already completed.",
        },
      ]
    }

    return newDocument(
      workloads,
      measurements,
      primaryDocs.find((d) => d !== undefined)?.environment,
    )
  } finally {
    await Bun.spawn(["rm", "-rf", tmpDir]).exited
  }
}
