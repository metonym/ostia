import {
  configFingerprint,
  makeEntryWorkload,
  makeInstrumentedMeasurement,
  makeTimingMeasurement,
  newDocument,
} from "../ir/document.ts"
import type { ProfileDocument } from "../ir/types.ts"
import { measureAllocPerOp } from "../measure/alloc.ts"
import { captureTaskCpuProfile, jitColdWarning } from "../measure/cpu.ts"
import {
  captureEnvironment,
  noisyMachineWarning,
} from "../measure/environment.ts"
import {
  type InprocessTimingOptions,
  measureTask,
} from "../measure/inprocess.ts"
import {
  type RegisteredTask,
  taskAlloc,
  taskCpu,
  taskGc,
  taskId as taskIdOf,
} from "./registry.ts"

export interface MeasureTasksOpts extends InprocessTimingOptions {
  /** Suite-wide default for capturing an extra `phase: "cpu"` measurement
   * per task (task/group `TaskOptions.cpu`/`GroupOptions.cpu` still win). */
  cpu?: boolean
  /** Suite-wide default for capturing an extra `phase: "memstats"`
   * measurement per task (task/group `TaskOptions.alloc`/`GroupOptions.alloc`
   * still win). */
  alloc?: boolean
  /** Stamped onto every workload this call produces, recording whether it
   * ran in a subprocess dedicated to it alone. */
  markIsolated?: boolean
  /** Measure this machine's noise floor before the first task (default:
   * true) and stamp it on the document as `environment`. Set false to skip
   * the ~200ms reference measurement. */
  noiseCheck?: boolean
}

/** Runs exactly `tasks` (already filtered/selected by the caller) in this
 * process and returns the resulting document - the measuring loop shared by
 * the CLI's per-suite-subprocess runner and the in-file `run()` entrypoint,
 * so isolation strategy (subprocess-per-suite, subprocess-per-task, or no
 * subprocess at all) stays a concern of the caller rather than this loop. */
export async function measureTasks(
  suiteFile: string,
  tasks: readonly RegisteredTask[],
  opts: MeasureTasksOpts,
): Promise<ProfileDocument> {
  const willMeasure = tasks.some((t) => !t.skipped)
  const environment =
    willMeasure && opts.noiseCheck !== false ? captureEnvironment() : undefined
  const noiseWarning = environment
    ? noisyMachineWarning(environment)
    : undefined

  // Group before/after wrap only the group's measured tasks (a task.skip()'d
  // task needs no setup/teardown); first/last are found by scanning once so
  // a group's tasks don't have to be contiguous in `tasks`.
  const groupFirstIndex = new Map<string, number>()
  const groupLastIndex = new Map<string, number>()
  tasks.forEach((t, i) => {
    if (t.groupName === undefined || t.skipped) return
    if (!groupFirstIndex.has(t.groupName)) groupFirstIndex.set(t.groupName, i)
    groupLastIndex.set(t.groupName, i)
  })

  const workloads = []
  const measurements = []
  for (let idx = 0; idx < tasks.length; idx++) {
    const t = tasks[idx]!
    const id = taskIdOf(t)
    const workload = makeEntryWorkload(suiteFile, id, {
      label: id,
      baseline: t.baseline,
      group: t.groupName,
      description: t.opts?.description,
      groupDescription: t.groupDescription,
      isolated: opts.markIsolated,
      params: t.params,
      skipped: t.skipped,
    })
    workloads.push(workload)

    if (t.skipped) continue

    const isGroupFirst =
      t.groupName !== undefined && groupFirstIndex.get(t.groupName) === idx
    const isGroupLast =
      t.groupName !== undefined && groupLastIndex.get(t.groupName) === idx
    if (isGroupFirst && t.groupBefore) await t.groupBefore()
    if (t.opts?.before) await t.opts.before()

    // Per-task options win over the suite-wide ones. The fingerprint is per task
    // for the same reason: two runs of one task only compare like-for-like when
    // they were measured under the same effective settings.
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

    // Extra instrumented measurements on the same workload, never mixed into
    // the timing numbers above.
    if (taskCpu(t, opts.cpu ?? false)) {
      const cpuResult = await captureTaskCpuProfile(t.fn)
      const jitWarning = jitColdWarning(cpuResult.jit)
      measurements.push(
        makeInstrumentedMeasurement({
          workload,
          phase: "cpu",
          configFingerprint: configFingerprint({ cpu: true }),
          diagnosticWallNs: cpuResult.diagnosticWallNs,
          cpu: cpuResult.cpu,
          jit: cpuResult.jit,
          warnings: jitWarning ? [jitWarning] : [],
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
    if (isGroupLast && t.groupAfter) await t.groupAfter()
  }

  return newDocument(workloads, measurements, environment)
}
