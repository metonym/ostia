import { runCpuCapture } from "./capture/cpu/index.ts"
import { runHeapCapture } from "./capture/heap/index.ts"
import { captureInspectorProfile } from "./capture/inspector/index.ts"
import { captureJscProfile } from "./capture/jsc/index.ts"
import type { OstiaConfig } from "./config/index.ts"
import {
  configFingerprint,
  makeArtifactRef,
  makeInprocessWorkload,
  makeInstrumentedMeasurement,
  makeSubprocessWorkload,
  makeTimingMeasurement,
  newDocument,
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
import { keep } from "./measure/inprocess.ts"
import { createTimingPhase, runTimingPhase } from "./measure/timing.ts"
import {
  type PrepareHook,
  type PrepareRun,
  runPrepare,
  splitCommand,
  type TimeSource,
} from "./spawn/index.ts"

export { bench } from "./bench/index.ts"
export { range } from "./bench/range.ts"
export type { GroupOptions, TaskOptions } from "./bench/registry.ts"
export { group, task } from "./bench/registry.ts"
export { sweep } from "./bench/sweep.ts"
export { compareDocuments } from "./compare/index.ts"
export type { OstiaConfig, WorkloadConfig } from "./config/index.ts"
export {
  loadDocument,
  newDocument as createDocument,
  saveDocument,
} from "./ir/document.ts"
export type {
  ProfileDocument,
  Warning,
  WarningCode,
  Workload,
} from "./ir/types.ts"
export { renderers } from "./renderers/index.ts"
export type { MinimalLine } from "./renderers/minimal/index.ts"
export type {
  PrepareFn,
  PrepareHook,
  PrepareRun,
  TimeSource,
  TimeUnit,
} from "./spawn/index.ts"
export { keep }

/** Identity function purely for typing: lets `ostia.config.ts` write
 * `export default defineConfig({ ... })` with autocomplete/type-checking on
 * `OstiaConfig`'s fields, the same way Vite/Vitest/ESLint's `defineConfig`
 * helpers work. `loadConfig` never calls this - it just imports the file's
 * default export, whatever produced it. */
export function defineConfig(
  config: Partial<OstiaConfig>,
): Partial<OstiaConfig> {
  return config
}

/** One command for `time()`: a string (whitespace-split, no shell), an argv
 * array, or an object carrying per-command settings. The object form is how
 * two workloads with the same command but a different `prepare` (warm vs
 * cold build) or a different `timeSource` (wall clock vs self-reported) get
 * distinct labels in the same document. */
export interface CommandSpec {
  command: string | string[]
  label?: string
  /** Overrides `TimeOptions.prepare` for this command. */
  prepare?: PrepareHook
  /** Overrides `TimeOptions.timeSource` for this command. */
  timeSource?: TimeSource
}

export interface TimeOptions {
  commands: (string | string[] | CommandSpec)[]
  /** Runs before every trial of every command (warmup and instrumented
   * trials included), unmeasured, in `cwd`/`env`: a command string / argv
   * array spawned and awaited, or a function. hyperfine's `--prepare`. A
   * `CommandSpec.prepare` overrides it per command. */
  prepare?: PrepareHook
  /** Take every command's timing from a number in its own output instead of
   * its wall clock (e.g. a build tool's `built in 342ms` line, which
   * excludes runtime startup). A `CommandSpec.timeSource` overrides it per
   * command. The parsed value becomes `timing.samples`; each trial keeps
   * `wallNs` too. */
  timeSource?: TimeSource
  /** Exact trial count. When set, `budgetMs` is ignored. */
  samples?: number
  /** Wall-clock time budget for the sampling loop, ms (default: a
   * hyperfine-style ~3s min-total-time loop when neither `samples` nor
   * `budgetMs` is given). */
  budgetMs?: number
  /** Hard floor on trials when no exact `samples` count is given. */
  minSamples?: number
  warmup?: number
  /** Round-robin trials across commands (one trial per command, repeated)
   * instead of running each command's whole trial loop to completion before
   * the next command starts. Default: true when 2+ commands are given (a
   * single command has nothing to interleave against). Spreads any drift
   * over the run's wall-clock span (thermal throttling, a noisy neighbor
   * process) evenly across every command instead of favoring whichever ran
   * first or last. */
  interleave?: boolean
  cwd?: string
  env?: Record<string, string>
  cpu?: boolean
  heap?: boolean
  cpuIntervalUs?: number
  outDir?: string
  /** Measure this machine's noise floor before the first command (default:
   * true) and stamp it on the document as `environment`. Set false to skip
   * the ~200ms reference measurement. */
  noiseCheck?: boolean
}

const DEFAULT_OUT_DIR = "node_modules/.cache/ostia"
const DEFAULT_CPU_INTERVAL_US = 1000

export async function time(opts: TimeOptions): Promise<ProfileDocument> {
  const cfgFp = configFingerprint({
    samples: opts.samples ?? null,
    budgetMs: opts.budgetMs ?? null,
    minSamples: opts.minSamples ?? null,
    warmup: opts.warmup ?? null,
    cpu: opts.cpu ?? false,
    heap: opts.heap ?? false,
    cpuIntervalUs: opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
  })
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  const artifactDir = `${outDir}/artifacts`
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
    return { argv, workload, prepare, timeSource }
  })

  const interleave = (opts.interleave ?? true) && entries.length > 1

  const timingPhaseOpts = (entry: (typeof entries)[number]) => ({
    argv: entry.argv,
    cwd: opts.cwd,
    env: opts.env,
    samples: opts.samples,
    budgetMs: opts.budgetMs,
    minSamples: opts.minSamples,
    warmup: opts.warmup,
    prepare: entry.prepare,
    timeSource: entry.timeSource,
  })

  if (interleave) {
    const phases = entries.map((entry) =>
      createTimingPhase(timingPhaseOpts(entry)),
    )
    for (const phase of phases) await phase.warmup()

    let stepped = true
    while (stepped) {
      stepped = false
      for (const phase of phases) {
        if (await phase.step()) stepped = true
      }
    }

    for (let i = 0; i < entries.length; i++) {
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
        interleaved: true,
      })
      measurements.push(timingMeasurement)
      measurements.push(
        ...(await captureInstrumentedPhases(
          workload,
          argv,
          timingMeasurement.id,
          cfgFp,
          opts,
          artifactDir,
          prepare,
        )),
      )
    }

    return newDocument(workloads, measurements, environment)
  }

  for (const entry of entries) {
    const { argv, workload, prepare } = entry
    workloads.push(workload)

    const phaseResult = await runTimingPhase(timingPhaseOpts(entry))

    const timingMeasurement = makeTimingMeasurement({
      workload,
      configFingerprint: cfgFp,
      trials: phaseResult.trials,
      timing: phaseResult.timing,
      warnings:
        noiseWarning && measurements.length === 0
          ? [...phaseResult.warnings, noiseWarning]
          : phaseResult.warnings,
    })
    measurements.push(timingMeasurement)
    measurements.push(
      ...(await captureInstrumentedPhases(
        workload,
        argv,
        timingMeasurement.id,
        cfgFp,
        opts,
        artifactDir,
        prepare,
      )),
    )
  }

  return newDocument(workloads, measurements, environment)
}

