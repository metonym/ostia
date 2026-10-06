import { type BenchConfig, DEFAULT_OUT_DIR } from "../config/index.ts"
import { scanGlobs } from "../glob.ts"
import {
  configFingerprint,
  createDocument,
  makeInstrumentedMeasurement,
} from "../ir/document.ts"
import { fp } from "../ir/fp.ts"
import type { Measurement, ProfileDocument, Workload } from "../ir/types.ts"
import type { PeakMemResult } from "../measure/peak.ts"
import { assertSamplingOptions } from "../measure/timing.ts"
import type { RunnerOpts } from "./runner.ts"
import {
  absolutePath,
  assertSuiteExists,
  captureRunEnvironment,
  loadIfExists,
  median,
  PEAK_MEM_PROCESSES,
  peakHiddenWarning,
  removeDir,
  runRunnerProcess,
  stampRunWarnings,
  uniqueTmpDir,
} from "./support.ts"

export interface BenchOptions {
  suites: string[]
  /** Wall-clock sampling budget per task, ms (default 500). */
  budgetMs?: number
  /** Exact trial count per task; the budget is ignored when set. */
  samples?: number
  minSamples?: number
  gc?: boolean
  /** Capture one extra `phase: "cpu"` measurement per task (the task looped
   * under the JSC sampling profiler for ~2,000 samples, JIT tiers included),
   * never mixed into the timing numbers. Task/group `cpu` overrides this. */
  cpu?: boolean
  /** `cpu`'s sampling interval, µs (default: 100). A coarser interval
   * lengthens the capture to keep the sample count, up to 10s per task. */
  cpuIntervalUs?: number
  /** Capture one extra `phase: "memstats"` measurement per task: retained
   * heap growth per call, from a batch with `Bun.gc(true)` on both sides.
   * What the calls keep alive, not what they allocate. Task/group `alloc`
   * overrides this. */
  alloc?: boolean
  /** Capture one extra `phase: "memstats"` measurement per task: how far the
   * task's first call raises RSS, garbage included. Median of 3 fresh
   * processes, each run with `OSTIA_PEAK_MEM=1` in its environment (see
   * `measurePeakMem`). Task/group `peakMem` overrides this. */
  peakMem?: boolean
  filter?: string
  /** Suite files (or isolated tasks) to run at once, each in its own child
   * process (default: 1). Concurrent CPU-bound processes contend for cores,
   * caches and turbo headroom, so timings under `jobs > 1` are noisier and
   * not like-for-like with a baseline measured at 1. */
  jobs?: number
  outDir?: string
  cwd?: string
  /** Give every task its own subprocess instead of sharing its suite file's,
   * isolating JIT tier state, inline caches and heap shape between tasks.
   * Task/group `isolate` overrides this. Multiplies spawn overhead by task
   * count instead of file count. */
  isolate?: boolean
  /** Scripts run, in order, before each suite file loads, in the same
   * subprocess: install globals (jsdom) or a `Bun.plugin()` loader ahead of
   * the suite's top-level code. */
  preload?: string[]
  /** Extra flags for the `bun` invocation that runs each suite file (e.g.
   * `["--conditions", "browser"]`), placed before the runner script path. */
  bunFlags?: string[]
  /** Measure this machine's noise floor once, before any suite runs
   * (default: true), and stamp it on the document as `environment`. */
  noiseCheck?: boolean
  /** SIGKILLs a suite file's subprocess (or, under `isolate`, one task's) that
   * hasn't finished after this many ms. No default. */
  timeoutMs?: number
  /** Aborting kills in-flight subprocesses, starts no new ones, and resolves
   * (never rejects) with whatever suites/tasks had finished, plus an
   * `aborted` warning on the last measurement. A suite killed mid-run is
   * dropped entirely: it only writes its result once, at the end. */
  signal?: AbortSignal
}

const RUNNER_PATH = new URL("./runner.ts", import.meta.url).pathname

/** Logical CPUs available to this process, for `--jobs auto`. */
export function availableJobs(): number {
  return Math.max(1, navigator.hardwareConcurrency || 1)
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
  cpuIntervalUs?: number
  alloc?: boolean
  peakMem?: boolean
  filter?: string
  isolate?: boolean
  preload: string[]
  bunFlags: string[]
  outDir?: string
  noiseCheck: boolean
  timeoutMs?: number
}

/** Merges CLI flags with `ostia.config.json`'s `bench` section: a CLI value
 * wins per field, then the config's, then `bench()`'s own defaults (left
 * undefined). `suites`, `preload` and `bunFlags` are replaced wholesale, not
 * merged. */
