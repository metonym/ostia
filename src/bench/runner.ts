#!/usr/bin/env bun

import {
  configFingerprint,
  makeEntryWorkload,
  makeTimingMeasurement,
  newDocument,
  saveDocument,
} from "../ir/document.ts"
import {
  captureEnvironment,
  noisyMachineWarning,
} from "../measure/environment.ts"
import {
  type InprocessTimingOptions,
  measureTask,
} from "../measure/inprocess.ts"
import {
  filterTasks,
  getRegisteredTasks,
  resetRegistry,
  taskGc,
  taskId as taskIdOf,
  taskIsolate,
} from "./registry.ts"

export interface RunnerOpts extends InprocessTimingOptions {
  /** Regex, matched against "group/name" task ids (see `filterTasks`). */
  filter?: string
  /** Exact task-id allowlist, applied after `filter`. Used to hand a single
   * suite-wide `bench()` call's already-resolved isolation plan to a
   * per-work-item runner spawn instead of re-deriving it from `filter`. */
  taskIds?: string[]
  /** Suite-wide isolate default, consulted to compute each task's effective
   * isolate (task/group overrides still win). */
  isolate?: boolean
  /** Stamped onto every workload this invocation produces, recording whether
   * it ran in a subprocess dedicated to it alone. */
  markIsolated?: boolean
  /** When set (and `taskIds` is not), this is the suite's one whole-file
   * pass: after importing the suite, write every filtered task's id and
   * effective isolate to this path, then run only the non-isolated ones
   * in this same process. Isolated tasks are left for a later dedicated
   * subprocess (see `taskIds`), so this pass never imports the suite twice
   * to learn what's isolated before running anything. */
  planPath?: string
  /** Scripts imported, in order, before the suite file - in this same
   * subprocess, so a global they install (jsdom's `document`/`window`, a
   * `Bun.plugin()` file-loader) is visible to a later preload script and to
   * the suite file itself. */
  preload?: string[]
  /** Measure this machine's noise floor before the first task (default:
   * true) and stamp it on the document as `environment`. Set false to skip
   * the ~200ms reference measurement. */
  noiseCheck?: boolean
}

async function main(): Promise<number> {
  const [suiteFile, outputPath, optsJson] = process.argv.slice(2)
  if (!suiteFile || !outputPath) {
    process.stderr.write(
      "bench runner: usage: runner.ts <suiteFile> <outputPath> [optsJson]\n",
    )
    return 2
  }

  const opts: RunnerOpts = optsJson ? JSON.parse(optsJson) : {}

  for (const preloadFile of opts.preload ?? []) {
    await import(preloadFile)
  }

  resetRegistry()
  await import(suiteFile)
  const registered = getRegisteredTasks()
  if (registered.length === 0) {
    process.stderr.write(
      `bench runner: ${suiteFile} registered no tasks (no task() calls found).\n`,
    )
    return 2
  }

  // A forgotten .only silently gates a whole suite down to a handful of
  // tasks, so it gets a stderr notice the same way `--filter` reducing to
  // zero gets a hard error: both are easy to miss otherwise.
  const onlyTasks = registered.filter((t) => t.only)
  const candidates = onlyTasks.length > 0 ? onlyTasks : registered
  if (onlyTasks.length > 0) {
    process.stderr.write(
      `bench: ${onlyTasks.length} task(s) selected by .only\n`,
    )
  }

  let tasks = filterTasks(candidates, opts.filter)
  if (opts.taskIds) {
    const wanted = new Set(opts.taskIds)
    tasks = tasks.filter((t) => wanted.has(taskIdOf(t)))
  }
  if (tasks.length === 0) {
    process.stderr.write(
      `bench runner: --filter ${JSON.stringify(opts.filter)} matched zero of ${candidates.length} registered task(s) in ${suiteFile}.\n`,
    )
    return 2
  }

  if (opts.planPath) {
    const plan = tasks.map((t) => ({
      id: taskIdOf(t),
      isolate: taskIsolate(t, opts.isolate ?? false),
    }))
    await Bun.write(opts.planPath, JSON.stringify({ tasks: plan }))
  }

  // A `taskIds` call is a dedicated per-isolated-task subprocess: run exactly
  // what it was handed. A `planPath` call is the suite's whole-file pass: run
  // only the non-isolated tasks here: isolated ones get their own subprocess.
  const toRun = opts.taskIds
    ? tasks
    : tasks.filter((t) => !taskIsolate(t, opts.isolate ?? false))

  const willMeasure = toRun.some((t) => !t.skipped)
  const environment =
    willMeasure && opts.noiseCheck !== false ? captureEnvironment() : undefined
  const noiseWarning = environment
    ? noisyMachineWarning(environment)
    : undefined

  // Group before/after wrap only the group's measured tasks (a task.skip()'d
  // task needs no setup/teardown); first/last are found by scanning once so
  // a group's tasks don't have to be contiguous in `toRun`.
  const groupFirstIndex = new Map<string, number>()
  const groupLastIndex = new Map<string, number>()
  toRun.forEach((t, i) => {
    if (t.groupName === undefined || t.skipped) return
    if (!groupFirstIndex.has(t.groupName)) groupFirstIndex.set(t.groupName, i)
    groupLastIndex.set(t.groupName, i)
  })

  const workloads = []
  const measurements = []
  for (let idx = 0; idx < toRun.length; idx++) {
    const t = toRun[idx]!
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
      ...opts,
      ...(t.opts?.timeBudgetMs !== undefined && {
        timeBudgetMs: t.opts.timeBudgetMs,
      }),
      ...(t.opts?.minSamples !== undefined && {
        minSamples: t.opts.minSamples,
      }),
      gc: taskGc(t, opts.gc ?? false),
    }
    const result = await measureTask(t.fn, taskOpts)
    measurements.push(
      makeTimingMeasurement({
        workload,
        configFingerprint: configFingerprint({
          timeBudgetMs: taskOpts.timeBudgetMs ?? null,
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

    if (t.opts?.after) await t.opts.after()
    if (isGroupLast && t.groupAfter) await t.groupAfter()
  }

  await saveDocument(
    newDocument(workloads, measurements, environment),
    outputPath,
  )
  return 0
}

main().then((code) => process.exit(code))
