import {
  configFingerprint,
  createDocument,
  makeEntryWorkload,
  makeInstrumentedMeasurement,
  makeTimingMeasurement,
} from "../ir/document.ts"
import type { Measurement, ProfileDocument, Workload } from "../ir/types.ts"
import { measureAllocPerOp } from "../measure/alloc.ts"
import {
  captureTaskCpuProfile,
  DEFAULT_TASK_CPU_INTERVAL_US,
} from "../measure/cpu.ts"
import {
  type InprocessTimingOptions,
  measureTask,
} from "../measure/inprocess.ts"
import {
  groupEdges,
  type RegisteredTask,
  runGroupHooks,
  taskAlloc,
  taskCpu,
  taskGc,
  taskId as taskIdOf,
} from "./registry.ts"
import { captureRunEnvironment } from "./support.ts"

export interface MeasureTasksOpts extends InprocessTimingOptions {
  /** Suite-wide default for capturing an extra `phase: "cpu"` measurement per
   * task (task/group `cpu` still wins). */
  cpu?: boolean
  /** `cpu`'s sampling interval, µs (default: 100). */
  cpuIntervalUs?: number
  /** Suite-wide default for capturing an extra `phase: "memstats"`
   * measurement per task (task/group `alloc` still wins). */
  alloc?: boolean
  /** Stamped onto every workload: it ran in a subprocess dedicated to it. */
  markIsolated?: boolean
  /** Measure this machine's noise floor before the first task (default:
   * true) and stamp it on the document as `environment`. */
  noiseCheck?: boolean
}

/** Shared by every runner so a task has the same id under `bench()` and `ab()`. */
export function taskWorkload(
  suiteFile: string,
  t: RegisteredTask,
  isolated?: boolean,
): Workload {
  const id = taskIdOf(t)
  return makeEntryWorkload(suiteFile, id, {
    label: id,
    baseline: t.baseline,
    group: t.groupName,
    description: t.opts?.description,
    groupDescription: t.groupDescription,
    isolated,
    params: t.params,
    skipped: t.skipped,
  })
}

/** Measures exactly `tasks` (already selected by the caller) in this
 * process; isolation is the caller's concern. */
export async function measureTasks(
  suiteFile: string,
  tasks: readonly RegisteredTask[],
  opts: MeasureTasksOpts,
): Promise<ProfileDocument> {
  const willMeasure = tasks.some((t) => !t.skipped)
  const { environment, noiseWarning } = captureRunEnvironment(
    willMeasure ? opts.noiseCheck : false,
  )
  const edges = groupEdges(tasks)

  const workloads: Workload[] = []
  const measurements: Measurement[] = []
  for (let idx = 0; idx < tasks.length; idx++) {
    const t = tasks[idx]!
    const workload = taskWorkload(suiteFile, t, opts.markIsolated)
    workloads.push(workload)

    if (t.skipped) continue

    const { enter, leave } = edges(idx)
    await runGroupHooks(t, "before", enter)
    if (t.opts?.before) await t.opts.before()

    // Per-task options win; the fingerprint is per task so two runs only
    // compare like-for-like when measured under the same effective settings.
    const taskOpts: InprocessTimingOptions = {
      budgetMs: t.opts?.budgetMs ?? opts.budgetMs,
      samples: t.opts?.samples ?? opts.samples,
      minSamples: t.opts?.minSamples ?? opts.minSamples,
      warmup: opts.warmup,
      gc: taskGc(t, opts.gc ?? false),
    }
    const result = await measureTask(t.fn, taskOpts)
    measurements.push(
      makeTimingMeasurement({
        workload,
        configFingerprint: configFingerprint({
          budgetMs: taskOpts.budgetMs ?? null,
          samples: taskOpts.samples ?? null,
          minSamples: taskOpts.minSamples ?? null,
          gc: taskOpts.gc ?? false,
        }),
        trials: result.trials,
        timing: result.timing,
        warnings:
          noiseWarning && measurements.length === 0
            ? [...result.warnings, noiseWarning]
            : result.warnings,
      }),
    )

    if (taskCpu(t, opts.cpu ?? false)) {
      const intervalUs = opts.cpuIntervalUs ?? DEFAULT_TASK_CPU_INTERVAL_US
      const cpuResult = await captureTaskCpuProfile(t.fn, { intervalUs })
      measurements.push(
        makeInstrumentedMeasurement({
          workload,
          phase: "cpu",
          configFingerprint: configFingerprint({ cpu: true, intervalUs }),
          diagnosticWallNs: cpuResult.diagnosticWallNs,
          cpu: cpuResult.cpu,
          jit: cpuResult.jit,
          warnings: cpuResult.warnings,
          artifacts: [],
        }),
      )
    }
    if (taskAlloc(t, opts.alloc ?? false)) {
      const allocResult = await measureAllocPerOp(t.fn)
      measurements.push(
        makeInstrumentedMeasurement({
          workload,
          phase: "memstats",
          configFingerprint: configFingerprint({ alloc: true }),
          diagnosticWallNs: allocResult.diagnosticWallNs,
          memory: allocResult.memory,
          warnings: [],
          artifacts: [],
        }),
      )
    }

    if (t.opts?.after) await t.opts.after()
    await runGroupHooks(t, "after", leave)
  }

  return createDocument(workloads, measurements, environment)
}