async function captureInstrumentedPhases(
  workload: Workload,
  argv: string[],
  timingMeasurementId: string,
  cfgFp: string,
  opts: TimeOptions,
  artifactDir: string,
  prepare?: PrepareHook,
): Promise<Measurement[]> {
  const extra: Measurement[] = []
  // An instrumented trial is one more run of the command, so a prepare hook
  // (cold cache, fresh fixture) applies to it the same as to a timing trial.
  const prepareFor = async (phase: PrepareRun["phase"]) => {
    if (prepare)
      await runPrepare(
        prepare,
        { phase, index: 0 },
        { cwd: opts.cwd, env: opts.env },
      )
  }

  if (opts.cpu) {
    await prepareFor("cpu")
    const fileName = `${timingMeasurementId}-cpu.cpuprofile`
    const capture = await runCpuCapture({
      argv,
      cwd: opts.cwd,
      env: opts.env,
      artifactDir,
      fileName,
      intervalUs: opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
    })
    extra.push(
      await instrumentedMeasurementFromCapture({
        workload,
        phase: "cpu",
        configFingerprint: cfgFp,
        diagnosticWallNs: capture.diagnosticWallNs,
        exitCode: capture.exitCode,
        cpu: capture.cpu,
        artifactPath: capture.artifactPath,
        artifactKind: "cpuprofile",
        warnings: capture.warnings,
      }),
    )
  }

  if (opts.heap) {
    await prepareFor("heap")
    const fileName = `${timingMeasurementId}-heap.heapsnapshot`
    const capture = await runHeapCapture({
      argv,
      cwd: opts.cwd,
      env: opts.env,
      artifactDir,
      fileName,
    })
    extra.push(
      await instrumentedMeasurementFromCapture({
        workload,
        phase: "heap",
        configFingerprint: cfgFp,
        diagnosticWallNs: capture.diagnosticWallNs,
        exitCode: capture.exitCode,
        heap: capture.heap,
        artifactPath: capture.artifactPath,
        artifactKind: "heapsnapshot",
        warnings: capture.warnings,
      }),
    )
  }

  return extra
}