export async function resolveBenchOptions(
  cli: BenchCliOverrides,
  config: BenchConfig | undefined,
  cwd: string = process.cwd(),
): Promise<BenchOptions> {
  const suites =
    cli.suites.length > 0
      ? cli.suites
      : config?.suites
        ? await scanGlobs(config.suites, cwd)
        : []

  return {
    suites,
    budgetMs: cli.budgetMs ?? config?.budgetMs,
    samples: cli.samples ?? config?.samples,
    minSamples: cli.minSamples ?? config?.minSamples,
    jobs:
      cli.jobs ?? (config?.jobs === "auto" ? availableJobs() : config?.jobs),
    gc: cli.gc ?? config?.gc ?? false,
    cpu: cli.cpu ?? config?.cpu ?? false,
    cpuIntervalUs: cli.cpuIntervalUs ?? config?.cpuIntervalUs,
    alloc: cli.alloc ?? config?.alloc ?? false,
    peakMem: cli.peakMem ?? config?.peakMem ?? false,
    filter: cli.filter ?? config?.filter,
    isolate: cli.isolate ?? config?.isolate ?? false,
    preload: cli.preload.length > 0 ? cli.preload : (config?.preload ?? []),
    bunFlags: cli.bunFlags.length > 0 ? cli.bunFlags : (config?.bunFlags ?? []),
    outDir: cli.outDir ?? config?.outDir,
    noiseCheck: cli.noiseCheck,
    timeoutMs: cli.timeoutMs ?? config?.timeoutMs,
    cwd,
  }
}

interface PlannedTask {
  workloadId: string
  isolate: boolean
  peakMem: boolean
}

function peakMeasurement(
  workload: Workload,
  readings: PeakMemResult[] | undefined,
): Measurement[] {
  if (!readings?.length) return []
  const peak = median(readings.map((r) => r.peakBytes))
  const warning = peakHiddenWarning(readings)
  return [
    makeInstrumentedMeasurement({
      workload,
      phase: "memstats",
      configFingerprint: configFingerprint({ peakMem: true }),
      diagnosticWallNs: median(readings.map((r) => r.wallNs)),
      memory: { origin: "resourceUsage", kind: "peak", peakBytes: peak },
      warnings: warning ? [warning] : [],
      artifacts: [],
    }),
  ]
}

interface RunnerJob {
  suiteIndex: number
  outPath: string
  runnerOpts: RunnerOpts
}

