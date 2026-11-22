import {
  type BenchConfig,
  type BenchProject,
  DEFAULT_OUT_DIR,
} from "../config/index.ts";
import { scanGlobs } from "../glob.ts";
import {
  configFingerprint,
  createDocument,
  makeInstrumentedMeasurement,
} from "../ir/document.ts";
import { fp } from "../ir/fp.ts";
import type { Measurement, ProfileDocument, Workload } from "../ir/types.ts";
import { stampDrift } from "../measure/environment.ts";
import type { PeakMemResult } from "../measure/peak.ts";
import { assertSamplingOptions } from "../measure/timing.ts";
import { type SuiteLaunch, suiteLauncher } from "./projects.ts";
import type { RunnerOpts } from "./runner.ts";
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
} from "./support.ts";

export interface BenchOptions {
  suites: string[];
  /** Wall-clock sampling budget per task, ms (default 500). */
  budgetMs?: number;
  /** Exact trial count per task; the budget is ignored when set. */
  samples?: number;
  minSamples?: number;
  gc?: boolean;
  /**
   * Capture one extra `phase: "cpu"` measurement per task (the task looped
   * under the JSC sampling profiler for ~2,000 samples, JIT tiers included),
   * never mixed into the timing numbers. Task/group `cpu` overrides this. */
  cpu?: boolean;
  /**
   * `cpu`'s sampling interval, µs (default: 100). A coarser interval
   * lengthens the capture to keep the sample count, up to 10s per task. */
  cpuIntervalUs?: number;
  /**
   * Capture one extra `phase: "memstats"` measurement per task: retained
   * heap growth per call, from a batch with `Bun.gc(true)` on both sides.
   * What the calls keep alive, not what they allocate. Task/group `alloc`
   * overrides this. */
  alloc?: boolean;
  /**
   * Capture one extra `phase: "memstats"` measurement per task: how far the
   * task's first call raises RSS, garbage included. Median of 3 fresh
   * processes, each run with `OSTIA_PEAK_MEM=1` in its environment (see
   * `measurePeakMem`). Task/group `peakMem` overrides this. */
  peakMem?: boolean;
  filter?: string;
  /**
   * Suite files (or isolated tasks) to run at once, each in its own child
   * process (default: 1). Concurrent CPU-bound processes contend for cores,
   * caches and turbo headroom, so timings under `jobs > 1` are noisier and
   * not like-for-like with a baseline measured at 1. */
  jobs?: number;
  outDir?: string;
  cwd?: string;
  /**
   * Give every task its own subprocess instead of sharing its suite file's,
   * isolating JIT tier state, inline caches and heap shape between tasks.
   * Task/group `isolate` overrides this. Multiplies spawn overhead by task
   * count instead of file count. */
  isolate?: boolean;
  /**
   * Scripts run, in order, before each suite file loads, in the same
   * subprocess: install globals (jsdom) or a `Bun.plugin()` loader ahead of
   * the suite's top-level code. */
  preload?: string[];
  /**
   * Extra flags for the `bun` invocation that runs each suite file (e.g.
   * `["--conditions", "browser"]`), placed before the runner script path. */
  bunFlags?: string[];
  /**
   * Per-suite `preload` / `bunFlags`: the first project whose `suites` globs
   * match a suite file (by its path relative to `cwd`) replaces those two
   * fields for that file, so suites that need no setup don't pay for the
   * others'. A field a project leaves unset keeps the top-level value above;
   * `[]` clears it. */
  projects?: BenchProject[];
  /**
   * Measure this machine's noise floor once, before any suite runs
   * (default: true), and stamp it on the document as `environment`. */
  noiseCheck?: boolean;
  /**
   * SIGKILLs a suite file's subprocess (or, under `isolate`, one task's)
   * that hasn't finished after this many ms. No default. */
  timeoutMs?: number;
  /**
   * Aborting kills in-flight subprocesses, starts no new ones, and resolves
   * (never rejects) with whatever suites/tasks had finished, plus an
   * `aborted` warning on the last measurement. A suite killed mid-run is
   * dropped entirely: it only writes its result once, at the end. */
  signal?: AbortSignal;
}

const RUNNER_PATH = new URL("./runner.ts", import.meta.url).pathname;

export function availableJobs(): number {
  return Math.max(1, navigator.hardwareConcurrency || 1);
}

/**
 * The subset of `ostia bench`'s CLI flags that have a config-file
 * counterpart in `BenchConfig`. */
