#!/usr/bin/env bun

import { saveDocument } from "../ir/document.ts"
import type { InprocessTimingOptions } from "../measure/inprocess.ts"
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
  selectTasks,
  taskId as taskIdOf,
  taskIsolate,
  taskPeakMem,
} from "./registry.ts"
import { measureTasks, taskWorkload } from "./run-tasks.ts"

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
  /** Suite-wide default for capturing an extra `phase: "cpu"` measurement
   * per task (task/group `TaskOptions.cpu`/`GroupOptions.cpu` still win). */
  cpu?: boolean
  /** `cpu`'s sampling interval, µs (default: 100). */
  cpuIntervalUs?: number
  /** Suite-wide default for capturing an extra `phase: "memstats"`
   * measurement per task (task/group `TaskOptions.alloc`/`GroupOptions.alloc`
   * still win). */
  alloc?: boolean
  /** Suite-wide default for `--peak-mem` (task/group
   * `TaskOptions.peakMem`/`GroupOptions.peakMem` still win). Only consulted
   * to write each task's effective value into the plan: the measurement
   * itself runs in its own fresh processes (see `peakMemFor`). */
  peakMem?: boolean
  /** A peak-memory process: measure this one workload's first call with
   * `measurePeakMem` (after its group's and its own `before` hooks) and
   * write the `PeakMemResult` to the output path instead of a document.
   * Nothing else runs here, so no other task's peak can hide this one's. */
  peakMemFor?: string
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

  // What `measurePeakMem` compares the suite's own footprint against, taken
  // once ostia itself (which the suite imports) is loaded.
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
    tasks = selectTasks(registered, opts.filter, suiteFile)
  } catch (err) {
    process.stderr.write(`bench runner: ${(err as Error).message}\n`)
    return 2
  }
  if (opts.taskIds) {
    const wanted = new Set(opts.taskIds)
    tasks = tasks.filter((t) => wanted.has(taskIdOf(t)))
  }

  if (opts.peakMemFor) {
    const t = tasks.find(
      (t) => taskWorkload(suiteFile, t).id === opts.peakMemFor,
    )
    if (!t) {
      process.stderr.write(
        `bench runner: no task with workload id ${opts.peakMemFor} in ${suiteFile}.\n`,
      )
      return 2
    }
    await t.groupBefore?.()
    await t.opts?.before?.()
    const result = await measurePeakMem(t.fn, launched, sampler)
    await t.opts?.after?.()
    await t.groupAfter?.()
    await Bun.write(outputPath, JSON.stringify(result))
    return 0
  }

  if (opts.planPath) {
    const plan = tasks.map((t) => ({
      id: taskIdOf(t),
      workloadId: taskWorkload(suiteFile, t).id,
      isolate: taskIsolate(t, opts.isolate ?? false),
      peakMem: !t.skipped && taskPeakMem(t, opts.peakMem ?? false),
    }))
    await Bun.write(opts.planPath, JSON.stringify({ tasks: plan }))
  }

  // A `taskIds` call is a dedicated per-isolated-task subprocess: run exactly
  // what it was handed. A `planPath` call is the suite's whole-file pass: run
  // only the non-isolated tasks here: isolated ones get their own subprocess.
  const toRun = opts.taskIds
    ? tasks
    : tasks.filter((t) => !taskIsolate(t, opts.isolate ?? false))

  const doc = await measureTasks(suiteFile, toRun, opts)
  await saveDocument(doc, outputPath)
  return 0
}

main().then((code) => process.exit(code))
