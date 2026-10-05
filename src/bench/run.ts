import type { ProfileDocument } from "../ir/types.ts"
import { renderers } from "../renderers/index.ts"
import type { FormatName } from "../renderers/types.ts"
import {
  getRegisteredTasks,
  type RegisteredTask,
  selectTasks,
} from "./registry.ts"
import { type MeasureTasksOpts, measureTasks } from "./run-tasks.ts"

export interface RunOptions extends MeasureTasksOpts {
  /** Regex matched against "group/name" task ids, as in `bench({ filter })`. */
  filter?: string
  /** Skip printing the report to stdout; still returns the document. */
  quiet?: boolean
  /** Renderer used for the printed report (default: `"table"`). */
  format?: FormatName
}

/** In-file entrypoint: call at the bottom of a suite file run directly with
 * `bun suite.ts` to measure every registered `group()`/`task()`, print a
 * report, and return the document.
 *
 * Everything runs in the current process, so `TaskOptions.isolate` is
 * ignored. Prefer `ostia bench`/`bench()` for numbers you'll `compare`/`ci`
 * against. */
export async function run(opts: RunOptions = {}): Promise<ProfileDocument> {
  const registered = getRegisteredTasks()
  if (registered.length === 0) {
    throw new Error(
      "run(): no tasks registered - call group()/task() before run() in the same file.",
    )
  }

  const suiteFile = Bun.main
  let tasks: RegisteredTask[]
  try {
    tasks = selectTasks(registered, opts.filter, suiteFile)
  } catch (err) {
    throw new Error(`run(): ${(err as Error).message}`)
  }
  const doc = await measureTasks(suiteFile, tasks, opts)

  if (!opts.quiet) {
    const format = opts.format ?? "table"
    const { text } = await renderers[format].render(doc, {})
    if (text) process.stdout.write(text)
  }

  return doc
}
