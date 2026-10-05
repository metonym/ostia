import { runCpuCapture } from "./capture/cpu/index.ts"
import { runHeapCapture } from "./capture/heap/index.ts"
import { DEFAULT_OUT_DIR } from "./config/index.ts"
import {
  configFingerprint,
  createDocument,
  type InstrumentedMeasurementInput,
  makeArtifactRef,
  makeInstrumentedMeasurement,
  makeSubprocessWorkload,
  makeTimingMeasurement,
} from "./ir/document.ts"
import type {
  ArtifactRef,
  Measurement,
  ProfileDocument,
  Warning,
  Workload,
} from "./ir/types.ts"
import {
  captureEnvironment,
  noisyMachineWarning,
} from "./measure/environment.ts"
import {
  assertSamplingOptions,
  createTimingPhase,
  drainTimingPhase,
} from "./measure/timing.ts"
import {
  type PrepareHook,
  type PrepareRun,
  runPrepare,
  splitCommand,
  type TimeSource,
} from "./spawn/index.ts"

export const DEFAULT_CPU_INTERVAL_US = 1000

/** One command for `time()`: a string (whitespace-split, no shell), an argv
 * array, or an object with per-command settings, which is how one command
 * becomes several labeled workloads (e.g. warm vs cold `prepare`). */
export interface CommandSpec {
  command: string | string[]
  label?: string
  /** Overrides `TimeOptions.prepare` for this command. */
  prepare?: PrepareHook
  /** Overrides `TimeOptions.timeSource` for this command. */
  timeSource?: TimeSource
  /** Overrides `TimeOptions.timeoutMs` for this command. */
  timeoutMs?: number
  /** Overrides `TimeOptions.ignoreExitCodes` for this command. */
  ignoreExitCodes?: number[]
}

export interface TimeOptions {
  commands: (string | string[] | CommandSpec)[]
  /** Runs unmeasured before every trial (warmup and instrumented included), in
   * `cwd`/`env`: a command spawned and awaited, or a function. */
  prepare?: PrepareHook
  /** Take timing from a number in each command's own output (e.g. a build
   * tool's `built in 342ms`) instead of its wall clock. */
  timeSource?: TimeSource
  /** Exact trial count; when set, `budgetMs` is ignored. */
  samples?: number
  /** Wall-clock budget for the sampling loop, ms. Default: ~3s when neither
   * `samples` nor `budgetMs` is given. */
  budgetMs?: number
  /** Floor on trials when no exact `samples` is given. */
  minSamples?: number
  warmup?: number
  /** Round-robin trials across commands instead of finishing each command
   * first, so drift hits every command equally. Default: true with 2+ commands. */
  interleave?: boolean
  cwd?: string
  env?: Record<string, string>
  cpu?: boolean
  heap?: boolean
  cpuIntervalUs?: number
  outDir?: string
  /** Measure the machine's noise floor first (default true, ~200ms) and stamp
   * it on the document as `environment`. */
  noiseCheck?: boolean
  /** SIGKILLs a trial (or prepare hook) still running after this many ms. No
   * default. A timed-out trial contributes no sample. */
  timeoutMs?: number
  /** Abort kills in-flight trials, schedules no more, and resolves (never
   * rejects) with the completed measurements plus an `aborted` warning on the
   * last one. */
  signal?: AbortSignal
  /** Exit codes to treat as success (hyperfine's `--ignore-failure`): the
   * trial still contributes its sample and gets no `nonzero-exit` warning. */
  ignoreExitCodes?: number[]
}

export function abortedWarning(): Warning {
  return {
    code: "aborted",
    message:
      "Run was cancelled before it finished; this document holds whatever measurements had already completed.",
  }
}