export async function bench(opts: BenchOptions): Promise<ProfileDocument> {
  assertSamplingOptions("bench", opts)
  const jobs = opts.jobs ?? 1
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new RangeError(`bench: jobs must be an integer >= 1, got ${jobs}`)
  }

  const cwd = opts.cwd ?? process.cwd()
  // Against `cwd`, where the runner subprocesses write, not this process's
  // cwd, where it reads their results back.
  const tmpDir = uniqueTmpDir(
    absolutePath(cwd, opts.outDir ?? DEFAULT_OUT_DIR),
    "bench",
  )
  const suites = opts.suites.map((file) => absolutePath(cwd, file))
  for (const [i, suite] of suites.entries()) {
    assertSuiteExists(opts.suites[i]!, suite)
  }
  const preload = (opts.preload ?? []).map((file) => absolutePath(cwd, file))
  const bunFlags = opts.bunFlags ?? []
  const { environment, noiseWarning } = captureRunEnvironment(opts.noiseCheck)

  const measureOpts = {
    budgetMs: opts.budgetMs,
    samples: opts.samples,
    minSamples: opts.minSamples,
    gc: opts.gc,
    cpu: opts.cpu,
    cpuIntervalUs: opts.cpuIntervalUs,
    alloc: opts.alloc,
    peakMem: opts.peakMem,
    // Measured once here: every runner repeating the ~200ms reference
    // measurement only to have all but the first discarded cost seconds.
    noiseCheck: false,
  }

  const outPath = (tag: string, suiteIndex: number, ...rest: unknown[]) =>
    `${tmpDir}/${fp(tag, suites[suiteIndex], ...rest)}.json`

  // `jobs` workers pull from a shared cursor. The first failure stops the
  // pool: queued jobs are skipped and in-flight children killed, so a broken
  // suite fails the run fast.
  const runPool = async (
    list: RunnerJob[],
    env?: Record<string, string>,
  ): Promise<void> => {
    const inFlight = new Set<Bun.Subprocess>()
    let next = 0
    let failure: Error | undefined

    const worker = async (): Promise<void> => {
      while (
        failure === undefined &&
        !opts.signal?.aborted &&
        next < list.length
      ) {
        const job = list[next++]!
        try {
          const ran = await runRunnerProcess(
            [
              "bun",
              ...bunFlags,
              RUNNER_PATH,
              suites[job.suiteIndex]!,
              job.outPath,
              JSON.stringify(job.runnerOpts),
            ],
            {
              label: "Bench suite",
              name: opts.suites[job.suiteIndex]!,
              cwd,
              env,
              timeoutMs: opts.timeoutMs,
              signal: opts.signal,
              inFlight,
            },
          )
          if (!ran) return
        } catch (err) {
          failure ??= err instanceof Error ? err : new Error(String(err))
          for (const proc of inFlight) proc.kill()
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(jobs, list.length) }, worker),
    )
    if (failure) throw failure
  }

  try {
    // Phase 1: import each suite once. The same process records the plan
    // (each task's effective isolate/peakMem) and runs the non-isolated
    // tasks, so module-scope setup never runs twice just to learn the plan.
    const primaries = suites.map((_, i) => ({
      planPath: outPath("bench-plan", i),
      outPath: outPath("bench-primary", i),
    }))
    await runPool(
      primaries.map((p, i) => ({
        suiteIndex: i,
        outPath: p.outPath,
        runnerOpts: {
          ...measureOpts,
          filter: opts.filter,
          isolate: opts.isolate,
          preload,
          planPath: p.planPath,
        },
      })),
    )

    // A suite killed mid-run wrote neither file and contributes nothing.
    const plans: PlannedTask[][] = await Promise.all(
      primaries.map(async (p) =>
        (await Bun.file(p.planPath).exists())
          ? ((await Bun.file(p.planPath).json()) as { tasks: PlannedTask[] })
              .tasks
          : [],
      ),
    )
    const primaryDocs = await Promise.all(
      primaries.map((p) => loadIfExists(p.outPath)),
    )

    // Phase 2: each isolated task in its own subprocess.
    const isolated = plans.flatMap((tasks, suiteIndex) =>
      tasks
        .filter((task) => task.isolate)
        .map((task) => ({ task, suiteIndex })),
    )
    const isolatedPaths = isolated.map((item, i) =>
      outPath("bench-item", item.suiteIndex, i),
    )
    await runPool(
      isolated.map((item, i) => ({
        suiteIndex: item.suiteIndex,
        outPath: isolatedPaths[i]!,
        runnerOpts: {
          ...measureOpts,
          workloadIds: [item.task.workloadId],
          preload,
          markIsolated: true,
        },
      })),
    )
    const isolatedDocs = new Map<PlannedTask, ProfileDocument>()
    await Promise.all(
      isolated.map(async (item, i) => {
        const doc = await loadIfExists(isolatedPaths[i]!)
        if (doc) isolatedDocs.set(item.task, doc)
      }),
    )

    // Phase 3: each `peakMem` task's first call, alone in a fresh process,
    // PEAK_MEM_PROCESSES times.
    const peakRuns = plans.flatMap((tasks, suiteIndex) =>
      tasks
        .filter((task) => task.peakMem)
        .flatMap((task) =>
          Array.from({ length: PEAK_MEM_PROCESSES }, () => ({
            workloadId: task.workloadId,
            suiteIndex,
          })),
        ),
    )
    const peakPaths = peakRuns.map((run, i) =>
      outPath("bench-peak", run.suiteIndex, i),
    )
    await runPool(
      peakRuns.map((run, i) => ({
        suiteIndex: run.suiteIndex,
        outPath: peakPaths[i]!,
        runnerOpts: {
          filter: opts.filter,
          preload,
          peakMemFor: run.workloadId,
        },
      })),
      // Lets a suite skip heavy module-scope work that would peak before the
      // measured call does.
      { OSTIA_PEAK_MEM: "1" },
    )
    const peakReadings = new Map<string, PeakMemResult[]>()
    for (let i = 0; i < peakRuns.length; i++) {
      const file = Bun.file(peakPaths[i]!)
      if (!(await file.exists())) continue
      const id = peakRuns[i]!.workloadId
      const readings = peakReadings.get(id) ?? []
      readings.push((await file.json()) as PeakMemResult)
      peakReadings.set(id, readings)
    }

    // Plan order (registration order, filtered) within a suite, suites in
    // command-line order. Measurements are matched by workload id, not
    // position: a task.skip()'d task has a workload but no measurement.
    const workloads: Workload[] = []
    const measurements: Measurement[] = []
    plans.forEach((tasks, s) => {
      // A cancelled suite wrote nothing and is absent, not empty.
      const sharedDoc = primaryDocs[s]
      if (!sharedDoc) return
      const sharedByWorkload = Map.groupBy(
        sharedDoc.measurements,
        (m) => m.workloadId,
      )
      let sharedPtr = 0
      for (const task of tasks) {
        let workload: Workload
        let own: Measurement[]
        if (task.isolate) {
          // Cancelled before its subprocess finished: drop just this task.
          const doc = isolatedDocs.get(task)
          if (!doc) continue
          workload = doc.workloads[0]!
          own = doc.measurements.filter((m) => m.workloadId === workload.id)
        } else {
          workload = sharedDoc.workloads[sharedPtr++]!
          own = sharedByWorkload.get(workload.id) ?? []
        }
        workloads.push(workload)
        measurements.push(
          ...own,
          ...peakMeasurement(workload, peakReadings.get(workload.id)),
        )
      }
    })

    stampRunWarnings(
      measurements,
      noiseWarning,
      opts.signal?.aborted
        ? "Run was cancelled before it finished; this document holds whatever suites/tasks had already completed."
        : undefined,
    )
    return createDocument(workloads, measurements, environment)
  } finally {
    await removeDir(tmpDir)
  }
}
