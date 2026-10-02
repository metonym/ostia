#!/usr/bin/env bun

import { saveDocument } from "../ir/document.ts"
import {
  type MemorySnapshot,
  measurePeakMem,
  memorySnapshot,
  type RssSampler,
  startRssSampler,
} from "../measure/peak.ts"
import {
  getRegisteredTasks,
  type RegisteredTask,
  resetRegistry,
  runGroupHooks,
  selectTasks,
  taskIsolate,
  taskPeakMem,
} from "./registry.ts"
import {
  type MeasureTasksOpts,
  measureTasks,
  taskWorkload,
} from "./run-tasks.ts"

export interface RunnerOpts extends MeasureTasksOpts {
  /** Regex matched against "group/name" task ids. */
  filter?: string
  /** Run exactly these workloads (after `filter`): a dedicated process for an
   * isolated task the whole-file pass already planned. */
  workloadIds?: string[]
  /** Suite-wide isolate default (task/group `isolate` still wins). */
  isolate?: boolean
  /** Suite-wide `peakMem` default (task/group `peakMem` still wins); only
   * written into the plan, since the measurement runs in fresh processes
   * (see `peakMemFor`). */
  peakMem?: boolean
  /** A peak-memory process: measure this one workload's first call (after its
   * group's and its own `before` hooks) and write the `PeakMemResult` to the
   * output path instead of a document. Nothing else runs, so no other task's
   * peak can hide this one's. */
  peakMemFor?: string
  /** The suite's whole-file pass (without `workloadIds`): write every filtered
   * task's id and effective isolate to this path, then run only the
   * non-isolated ones in this process. Isolated tasks are left to dedicated
   * subprocesses, so the suite is never imported twice to learn the plan. */
  planPath?: string
  /** Scripts imported, in order, before the suite file, in this same process
   * (so globals or `Bun.plugin()` loaders they install reach the suite). */
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

  // Baseline for `measurePeakMem`, taken once ostia (which the suite imports)
  // is loaded.
  let launched: MemorySnapshot | undefined
  let sampler: RssSampler | undefined
  if (opts.peakMemFor) {
    sampler = await startRssSampler()
    await import("../index.ts")
    launched = memorySnapshot()
  }

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

  let tasks: RegisteredTask[]
  try {
    tasks = selectTasks(
      registered,
      opts.filter,
      suiteFile,
      !opts.workloadIds && !opts.peakMemFor,
    )
  } catch (err) {
    process.stderr.write(`bench runner: ${(err as Error).message}\n`)
    return 2
  }
  const workloadIdOf = (t: RegisteredTask) => taskWorkload(suiteFile, t).id
  if (opts.workloadIds) {
    const wanted = new Set(opts.workloadIds)
    tasks = tasks.filter((t) => wanted.has(workloadIdOf(t)))
  }

  if (opts.peakMemFor) {
    const t = tasks.find((t) => workloadIdOf(t) === opts.peakMemFor)
    if (!t) {
      process.stderr.write(
        `bench runner: no task with workload id ${opts.peakMemFor} in ${suiteFile}.\n`,
      )
      return 2
    }
    await runGroupHooks(t, "before")
    await t.opts?.before?.()
    const result = await measurePeakMem(t.fn, launched, sampler)
    await t.opts?.after?.()
    await runGroupHooks(t, "after")
    await Bun.write(outputPath, JSON.stringify(result))
    return 0
  }

  if (opts.planPath) {
    const plan = tasks.map((t) => ({
      workloadId: workloadIdOf(t),
      isolate: taskIsolate(t, opts.isolate ?? false),
      peakMem: !t.skipped && taskPeakMem(t, opts.peakMem ?? false),
    }))
    await Bun.write(opts.planPath, JSON.stringify({ tasks: plan }))
  }

  const toRun = opts.workloadIds
    ? tasks
    : tasks.filter((t) => !taskIsolate(t, opts.isolate ?? false))

  const doc = await measureTasks(suiteFile, toRun, opts)
  await saveDocument(doc, outputPath)
  return 0
}

main().then((code) => process.exit(code))