export interface BenchCliOverrides {
  suites: string[];
  budgetMs?: number;
  samples?: number;
  minSamples?: number;
  jobs?: number;
  gc?: boolean;
  cpu?: boolean;
  cpuIntervalUs?: number;
  alloc?: boolean;
  peakMem?: boolean;
  filter?: string;
  isolate?: boolean;
  preload: string[];
  bunFlags: string[];
  outDir?: string;
  noiseCheck: boolean;
  timeoutMs?: number;
}

// A CLI value wins per field, then the config's, then `bench()`'s own
// defaults (left undefined). `suites`, `preload` and `bunFlags` are
// replaced wholesale, never merged. With no CLI suites, the files to run
// are the config's `suites` plus whatever its `projects` match. A CLI
// `preload` / `bunFlags` also replaces that field in every project.
export async function resolveBenchOptions(
  cli: BenchCliOverrides,
  config: BenchConfig | undefined,
  cwd: string = process.cwd(),
): Promise<BenchOptions> {
  const globs = [
    ...(config?.suites ?? []),
    ...(config?.projects?.flatMap((p) => p.suites) ?? []),
  ];
  const suites =
    cli.suites.length > 0
      ? cli.suites
      : globs.length > 0
        ? await scanGlobs(globs, cwd)
        : [];

  const budgetMs = cli.budgetMs ?? config?.budgetMs;
  const samples = cli.samples ?? config?.samples;
  const minSamples = cli.minSamples ?? config?.minSamples;
  const jobs =
    cli.jobs ?? (config?.jobs === "auto" ? availableJobs() : config?.jobs);
  const cpuIntervalUs = cli.cpuIntervalUs ?? config?.cpuIntervalUs;
  const filter = cli.filter ?? config?.filter;
  const projects = config?.projects?.map(
    ({ preload, bunFlags, ...project }) => ({
      ...project,
      ...(cli.preload.length === 0 && preload !== undefined && { preload }),
      ...(cli.bunFlags.length === 0 && bunFlags !== undefined && { bunFlags }),
    }),
  );
  const outDir = cli.outDir ?? config?.outDir;
  const timeoutMs = cli.timeoutMs ?? config?.timeoutMs;
  return {
    suites,
    ...(budgetMs !== undefined && { budgetMs }),
    ...(samples !== undefined && { samples }),
    ...(minSamples !== undefined && { minSamples }),
    ...(jobs !== undefined && { jobs }),
    gc: cli.gc ?? config?.gc ?? false,
    cpu: cli.cpu ?? config?.cpu ?? false,
    ...(cpuIntervalUs !== undefined && { cpuIntervalUs }),
    alloc: cli.alloc ?? config?.alloc ?? false,
    peakMem: cli.peakMem ?? config?.peakMem ?? false,
    ...(filter !== undefined && { filter }),
    isolate: cli.isolate ?? config?.isolate ?? false,
    preload: cli.preload.length > 0 ? cli.preload : (config?.preload ?? []),
    bunFlags: cli.bunFlags.length > 0 ? cli.bunFlags : (config?.bunFlags ?? []),
    ...(projects !== undefined && { projects }),
    ...(outDir !== undefined && { outDir }),
    noiseCheck: cli.noiseCheck,
    ...(timeoutMs !== undefined && { timeoutMs }),
    cwd,
  };
}

interface PlannedTask {
  workloadId: string;
  isolate: boolean;
  peakMem: boolean;
}

function peakMeasurement(
  workload: Workload,
  readings: PeakMemResult[] | undefined,
): Measurement[] {
  if (!readings?.length) return [];
  const peak = median(readings.map((r) => r.peakBytes));
  const warning = peakHiddenWarning(readings);
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
  ];
}

interface Suite extends SuiteLaunch {
  // As the caller wrote it, for messages.
  given: string;
  path: string;
}

interface RunnerJob {
  suite: Suite;
  outPath: string;
  runnerOpts: RunnerOpts;
}

function isPlan(value: unknown): value is { tasks: PlannedTask[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "tasks" in value &&
    Array.isArray(value.tasks)
  );
}

function isPeakMemResult(value: unknown): value is PeakMemResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "peakBytes" in value &&
    typeof value.peakBytes === "number"
  );
}