export async function time(opts: TimeOptions): Promise<ProfileDocument> {
  assertSamplingOptions("time", opts)

  const cfgFp = configFingerprint({
    samples: opts.samples ?? null,
    budgetMs: opts.budgetMs ?? null,
    minSamples: opts.minSamples ?? null,
    warmup: opts.warmup ?? null,
    cpu: opts.cpu ?? false,
    heap: opts.heap ?? false,
    cpuIntervalUs: opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
  })
  const artifactDir = `${opts.outDir ?? DEFAULT_OUT_DIR}/artifacts`
  const environment =
    opts.noiseCheck === false ? undefined : captureEnvironment()
  const noiseWarning = environment
    ? noisyMachineWarning(environment)
    : undefined

  const workloads: Workload[] = []
  const measurements: Measurement[] = []

  const entries = opts.commands.map((entry) => {
    const spec: CommandSpec =
      typeof entry === "string" || Array.isArray(entry)
        ? { command: entry }
        : entry
    const argv = Array.isArray(spec.command)
      ? spec.command
      : splitCommand(spec.command)
    const prepare = spec.prepare ?? opts.prepare
    const timeSource = spec.timeSource ?? opts.timeSource
    const workload = makeSubprocessWorkload(
      argv,
      spec.label ?? (Array.isArray(spec.command) ? undefined : spec.command),
      { prepare, timeSource },
    )
    return {
      argv,
      workload,
      prepare,
      timeSource,
      timeoutMs: spec.timeoutMs ?? opts.timeoutMs,
      ignoreExitCodes: spec.ignoreExitCodes ?? opts.ignoreExitCodes,
    }
  })

  const interleave = (opts.interleave ?? true) && entries.length > 1

  const phases = entries.map((entry) =>
    createTimingPhase({
      argv: entry.argv,
      cwd: opts.cwd,
      env: opts.env,
      samples: opts.samples,
      budgetMs: opts.budgetMs,
      minSamples: opts.minSamples,
      warmup: opts.warmup,
      prepare: entry.prepare,
      timeSource: entry.timeSource,
      timeoutMs: entry.timeoutMs,
      ignoreExitCodes: entry.ignoreExitCodes,
      signal: opts.signal,
    }),
  )

  const record = async (i: number) => {
    const { argv, workload, prepare } = entries[i]!
    workloads.push(workload)
    const phaseResult = phases[i]!.result()
    const timingMeasurement = makeTimingMeasurement({
      workload,
      configFingerprint: cfgFp,
      trials: phaseResult.trials,
      timing: phaseResult.timing,
      warnings:
        noiseWarning && measurements.length === 0
          ? [...phaseResult.warnings, noiseWarning]
          : phaseResult.warnings,
      interleaved: interleave ? true : undefined,
    })
    measurements.push(timingMeasurement)
    // An instrumented capture is one more spawned run, so don't start it once cancelled.
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
      )
    }
  }

  if (interleave) {
    for (const phase of phases) await phase.warmup()
    let stepped = true
    while (stepped) {
      stepped = false
      for (const phase of phases) {
        if (await phase.step()) stepped = true
      }
    }
    for (let i = 0; i < entries.length; i++) await record(i)
  } else {
    for (let i = 0; i < entries.length; i++) {
      await drainTimingPhase(phases[i]!)
      await record(i)
    }
  }

  if (opts.signal?.aborted && measurements.length > 0) {
    const last = measurements[measurements.length - 1]!
    last.warnings = [...last.warnings, abortedWarning()]
  }

  return createDocument(workloads, measurements, environment)
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
  workload: Workload
  argv: string[]
  timingMeasurementId: string
  cfgFp: string
  opts: TimeOptions
  artifactDir: string
  prepare?: PrepareHook
}): Promise<Measurement[]> {
  const extra: Measurement[] = []
  // A prepare hook (cold cache, fresh fixture) applies to an instrumented run like a timing trial.
  const prepareFor = async (phase: PrepareRun["phase"]) => {
    if (prepare)
      await runPrepare(
        prepare,
        { phase, index: 0 },
        { cwd: opts.cwd, env: opts.env },
      )
  }
  const captureOpts = (suffix: string) => ({
    argv,
    cwd: opts.cwd,
    env: opts.env,
    artifactDir,
    fileName: `${timingMeasurementId}-${suffix}`,
  })

  if (opts.cpu) {
    await prepareFor("cpu")
    const capture = await runCpuCapture({
      ...captureOpts("cpu.cpuprofile"),
      intervalUs: opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
    })
    extra.push(
      await instrumentedMeasurement({
        workload,
        phase: "cpu",
        configFingerprint: cfgFp,
        artifactKind: "cpuprofile",
        ...capture,
      }),
    )
  }

  if (opts.heap) {
    await prepareFor("heap")
    const capture = await runHeapCapture(captureOpts("heap.heapsnapshot"))
    extra.push(
      await instrumentedMeasurement({
        workload,
        phase: "heap",
        configFingerprint: cfgFp,
        artifactKind: "heapsnapshot",
        ...capture,
      }),
    )
  }

  return extra
}

async function instrumentedMeasurement({
  artifactPath,
  artifactKind,
  ...input
}: Omit<InstrumentedMeasurementInput, "artifacts"> & {
  artifactPath?: string
  artifactKind: ArtifactRef["kind"]
}): Promise<Measurement> {
  const measurement = makeInstrumentedMeasurement({ ...input, artifacts: [] })
  if (artifactPath) {
    measurement.artifacts = [
      await makeArtifactRef(measurement.id, artifactKind, artifactPath),
    ]
  }
  return measurement
}
