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
import { getRegisteredTasks, resetRegistry } from "./registry.ts"

async function main(): Promise<number> {
  const [suiteFile, outputPath, optsJson] = process.argv.slice(2)
  if (!suiteFile || !outputPath) {
    process.stderr.write(
      "bench runner: usage: runner.ts <suiteFile> <outputPath> [optsJson]\n",
    )
    return 2
  }

  const opts: InprocessTimingOptions = optsJson ? JSON.parse(optsJson) : {}

  resetRegistry()
  await import(suiteFile)
  const tasks = getRegisteredTasks()
  if (tasks.length === 0) {
    process.stderr.write(
      `bench runner: ${suiteFile} registered no tasks (no task() calls found).\n`,
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
    const taskId = t.groupName ? `${t.groupName}/${t.name}` : t.name
    const workload = makeEntryWorkload(suiteFile, taskId, taskId)
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
