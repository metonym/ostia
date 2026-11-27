import { runCpuCapture } from "./capture/cpu.ts";
import { runHeapCapture } from "./capture/heap.ts";
import { DEFAULT_OUT_DIR } from "./config/index.ts";
import {
  configFingerprint,
  createDocument,
  type InstrumentedMeasurementInput,
  makeArtifactRef,
  makeInstrumentedMeasurement,
  makeSubprocessWorkload,
  makeTimingMeasurement,
} from "./ir/document.ts";
import type {
  ArtifactRef,
  Measurement,
  ProfileDocument,
  Warning,
  Workload,
} from "./ir/types.ts";
import {
  captureEnvironment,
  noisyMachineWarning,
  stampDrift,
} from "./measure/environment.ts";
import { assertSamplingOptions, createTimingPhase } from "./measure/timing.ts";
import {
  type PrepareHook,
  type PrepareRun,
  runPrepare,
  splitCommand,
  type TimeSource,
} from "./spawn/index.ts";

export const DEFAULT_CPU_INTERVAL_US = 1000;

/**
 * One command for `time()`: a string (whitespace-split, no shell), an argv
 * array, or an object with per-command settings, which is how one command
 * becomes several labeled workloads (e.g. warm vs cold `prepare`). */
export interface CommandSpec {
  command: string | string[];
  label?: string;
  /** Overrides `TimeOptions.prepare` for this command. */
  prepare?: PrepareHook;
  /** Overrides `TimeOptions.timeSource` for this command. */
  timeSource?: TimeSource;
  /** Overrides `TimeOptions.timeoutMs` for this command. */
  timeoutMs?: number;
  /** Overrides `TimeOptions.ignoreExitCodes` for this command. */
  ignoreExitCodes?: number[];
}

export interface TimeOptions {
  commands: (string | string[] | CommandSpec)[];
  /**
   * Run each string command, and a string `prepare`, as `shell -c COMMAND`
   * (`"sh"`, `"bash"`) instead of splitting it on whitespace, so env
   * prefixes, pipes, `&&` and `$(...)` work. An argv array runs as given.
   * The shell's own startup is measured and recorded as `doc.shell`,
   * not subtracted.
   */
  shell?: string;
  /**
   * Save each trial's stdout and stderr under this directory, one folder
   * per command (its label, made safe for a path, and its id), as
   * `trial-N.log` and `warmup-N.log`; each trial's `outputPath` names
   * its file.
   */
  saveOutput?: string;
  /** Pass each trial's output to stderr, for debugging. */
  showOutput?: boolean;
  /**
   * Runs unmeasured before every trial (warmup and instrumented included),
   * in `cwd`/`env`: a command spawned and awaited, or a function. */
  prepare?: PrepareHook;
  /**
   * Take timing from a number in each command's own output (e.g. a build
   * tool's `built in 342ms`) instead of its wall clock. */
  timeSource?: TimeSource;
  /** Exact trial count; when set, `budgetMs` is ignored. */
  samples?: number;
  /**
   * Wall-clock budget for the sampling loop, ms. Default: ~3s when neither
   * `samples` nor `budgetMs` is given. */
  budgetMs?: number;
  /** Floor on trials when no exact `samples` is given. */
  minSamples?: number;
  warmup?: number;
  /**
   * Round-robin trials across commands instead of finishing each command
   * first, so drift hits every command equally. Default: true with
   * 2+ commands.
   */
  interleave?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  cpu?: boolean;
  heap?: boolean;
  cpuIntervalUs?: number;
  outDir?: string;
  /**
   * Measure the machine's noise floor first (default true, 25 to 50 ms) and
   * stamp it on the document as `environment`. */
  noiseCheck?: boolean;
  /** Sample the noise floor for exactly this many ms instead. */
  noiseBudgetMs?: number;
  /**
   * SIGKILLs a trial (or prepare hook) still running after this many ms. No
   * default. A timed-out trial contributes no sample. */
  timeoutMs?: number;
  /**
   * Abort kills in-flight trials, schedules no more, and resolves (never
   * rejects) with the completed measurements plus an `aborted` warning on
   * the last one. */
  signal?: AbortSignal;
  /**
   * Exit codes to treat as success (hyperfine's `--ignore-failure`): the
   * trial still contributes its sample and gets no `nonzero-exit` warning.
   * */
  ignoreExitCodes?: number[];
  /** Called after each trial, for a progress line. */
  onProgress?: (progress: TimeProgress) => void;
}

/** What `time()` is doing, for `onProgress`. Counts start at 1. */
export interface TimeProgress {
  command: number;
  commands: number;
  label: string;
  /** Trials run so far for this command, warmup excluded. */
  runs: number;
  /** How far the whole run is, 0 to 1. */
  doneRatio: number;
}

