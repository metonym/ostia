export interface TaskOptions {
  /** Marks this task as the Relative reference for its group in the table
   * renderer, mirroring mitata's `baseline()`. At most one per group. */
  baseline?: boolean
  /** Per-task time budget; overrides the suite-wide `--time-budget` / `timeBudgetMs`. */
  timeBudgetMs?: number
  /** Per-task hard floor on trials; overrides the suite-wide `--min-samples` /
   * `minSamples`. */
  minSamples?: number
  /** What this task measures and why. Flows into `Workload.description` so the
   * intent travels with the numbers instead of living only in a source comment. */
  description?: string
  /** Give this task its own subprocess instead of sharing its suite file's,
   * isolating its JIT tier state and heap shape from every other task in the
   * run. Overrides the group's and the suite-wide `bench({ isolate })` /
   * `--isolate` default for this task only. */
  isolate?: boolean
  /** Overrides the suite-wide `bench({ gc })` / `--gc` (and any
   * `GroupOptions.gc`) for this task only. */
  gc?: boolean
  /** Structured parameters this task represents (e.g. `{ size: 800, impl:
   * "fast" }`), written to `Workload.params` and folded into the workload id
   * so points with the same task name don't collide. Inside `sweep()`, the
   * current point is inherited automatically; an explicit `params` here
   * merges over it (explicit keys win). */
  params?: Record<string, string | number | boolean>
}

export interface GroupOptions {
  /** What this group measures and why. Flows into `Workload.groupDescription`
   * on every task in the group. */
  description?: string
  /** Default `isolate` for every task in this group, unless a task overrides
   * it with its own `TaskOptions.isolate`. */
  isolate?: boolean
  /** Default `gc` for every task in this group, unless a task overrides it
   * with its own `TaskOptions.gc`. */
  gc?: boolean
}

export interface RegisteredTask {
  groupName?: string
  groupDescription?: string
  groupIsolate?: boolean
  groupGc?: boolean
  name: string
  fn: () => unknown | Promise<unknown>
  baseline?: boolean
  params?: Record<string, string | number | boolean>
  opts?: TaskOptions
}

const tasks: RegisteredTask[] = []
let currentGroup:
  | { name: string; description?: string; isolate?: boolean; gc?: boolean }
  | undefined
let currentParams: Record<string, string | number | boolean> | undefined

export function group(name: string, fn: () => void, opts?: GroupOptions): void {
  const previous = currentGroup
  currentGroup = {
    name,
    description: opts?.description,
    isolate: opts?.isolate,
    gc: opts?.gc,
  }
  try {
    fn()
  } finally {
    currentGroup = previous
  }
}

export function task(
  name: string,
  fn: () => unknown | Promise<unknown>,
  opts?: TaskOptions,
): void {
  const params =
    currentParams !== undefined || opts?.params !== undefined
      ? { ...currentParams, ...opts?.params }
      : undefined
  tasks.push({
    groupName: currentGroup?.name,
    groupDescription: currentGroup?.description,
    groupIsolate: currentGroup?.isolate,
    groupGc: currentGroup?.gc,
    name,
    fn,
    baseline: opts?.baseline,
    params,
    opts,
  })
}

export function getRegisteredTasks(): readonly RegisteredTask[] {
  return tasks
}

export function resetRegistry(): void {
  tasks.length = 0
  currentGroup = undefined
  currentParams = undefined
}

/** Runs `fn` with `params` as the current sweep point, so `task()` calls
 * inside it automatically inherit those as their params (an explicit
 * `TaskOptions.params` still merges over it, explicit keys win). Used by
 * `sweep()`, kept here so it shares the registry's internal state stack
 * instead of duplicating it. */
export function withCurrentParams<T>(
  params: Record<string, string | number | boolean>,
  fn: () => T,
): T {
  const previous = currentParams
  currentParams = params
  try {
    return fn()
  } finally {
    currentParams = previous
  }
}

export function taskId(t: RegisteredTask): string {
  return t.groupName ? `${t.groupName}/${t.name}` : t.name
}

/** A task's own `isolate` wins, then its group's, then the suite-wide
 * default passed to `bench()`. */
export function taskIsolate(t: RegisteredTask, suiteIsolate: boolean): boolean {
  return t.opts?.isolate ?? t.groupIsolate ?? suiteIsolate
}

/** A task's own `gc` wins, then its group's, then the suite-wide default
 * passed to `bench()`. */
export function taskGc(t: RegisteredTask, suiteGc: boolean): boolean {
  return t.opts?.gc ?? t.groupGc ?? suiteGc
}

/** mitata-compatible: filter value is a JS regex source, substring-matched (no
 * anchoring), case-sensitive, against the "group/name" task id. */
export function filterTasks(
  tasks: readonly RegisteredTask[],
  filter?: string,
): RegisteredTask[] {
  if (!filter) return [...tasks]
  const re = new RegExp(filter)
  return tasks.filter((t) => re.test(taskId(t)))
}
