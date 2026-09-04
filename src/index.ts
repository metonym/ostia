import { runCpuCapture } from "./capture/cpu/index.ts"
import { runHeapCapture } from "./capture/heap/index.ts"
import { captureInspectorProfile } from "./capture/inspector/index.ts"
import { captureJscProfile } from "./capture/jsc/index.ts"
import {
  configFingerprint,
  makeArtifactRef,
  makeInprocessWorkload,
  makeInstrumentedRun,
  makeSubprocessWorkload,
  makeTimingRun,
  newDocument,
} from "./ir/document.ts"
import type {
  ArtifactRef,
  ProfileDocument,
  Run,
  Warning,
  Workload,
} from "./ir/types.ts"
import { runTimingPhase } from "./measure/timing.ts"
import { splitCommand } from "./spawn/index.ts"

export { bench } from "./bench/index.ts"
export { range } from "./bench/range.ts"
export type { GroupOptions, TaskOptions } from "./bench/registry.ts"
export { group, task } from "./bench/registry.ts"
export { compareDocuments } from "./compare/index.ts"
export { loadDocument, saveDocument } from "./ir/document.ts"
export type {
  ProfileDocument,
  Warning,
  WarningCode,
  Workload,
} from "./ir/types.ts"
export { renderers } from "./renderers/index.ts"
export type { MinimalLine } from "./renderers/minimal/index.ts"

interface RunOptions {
  commands: (string | string[])[]
  runs?: number
  warmup?: number
  cwd?: string
  env?: Record<string, string>
  cpu?: boolean
  heap?: boolean
  cpuIntervalUs?: number
  outDir?: string
}

const DEFAULT_OUT_DIR = "node_modules/.cache/ostia"
const DEFAULT_CPU_INTERVAL_US = 1000

export async function run(opts: RunOptions): Promise<ProfileDocument> {
  const cfgFp = configFingerprint({
    runs: opts.runs ?? null,
    warmup: opts.warmup ?? null,
    cpu: opts.cpu ?? false,
    heap: opts.heap ?? false,
    cpuIntervalUs: opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
  })
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  const artifactDir = `${outDir}/artifacts`

  const workloads: Workload[] = []
  const runs: Run[] = []

  for (const command of opts.commands) {
    const argv = Array.isArray(command) ? command : splitCommand(command)
    const workload = makeSubprocessWorkload(
      argv,
      Array.isArray(command) ? undefined : command,
    )
    workloads.push(workload)

    const phaseResult = await runTimingPhase({
      argv,
      cwd: opts.cwd,
      env: opts.env,
      runs: opts.runs,
      warmup: opts.warmup,
    })

    const timingRun = makeTimingRun({
      workload,
      configFingerprint: cfgFp,
      trials: phaseResult.trials,
      timing: phaseResult.timing,
      warnings: phaseResult.warnings,
    })
    runs.push(timingRun)

    if (opts.cpu) {
      const fileName = `${timingRun.id}-cpu.cpuprofile`
      const capture = await runCpuCapture({
        argv,
        cwd: opts.cwd,
        env: opts.env,
        artifactDir,
        fileName,
        intervalUs: opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
      })
      runs.push(
        await instrumentedRunFromCapture({
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
      const fileName = `${timingRun.id}-heap.heapsnapshot`
      const capture = await runHeapCapture({
        argv,
        cwd: opts.cwd,
        env: opts.env,
        artifactDir,
        fileName,
      })
      runs.push(
        await instrumentedRunFromCapture({
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
  }

  return newDocument(workloads, runs)
}

async function instrumentedRunFromCapture(input: {
  workload: Workload
  phase: "cpu" | "heap"
  configFingerprint: string
  diagnosticWallNs: number
  exitCode?: number
  cpu?: Parameters<typeof makeInstrumentedRun>[0]["cpu"]
  heap?: Parameters<typeof makeInstrumentedRun>[0]["heap"]
  artifactPath?: string
  artifactKind: ArtifactRef["kind"]
  warnings: Warning[]
}): Promise<Run> {
  const runIdSeed = `${input.workload.id}-${input.phase}-${input.configFingerprint}`
  const artifacts: ArtifactRef[] = input.artifactPath
    ? [await makeArtifactRef(runIdSeed, input.artifactKind, input.artifactPath)]
    : []

  return makeInstrumentedRun({
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
  run: Run
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
    const run = makeInstrumentedRun({
      workload,
      phase: "cpu",
      configFingerprint: cfgFp,
      diagnosticWallNs,
      cpu,
      jit,
      warnings: emptyProfileWarning(cpu),
      artifacts: [],
    })
    return { result, run }
  }

  const { result, cpu, diagnosticWallNs } = await captureInspectorProfile(
    fn,
    opts,
  )
  const run = makeInstrumentedRun({
    workload,
    phase: "cpu",
    configFingerprint: cfgFp,
    diagnosticWallNs,
    cpu,
    warnings: emptyProfileWarning(cpu),
    artifacts: [],
  })
  return { result, run }
}