export function abortedWarning(): Warning {
  return {
    code: "aborted",
    message:
      "Run was cancelled before it finished; this document holds whatever measurements had already completed.",
  };
}

/** Times each of `commands` as a subprocess, as `ostia time` does. */
export async function time(opts: TimeOptions): Promise<ProfileDocument> {
  assertSamplingOptions("time", opts);

  const cfgFp = configFingerprint({
    samples: opts.samples ?? null,
    budgetMs: opts.budgetMs ?? null,
    minSamples: opts.minSamples ?? null,
    warmup: opts.warmup ?? null,
    cpu: opts.cpu ?? false,
    heap: opts.heap ?? false,
    cpuIntervalUs: opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
  });
  const artifactDir = `${opts.outDir ?? DEFAULT_OUT_DIR}/artifacts`;
  const environment =
    opts.noiseCheck === false
      ? undefined
      : captureEnvironment(opts.noiseBudgetMs);
  const noiseWarning = environment
    ? noisyMachineWarning(environment)
    : undefined;

  const workloads: Workload[] = [];
  const measurements: Measurement[] = [];
  const where = spawnLocation(opts);

  const entries = opts.commands.map((entry) => {
    const spec: CommandSpec =
      typeof entry === "string" || Array.isArray(entry)
        ? { command: entry }
        : entry;
    const argv = Array.isArray(spec.command)
      ? spec.command
      : opts.shell
        ? [opts.shell, "-c", spec.command]
        : splitCommand(spec.command);
    const givenPrepare = spec.prepare ?? opts.prepare;
    const prepare =
      opts.shell && typeof givenPrepare === "string"
        ? [opts.shell, "-c", givenPrepare]
        : givenPrepare;
    const timeSource = spec.timeSource ?? opts.timeSource;
    const workload = makeSubprocessWorkload(
      argv,
      spec.label ?? (Array.isArray(spec.command) ? undefined : spec.command),
      {
        ...(prepare !== undefined && { prepare }),
        ...(timeSource !== undefined && { timeSource }),
      },
    );
    return {
      argv,
      workload,
      prepare,
      timeSource,
      timeoutMs: spec.timeoutMs ?? opts.timeoutMs,
      ignoreExitCodes: spec.ignoreExitCodes ?? opts.ignoreExitCodes,
    };
  });

  const interleave = (opts.interleave ?? true) && entries.length > 1;

  const runs = entries.map((entry) => ({
    entry,
    phase: createTimingPhase({
      argv: entry.argv,
      ...where,
      ...(opts.samples !== undefined && { samples: opts.samples }),
      ...(opts.budgetMs !== undefined && { budgetMs: opts.budgetMs }),
      ...(opts.minSamples !== undefined && { minSamples: opts.minSamples }),
      ...(opts.warmup !== undefined && { warmup: opts.warmup }),
      ...(entry.prepare !== undefined && { prepare: entry.prepare }),
      ...(entry.timeSource !== undefined && { timeSource: entry.timeSource }),
      ...(entry.timeoutMs !== undefined && { timeoutMs: entry.timeoutMs }),
      ...(entry.ignoreExitCodes !== undefined && {
        ignoreExitCodes: entry.ignoreExitCodes,
      }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
      ...(opts.saveOutput !== undefined && {
        outputDir: `${opts.saveOutput}/${outputFolder(entry.workload)}`,
      }),
      ...(opts.showOutput && { showOutput: true }),
    }),
  }));

  const record = async ({ entry, phase }: (typeof runs)[number]) => {
    const { argv, workload, prepare } = entry;
    workloads.push(workload);
    const phaseResult = phase.result();
    const timingMeasurement = makeTimingMeasurement({
      workload,
      configFingerprint: cfgFp,
      trials: phaseResult.trials,
      ...(phaseResult.timing && { timing: phaseResult.timing }),
      warnings:
        noiseWarning && measurements.length === 0
          ? [...phaseResult.warnings, noiseWarning]
          : phaseResult.warnings,
      ...(interleave && { interleaved: true }),
    });
    measurements.push(timingMeasurement);
    // An instrumented capture is one more spawned run, so don't start it
    // once cancelled.
    if (!opts.signal?.aborted) {
      measurements.push(
        ...(await captureInstrumentedPhases({
          workload,
          argv,
          timingMeasurementId: timingMeasurement.id,
          cfgFp,
          opts,
          artifactDir,
          prepare,
        })),
      );
    }
  };

  const shell = opts.shell
    ? { command: opts.shell, startupNs: await shellStartupNs(opts.shell) }
    : undefined;

  const runsDone = runs.map(() => 0);
  const report = (index: number) => {
    const entry = runs[index]?.entry;
    if (!opts.onProgress || !entry) return;
    opts.onProgress({
      command: index + 1,
      commands: runs.length,
      label: entry.workload.label ?? entry.argv.join(" "),
      runs: runsDone[index] ?? 0,
      doneRatio:
        runs.reduce((sum, { phase }) => sum + phase.doneRatio(), 0) /
        runs.length,
    });
  };
  const step = async (index: number): Promise<boolean> => {
    const stepped = (await runs[index]?.phase.step()) ?? false;
    if (stepped) {
      runsDone[index] = (runsDone[index] ?? 0) + 1;
      report(index);
    }
    return stepped;
  };

  if (interleave) {
    for (const [index, { phase }] of runs.entries()) {
      report(index);
      await phase.warmup();
    }
    let stepped = true;
    while (stepped) {
      stepped = false;
      for (const index of runs.keys()) {
        if (await step(index)) stepped = true;
      }
    }
    for (const run of runs) await record(run);
  } else {
    for (const [index, run] of runs.entries()) {
      report(index);
      await run.phase.warmup();
      while (await step(index)) {
        // Each step runs one trial.
      }
      await record(run);
    }
  }

  const last = measurements.at(-1);
  if (opts.signal?.aborted && last) {
    last.warnings = [...last.warnings, abortedWarning()];
  }

  stampDrift(environment);
  const doc = createDocument(workloads, measurements, environment);
  if (shell) doc.shell = shell;
  return doc;
}

// A command's folder under `--save-output`: its label, safe for a path,
// then its id, since two commands can share a label.
function outputFolder(workload: Workload): string {
  const name = (workload.label ?? workload.command?.join(" ") ?? "command")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${name || "command"}-${workload.id.slice(3, 11)}`;
}

const SHELL_STARTUP_RUNS = 5;

// The median wall time of `shell -c :`, the startup every command run
// through the shell pays, so a reader can tell it from the command's own.
async function shellStartupNs(shell: string): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < SHELL_STARTUP_RUNS; i++) {
    const start = Bun.nanoseconds();
    // eslint-disable-next-line no-await-in-loop -- one at a time, so the runs don't share the machine
    await Bun.spawn([shell, "-c", ":"], { stdout: "ignore", stderr: "ignore" })
      .exited;
    samples.push(Bun.nanoseconds() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1] ?? 0;
}

async function captureInstrumentedPhases({
  workload,
  argv,
  timingMeasurementId,
  cfgFp,
  opts,
  artifactDir,
  prepare,
}: {
  workload: Workload;
  argv: string[];
  timingMeasurementId: string;
  cfgFp: string;
  opts: TimeOptions;
  artifactDir: string;
  prepare: PrepareHook | undefined;
}): Promise<Measurement[]> {
  const extra: Measurement[] = [];
  const where = spawnLocation(opts);
  // An instrumented run gets the prepare hook too, since it must start from
  // the same state (cold cache, fresh fixture) as a timing trial.
  const prepareFor = async (phase: PrepareRun["phase"]) => {
    if (prepare) await runPrepare(prepare, { phase, index: 0 }, where);
  };
  const captureOpts = (suffix: string) => ({
    argv,
    ...where,
    artifactDir,
    fileName: `${timingMeasurementId}-${suffix}`,
  });

  if (opts.cpu) {
    await prepareFor("cpu");
    const capture = await runCpuCapture({
      ...captureOpts("cpu.cpuprofile"),
      intervalUs: opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
    });
    extra.push(
      await instrumentedMeasurement({
        workload,
        phase: "cpu",
        configFingerprint: cfgFp,
        artifactKind: "cpuprofile",
        ...capture,
      }),
    );
  }

  if (opts.heap) {
    await prepareFor("heap");
    const capture = await runHeapCapture(captureOpts("heap.heapsnapshot"));
    extra.push(
      await instrumentedMeasurement({
        workload,
        phase: "heap",
        configFingerprint: cfgFp,
        artifactKind: "heapsnapshot",
        ...capture,
      }),
    );
  }

  return extra;
}

function spawnLocation(opts: TimeOptions): {
  cwd?: string;
  env?: Record<string, string>;
} {
  return {
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    ...(opts.env !== undefined && { env: opts.env }),
  };
}

async function instrumentedMeasurement({
  artifactPath,
  artifactKind,
  ...input
}: Omit<InstrumentedMeasurementInput, "artifacts"> & {
  artifactPath?: string;
  artifactKind: ArtifactRef["kind"];
}): Promise<Measurement> {
  const measurement = makeInstrumentedMeasurement({ ...input, artifacts: [] });
  if (artifactPath) {
    measurement.artifacts = [
      await makeArtifactRef(measurement.id, artifactKind, artifactPath),
    ];
  }
  return measurement;
}