/** Measures the tasks each of `suites` registers, one subprocess per file. */
export async function bench(opts: BenchOptions): Promise<ProfileDocument> {
  assertSamplingOptions("bench", opts);
  const jobs = opts.jobs ?? 1;
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new RangeError(`bench: jobs must be an integer >= 1, got ${jobs}`);
  }

  const cwd = opts.cwd ?? process.cwd();
  // Resolved against `cwd` because the runner subprocesses write there;
  // this process's own cwd may differ.
  const tmpDir = uniqueTmpDir(
    absolutePath(cwd, opts.outDir ?? DEFAULT_OUT_DIR),
    "bench",
  );
  for (const given of opts.suites) {
    assertSuiteExists(given, absolutePath(cwd, given));
  }
  const launch = suiteLauncher(cwd, opts, opts.projects);
  const suites = opts.suites.map((given): Suite => {
    const path = absolutePath(cwd, given);
    return { given, path, ...launch(path) };
  });
  const { environment, noiseWarning } = captureRunEnvironment(opts.noiseCheck);

  const measureOpts: RunnerOpts = {
    ...(opts.budgetMs !== undefined && { budgetMs: opts.budgetMs }),
    ...(opts.samples !== undefined && { samples: opts.samples }),
    ...(opts.minSamples !== undefined && { minSamples: opts.minSamples }),
    ...(opts.gc !== undefined && { gc: opts.gc }),
    ...(opts.cpu !== undefined && { cpu: opts.cpu }),
    ...(opts.cpuIntervalUs !== undefined && {
      cpuIntervalUs: opts.cpuIntervalUs,
    }),
    ...(opts.alloc !== undefined && { alloc: opts.alloc }),
    ...(opts.peakMem !== undefined && { peakMem: opts.peakMem }),
    // Measured once here: every runner repeating the ~200ms reference
    // measurement only to have all but the first discarded cost seconds.
    noiseCheck: false,
  };
  const filter = opts.filter !== undefined && { filter: opts.filter };

  const outPath = (tag: string, suite: Suite, ...rest: unknown[]) =>
    `${tmpDir}/${fp(tag, suite.path, ...rest)}.json`;

  // `jobs` workers pull from a shared cursor. The first failure stops the
  // pool: queued jobs are skipped and in-flight children killed, so a broken
  // suite fails the run fast.
  const runPool = async (
    list: RunnerJob[],
    env?: Record<string, string>,
  ): Promise<void> => {
    const inFlight = new Set<Bun.Subprocess>();
    let next = 0;
    let failure: Error | undefined;

    const worker = async (): Promise<void> => {
      while (failure === undefined && !opts.signal?.aborted) {
        const job = list[next++];
        if (job === undefined) return;
        try {
          const ran = await runRunnerProcess(
            [
              "bun",
              ...job.suite.bunFlags,
              RUNNER_PATH,
              job.suite.path,
              job.outPath,
              JSON.stringify(job.runnerOpts),
            ],
            {
              label: "Bench suite",
              name: job.suite.given,
              cwd,
              env,
              timeoutMs: opts.timeoutMs,
              signal: opts.signal,
              inFlight,
            },
          );
          if (!ran) return;
        } catch (err) {
          failure ??= err instanceof Error ? err : new Error(String(err));
          for (const proc of inFlight) proc.kill();
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(jobs, list.length) }, worker),
    );
    if (failure) throw failure;
  };

  try {
    // Phase 1: import each suite once. The same process records the plan
    // (each task's effective isolate/peakMem) and runs the non-isolated
    // tasks, so module-scope setup never runs twice just to learn the plan.
    const primaries = suites.map((suite) => ({
      suite,
      planPath: outPath("bench-plan", suite),
      outPath: outPath("bench-primary", suite),
    }));
    await runPool(
      primaries.map((p) => ({
        suite: p.suite,
        outPath: p.outPath,
        runnerOpts: {
          ...measureOpts,
          ...filter,
          ...(opts.isolate !== undefined && { isolate: opts.isolate }),
          preload: p.suite.preload,
          planPath: p.planPath,
        },
      })),
    );

    // A suite killed mid-run wrote neither file, so it contributes no tasks.
    const planTasks = await Promise.all(
      primaries.map(async (p): Promise<PlannedTask[]> => {
        if (!(await Bun.file(p.planPath).exists())) return [];
        const plan: unknown = await Bun.file(p.planPath).json();
        if (!isPlan(plan)) {
          throw new Error(`bench: unreadable plan for ${p.suite.given}`);
        }
        return plan.tasks;
      }),
    );
    const primaryDocs = await Promise.all(
      primaries.map((p) => loadIfExists(p.outPath)),
    );
    const plans = primaries.map((p, i) => ({
      suite: p.suite,
      tasks: planTasks[i] ?? [],
      doc: primaryDocs[i],
    }));

    // Phase 2: each isolated task in its own subprocess, so its JIT state
    // and heap are its own.
    const isolated = plans
      .flatMap(({ suite, tasks }) =>
        tasks.filter((task) => task.isolate).map((task) => ({ task, suite })),
      )
      .map((item, i) => ({
        ...item,
        outPath: outPath("bench-item", item.suite, i),
      }));
    await runPool(
      isolated.map((item) => ({
        suite: item.suite,
        outPath: item.outPath,
        runnerOpts: {
          ...measureOpts,
          workloadIds: [item.task.workloadId],
          preload: item.suite.preload,
          markIsolated: true,
        },
      })),
    );
    const isolatedDocs = new Map<PlannedTask, ProfileDocument>();
    await Promise.all(
      isolated.map(async (item) => {
        const doc = await loadIfExists(item.outPath);
        if (doc) isolatedDocs.set(item.task, doc);
      }),
    );

    // Phase 3: each `peakMem` task's first call, alone in a fresh process,
    // since memory an earlier call freed would hide part of its peak.
    const peakRuns = plans
      .flatMap(({ suite, tasks }) =>
        tasks
          .filter((task) => task.peakMem)
          .flatMap((task) =>
            Array.from({ length: PEAK_MEM_PROCESSES }, () => ({
              workloadId: task.workloadId,
              suite,
            })),
          ),
      )
      .map((run, i) => ({
        ...run,
        outPath: outPath("bench-peak", run.suite, i),
      }));
    await runPool(
      peakRuns.map((run) => ({
        suite: run.suite,
        outPath: run.outPath,
        runnerOpts: {
          ...filter,
          preload: run.suite.preload,
          peakMemFor: run.workloadId,
        },
      })),
      // Lets a suite skip heavy module-scope work that would peak before the
      // measured call does.
      { OSTIA_PEAK_MEM: "1" },
    );
    const peakReadings = new Map<string, PeakMemResult[]>();
    for (const run of peakRuns) {
      const file = Bun.file(run.outPath);
      if (!(await file.exists())) continue;
      const reading: unknown = await file.json();
      if (!isPeakMemResult(reading)) {
        throw new Error(
          `bench: unreadable peak-memory reading: ${run.outPath}`,
        );
      }
      const readings = peakReadings.get(run.workloadId) ?? [];
      readings.push(reading);
      peakReadings.set(run.workloadId, readings);
    }

    // Plan order (registration order, filtered) within a suite, suites in
    // command-line order. Measurements are matched by workload id, not
    // position, because a task.skip()'d task has a workload but no
    // measurement.
    const workloads: Workload[] = [];
    const measurements: Measurement[] = [];
    for (const { suite, tasks, doc: sharedDoc } of plans) {
      // A cancelled suite wrote nothing and is absent, not empty.
      if (!sharedDoc) continue;
      const sharedByWorkload = Map.groupBy(
        sharedDoc.measurements,
        (m) => m.workloadId,
      );
      const sharedWorkloads = sharedDoc.workloads.values();
      for (const task of tasks) {
        const doc = task.isolate ? isolatedDocs.get(task) : sharedDoc;
        // Cancelled before its subprocess finished: drop just this task.
        if (!doc) continue;
        const workload = task.isolate
          ? doc.workloads[0]
          : sharedWorkloads.next().value;
        if (workload === undefined) {
          throw new Error(
            `bench: ${suite.given} wrote fewer workloads than its plan`,
          );
        }
        const own = task.isolate
          ? doc.measurements.filter((m) => m.workloadId === workload.id)
          : (sharedByWorkload.get(workload.id) ?? []);
        workloads.push(workload);
        measurements.push(
          ...own,
          ...peakMeasurement(workload, peakReadings.get(workload.id)),
        );
      }
    }

    stampRunWarnings(
      measurements,
      noiseWarning,
      opts.signal?.aborted
        ? "Run was cancelled before it finished; this document holds whatever suites/tasks had already completed."
        : undefined,
    );
    stampDrift(environment);
    return createDocument(workloads, measurements, environment);
  } finally {
    await removeDir(tmpDir);
  }
}
