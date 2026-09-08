#!/usr/bin/env bun

import { saveDocument } from "../ir/document.ts"
import type { InprocessTimingOptions } from "../measure/inprocess.ts"
import {
  filterTasks,
  getRegisteredTasks,
  resetRegistry,
  taskId as taskIdOf,
  taskIsolate,
} from "./registry.ts"
import { measureTasks } from "./run-tasks.ts"

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
  /** Suite-wide default for capturing an extra `phase: "memstats"`
   * measurement per task (task/group `TaskOptions.alloc`/`GroupOptions.alloc`
   * still win). */
  alloc?: boolean
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

  const doc = await measureTasks(suiteFile, toRun, opts)
  await saveDocument(doc, outputPath)
  return 0
}

main().then((code) => process.exit(code))