async function instrumentedMeasurementFromCapture(input: {
  workload: Workload
  phase: "cpu" | "heap"
  configFingerprint: string
  diagnosticWallNs: number
  exitCode?: number
  cpu?: Parameters<typeof makeInstrumentedMeasurement>[0]["cpu"]
  heap?: Parameters<typeof makeInstrumentedMeasurement>[0]["heap"]
  artifactPath?: string
  artifactKind: ArtifactRef["kind"]
  warnings: Warning[]
}): Promise<Measurement> {
  const measurementIdSeed = `${input.workload.id}-${input.phase}-${input.configFingerprint}`
  const artifacts: ArtifactRef[] = input.artifactPath
    ? [
        await makeArtifactRef(
          measurementIdSeed,
          input.artifactKind,
          input.artifactPath,
        ),
      ]
    : []

  return makeInstrumentedMeasurement({
    workload: input.workload,
    phase: input.phase,
    configFingerprint: input.configFingerprint,
    diagnosticWallNs: input.diagnosticWallNs,
    exitCode: input.exitCode,
    cpu: input.cpu,
    heap: input.heap,
    warnings: input.warnings,
    artifacts,
  })
}

interface ProfileOptions {
  intervalUs?: number
  // "inspector" (default) uses windowed CDP capture via node:inspector and writes a portable .cpuprofile.
  // "jsc" uses bun:jsc.profile and adds LLInt/Baseline/DFG/FTL tier data.
  origin?: "inspector" | "jsc"
}

interface ProfileResult<T> {
  result: T
  measurement: Measurement
  document: ProfileDocument
}

export async function profile<T>(
  fn: () => T | Promise<T>,
  opts: ProfileOptions = {},
): Promise<ProfileResult<T>> {
  const workload = makeInprocessWorkload(fn)
  const cfgFp = configFingerprint({
    intervalUs: opts.intervalUs ?? DEFAULT_CPU_INTERVAL_US,
    origin: opts.origin ?? "inspector",
  })
  const emptyProfileWarning = (cpu: { samples?: { nodeIds: number[] } }) =>
    cpu.samples?.nodeIds.length === 0
      ? [
          {
            code: "empty-profile" as const,
            message: "In-process capture produced zero samples.",
          },
        ]
      : []

  if (opts.origin === "jsc") {
    const { result, cpu, jit, diagnosticWallNs } = await captureJscProfile(
      fn,
      opts,
    )
    const measurement = makeInstrumentedMeasurement({
      workload,
      phase: "cpu",
      configFingerprint: cfgFp,
      diagnosticWallNs,
      cpu,
      jit,
      warnings: emptyProfileWarning(cpu),
      artifacts: [],
    })
    return {
      result,
      measurement,
      document: newDocument([workload], [measurement]),
    }
  }

  const { result, cpu, diagnosticWallNs } = await captureInspectorProfile(
    fn,
    opts,
  )
  const measurement = makeInstrumentedMeasurement({
    workload,
    phase: "cpu",
    configFingerprint: cfgFp,
    diagnosticWallNs,
    cpu,
    warnings: emptyProfileWarning(cpu),
    artifacts: [],
  })
  return {
    result,
    measurement,
    document: newDocument([workload], [measurement]),
  }
}
