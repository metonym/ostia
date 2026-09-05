type Hook = () => unknown | Promise<unknown>

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
  /** Runs once, unmeasured, immediately before this task's warmup - in the
   * task's own process, so it works with `isolate`. No per-trial hook: that
   * would defeat batching. Use `gc` (Bun.gc between trials) or `isolate`
   * (a fresh process per task) for per-trial concerns instead. */
  before?: Hook
  /** Runs once, unmeasured, immediately after this task's last trial. Same
   * process/no-per-trial caveats as `before`. */
  after?: Hook
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
  /** Runs once, unmeasured, before the group's first task's warmup (not
   * before every task) - in whichever process runs that task, so it works
   * with `isolate`. */
  before?: Hook
  /** Runs once, unmeasured, after the group's last task's last trial. */
  after?: Hook
}

export interface RegisteredTask {
  groupName?: string
  groupDescription?: string
  groupIsolate?: boolean
  groupGc?: boolean
  groupBefore?: Hook
  groupAfter?: Hook
  name: string
  fn: () => unknown | Promise<unknown>
  baseline?: boolean
  params?: Record<string, string | number | boolean>
  /** From `task.skip()` or a `group.skip()` this task is inside. The runner
   * never measures it; the document still carries its workload (marked
   * `Workload.skipped`) so a renderer or `compare` can say so explicitly. */
  skipped?: boolean
  /** From `task.only()` or a `group.only()` this task is inside. When any
   * registered task has this set, the runner restricts the whole suite file
   * to only those tasks (before `--filter` narrows further). */
  only?: boolean
  opts?: TaskOptions
}

const tasks: RegisteredTask[] = []
let currentGroup:
  | {
      name: string
      description?: string
      isolate?: boolean
      gc?: boolean
      before?: Hook
      after?: Hook
      skip?: boolean
      only?: boolean
    }
  | undefined
let currentParams: Record<string, string | number | boolean> | undefined

function registerGroup(
  name: string,
  fn: () => void,
  opts: GroupOptions | undefined,
  flags: { skip?: boolean; only?: boolean },
): void {
  const previous = currentGroup
  currentGroup = {
    name,
    description: opts?.description,
    isolate: opts?.isolate,
    gc: opts?.gc,
    before: opts?.before,
    after: opts?.after,
    skip: flags.skip,
    only: flags.only,
  }
  try {
    fn()
  } finally {
    currentGroup = previous
  }
}

interface GroupFn {
  (name: string, fn: () => void, opts?: GroupOptions): void
  /** Registers every task inside as skipped: the runner never measures
   * them, but the document still carries their workloads (marked
   * `Workload.skipped`). */
  skip: (name: string, fn: () => void, opts?: GroupOptions) => void
  /** When any task or group in the suite uses `.only`, the runner restricts
   * the whole suite file to only those tasks (before `--filter` narrows
   * further) and prints a one-line notice to stderr. */
  only: (name: string, fn: () => void, opts?: GroupOptions) => void
}

export const group: GroupFn = Object.assign(
  (name: string, fn: () => void, opts?: GroupOptions): void =>
    registerGroup(name, fn, opts, {}),
  {
    skip: (name: string, fn: () => void, opts?: GroupOptions): void =>
      registerGroup(name, fn, opts, { skip: true }),
    only: (name: string, fn: () => void, opts?: GroupOptions): void =>
      registerGroup(name, fn, opts, { only: true }),
  },
)

function registerTask(
  name: string,
  fn: () => unknown | Promise<unknown>,
  opts: TaskOptions | undefined,
  flags: { skip?: boolean; only?: boolean },
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
    groupBefore: currentGroup?.before,
    groupAfter: currentGroup?.after,
    name,
    fn,
    baseline: opts?.baseline,
    params,
    skipped: flags.skip || currentGroup?.skip,
    only: flags.only || currentGroup?.only,
    opts,
  })
}

interface TaskFn {
  (name: string, fn: () => unknown | Promise<unknown>, opts?: TaskOptions): void
  /** Registers the task as skipped: the runner never measures it, but the
   * document still carries its workload (marked `Workload.skipped`) so a
   * renderer or `compare` can say so explicitly instead of the task simply
   * being absent. */
  skip: (
    name: string,
    fn: () => unknown | Promise<unknown>,
    opts?: TaskOptions,
  ) => void
  /** When any task or group in the suite uses `.only`, the runner restricts
   * the whole suite file to only those tasks (before `--filter` narrows
   * further) and prints a one-line notice to stderr. */
  only: (
    name: string,
    fn: () => unknown | Promise<unknown>,
    opts?: TaskOptions,
  ) => void
}

export const task: TaskFn = Object.assign(
  (
    name: string,
    fn: () => unknown | Promise<unknown>,
    opts?: TaskOptions,
  ): void => registerTask(name, fn, opts, {}),
  {
    skip: (
      name: string,
      fn: () => unknown | Promise<unknown>,
      opts?: TaskOptions,
    ): void => registerTask(name, fn, opts, { skip: true }),
    only: (
      name: string,
      fn: () => unknown | Promise<unknown>,
      opts?: TaskOptions,
    ): void => registerTask(name, fn, opts, { only: true }),
  },
)

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
