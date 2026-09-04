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

  const cfgFp = configFingerprint({
    timeBudgetMs: opts.timeBudgetMs ?? null,
    minSamples: opts.minSamples ?? null,
    gc: opts.gc ?? false,
  })

  const workloads = []
  const runs = []
  for (const t of tasks) {
    const id = taskIdOf(t)
    const workload = makeEntryWorkload(suiteFile, id, id, t.baseline)
    workloads.push(workload)
    const result = await measureTask(t.fn, opts)
    runs.push(
      makeTimingRun({
        workload,
        configFingerprint: cfgFp,
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
