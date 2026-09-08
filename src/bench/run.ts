import type { ProfileDocument } from "../ir/types.ts"
import { renderers } from "../renderers/index.ts"
import type { FormatName } from "../renderers/types.ts"
import { filterTasks, getRegisteredTasks } from "./registry.ts"
import { type MeasureTasksOpts, measureTasks } from "./run-tasks.ts"

export interface RunOptions extends MeasureTasksOpts {
  /** Regex, matched against "group/name" task ids - same semantics as
   * `ostia bench --filter` / `bench({ filter })`. */
  filter?: string
  /** Skip printing the report to stdout; still returns the document. */
  quiet?: boolean
  /** Renderer used for the printed report (default: `"table"`). */
  format?: FormatName
}

/** In-file entrypoint: call at the bottom of a suite file run directly with
 * `bun suite.ts` (no `ostia bench` CLI) to execute every `group()`/`task()`
 * registered so far, print a report, and return the document - so cleanup
 * can sit in a natural `try { await run() } finally { ... }` around it
 * instead of a `process.on("exit", ...)` workaround.
 *
 * This trades away the isolation `ostia bench`/`bench()` give each suite
 * file (and each isolated task) its own fresh subprocess: everything here
 * runs in the process that's already warmed up importing the suite, so
 * `TaskOptions.isolate` has nothing to isolate into and is ignored. Prefer
 * `ostia bench`/`bench()` for numbers you'll `compare`/`ci` against; reach
 * for `run()` for a single suite file's inline, no-CLI edit/run loop. */
export async function run(opts: RunOptions = {}): Promise<ProfileDocument> {
  const registered = getRegisteredTasks()
  if (registered.length === 0) {
    throw new Error(
      "run(): no tasks registered - call group()/task() before run() in the same file.",
    )
  }

  // A forgotten .only silently gates a whole suite down to a handful of
  // tasks, so it gets a stderr notice the same way ostia bench's runner does.
  const onlyTasks = registered.filter((t) => t.only)
  const candidates = onlyTasks.length > 0 ? onlyTasks : registered
  if (onlyTasks.length > 0) {
    process.stderr.write(
      `bench: ${onlyTasks.length} task(s) selected by .only\n`,
    )
  }

  const tasks = filterTasks(candidates, opts.filter)
  if (tasks.length === 0) {
    throw new Error(
      `run(): filter ${JSON.stringify(opts.filter)} matched zero of ${candidates.length} registered task(s).`,
    )
  }
  const suiteFile = Bun.main
  const doc = await measureTasks(suiteFile, tasks, opts)

  if (!opts.quiet) {
    const format = opts.format ?? "table"
    const { text } = await renderers[format].render(doc, {})
    if (text) process.stdout.write(text)
  }

  return doc
}
