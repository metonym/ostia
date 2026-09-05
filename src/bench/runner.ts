#!/usr/bin/env bun

import {
  configFingerprint,
  makeEntryWorkload,
  makeTimingMeasurement,
  newDocument,
  saveDocument,
} from "../ir/document.ts"
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

  let tasks = filterTasks(registered, opts.filter)
  if (opts.taskIds) {
    const wanted = new Set(opts.taskIds)
    tasks = tasks.filter((t) => wanted.has(taskIdOf(t)))
  }
  if (tasks.length === 0) {
    process.stderr.write(
      `bench runner: --filter ${JSON.stringify(opts.filter)} matched zero of ${registered.length} registered tasks in ${suiteFile}.\n`,
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

  const workloads = []
  const measurements = []
  for (const t of toRun) {
    const id = taskIdOf(t)
    const workload = makeEntryWorkload(suiteFile, id, {
      label: id,
      baseline: t.baseline,
      group: t.groupName,
      description: t.opts?.description,
      groupDescription: t.groupDescription,
      isolated: opts.markIsolated,
    })
    workloads.push(workload)
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
        warnings: result.warnings,
      }),
    )
  }

  await saveDocument(newDocument(workloads, measurements), outputPath)
  return 0
}

main().then((code) => process.exit(code))
