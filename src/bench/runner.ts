#!/usr/bin/env bun

import {
  configFingerprint,
  makeEntryWorkload,
  makeTimingRun,
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
  taskId as taskIdOf,
} from "./registry.ts"

async function main(): Promise<number> {
  const [suiteFile, outputPath, optsJson] = process.argv.slice(2)
  if (!suiteFile || !outputPath) {
    process.stderr.write(
      "bench runner: usage: runner.ts <suiteFile> <outputPath> [optsJson]\n",
    )
    return 2
  }

  const opts: InprocessTimingOptions & { filter?: string } = optsJson
    ? JSON.parse(optsJson)
    : {}

  resetRegistry()
  await import(suiteFile)
  const registered = getRegisteredTasks()
  if (registered.length === 0) {
    process.stderr.write(
      `bench runner: ${suiteFile} registered no tasks (no task() calls found).\n`,
    )
    return 2
  }

  const tasks = filterTasks(registered, opts.filter)
  if (tasks.length === 0) {
    process.stderr.write(
      `bench runner: --filter ${JSON.stringify(opts.filter)} matched zero of ${registered.length} registered tasks in ${suiteFile}.\n`,
    )
    return 2
  }

  const workloads = []
  const runs = []
  for (const t of tasks) {
    const id = taskIdOf(t)
    const workload = makeEntryWorkload(suiteFile, id, id, t.baseline)
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
    }
    const result = await measureTask(t.fn, taskOpts)
    runs.push(
      makeTimingRun({
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

  await saveDocument(newDocument(workloads, runs), outputPath)
  return 0
}

main().then((code) => process.exit(code))
