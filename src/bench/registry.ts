type Hook = () => unknown | Promise<unknown>

export interface TaskOptions {
  /** Marks this task as the Relative reference for its group in the table
   * renderer, mirroring mitata's `baseline()`. At most one per group. */
  baseline?: boolean
  /** Per-task time budget; overrides the suite-wide `--budget` / `budgetMs`. */
  budgetMs?: number
  /** Per-task exact trial count; overrides the suite-wide `--samples` /
   * `samples`. When set, the budget is ignored for this task. */
  samples?: number
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
  /** Overrides the suite-wide `bench({ cpu })` / `--cpu` (and any
   * `GroupOptions.cpu`) for this task only: after the timing measurement,
   * capture one extra `phase: "cpu"` measurement (JIT tiers included) on
   * the same workload, never mixed into the timing numbers. */
  cpu?: boolean
  /** Overrides the suite-wide `bench({ alloc })` / `--alloc` (and any
   * `GroupOptions.alloc`) for this task only: after the timing measurement,
   * capture one extra `phase: "memstats"` measurement of the heap each call
   * retains (what survives a full GC, not what it allocates). */
  alloc?: boolean
  /** Overrides the suite-wide `bench({ peakMem })` / `--peak-mem` (and any
   * `GroupOptions.peakMem`) for this task only: capture one extra
   * `phase: "memstats"` measurement of how far one call raises the
   * process's peak RSS, in fresh processes. */
  peakMem?: boolean
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
  /** Default `cpu` for every task in this group, unless a task overrides it
   * with its own `TaskOptions.cpu`. */
  cpu?: boolean
  /** Default `alloc` for every task in this group, unless a task overrides
   * it with its own `TaskOptions.alloc`. */
  alloc?: boolean
  /** Default `peakMem` for every task in this group, unless a task
   * overrides it with its own `TaskOptions.peakMem`. */
  peakMem?: boolean
  /** Runs once, unmeasured, before the group's first task's warmup (not
   * before every task) - in whichever process runs that task, so it works
   * with `isolate`. */
  before?: Hook
  /** Runs once, unmeasured, after the group's last task's last trial. */
  after?: Hook
}

/** One enclosing group of a task, with the hooks it declared. */
interface GroupFrame {
  /** Slash-joined names from the outermost group down to this one. */
  path: string
  before?: Hook
  after?: Hook
}

export interface RegisteredTask {
  /** The enclosing groups' names joined with "/", outermost first. */
  groupName?: string
  /** Enclosing groups, outermost first. */
  groupChain?: readonly GroupFrame[]
  groupDescription?: string
  groupIsolate?: boolean
  groupGc?: boolean
  groupCpu?: boolean
  groupAlloc?: boolean
  groupPeakMem?: boolean
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

type Flags = { skip?: boolean; only?: boolean }

const tasks: RegisteredTask[] = []
let currentGroup:
  | (Omit<GroupOptions, "before" | "after"> &
      Flags & { path: string; chain: readonly GroupFrame[] })
  | undefined
let currentParams: Record<string, string | number | boolean> | undefined

function registerGroup(
  name: string,
  fn: () => void,
  opts: GroupOptions | undefined,
  flags: Flags,
): void {
  const previous = currentGroup
  // An inner group inherits what it doesn't set, and skip/only from outside.
  const path = previous ? `${previous.path}/${name}` : name
  currentGroup = {
    path,
    chain: [
      ...(previous?.chain ?? []),
      { path, before: opts?.before, after: opts?.after },
    ],
    description: opts?.description ?? previous?.description,
    isolate: opts?.isolate ?? previous?.isolate,
    gc: opts?.gc ?? previous?.gc,
    cpu: opts?.cpu ?? previous?.cpu,
    alloc: opts?.alloc ?? previous?.alloc,
    peakMem: opts?.peakMem ?? previous?.peakMem,
    skip: flags.skip || previous?.skip,
    only: flags.only || previous?.only,
  }
  try {
    fn()
  } finally {
    currentGroup = previous
  }
}

type GroupRegistrar = (
  name: string,
  fn: () => void,
  opts?: GroupOptions,
) => void

interface GroupFn extends GroupRegistrar {
  /** Registers every task inside as skipped: the runner never measures
   * them, but the document still carries their workloads (marked
   * `Workload.skipped`). */
  skip: GroupRegistrar
  /** When any task or group in the suite uses `.only`, the runner restricts
   * the whole suite file to only those tasks (before `--filter` narrows
   * further) and prints a one-line notice to stderr. */
  only: GroupRegistrar
}

export const group: GroupFn = Object.assign(
  ((name, fn, opts) => registerGroup(name, fn, opts, {})) as GroupRegistrar,
  {
    skip: ((name, fn, opts) =>
      registerGroup(name, fn, opts, { skip: true })) as GroupRegistrar,
    only: ((name, fn, opts) =>
      registerGroup(name, fn, opts, { only: true })) as GroupRegistrar,
  },
)

function registerTask(
  name: string,
  fn: () => unknown | Promise<unknown>,
  opts: TaskOptions | undefined,
  flags: Flags,
): void {
  const params =
    currentParams !== undefined || opts?.params !== undefined
      ? { ...currentParams, ...opts?.params }
      : undefined
  tasks.push({
    groupName: currentGroup?.path,
    groupChain: currentGroup?.chain,
    groupDescription: currentGroup?.description,
    groupIsolate: currentGroup?.isolate,
    groupGc: currentGroup?.gc,
    groupCpu: currentGroup?.cpu,
    groupAlloc: currentGroup?.alloc,
    groupPeakMem: currentGroup?.peakMem,
    name,
    fn,
    baseline: opts?.baseline,
    params,
    skipped: flags.skip || currentGroup?.skip,
    only: flags.only || currentGroup?.only,
    opts,
  })
}

type TaskRegistrar = (
  name: string,
  fn: () => unknown | Promise<unknown>,
  opts?: TaskOptions,
) => void

interface TaskFn extends TaskRegistrar {
  /** Registers the task as skipped: the runner never measures it, but the
   * document still carries its workload (marked `Workload.skipped`) so a
   * renderer or `compare` can say so explicitly instead of the task simply
   * being absent. */
  skip: TaskRegistrar
  /** When any task or group in the suite uses `.only`, the runner restricts
   * the whole suite file to only those tasks (before `--filter` narrows
   * further) and prints a one-line notice to stderr. */
  only: TaskRegistrar
}

export const task: TaskFn = Object.assign(
  ((name, fn, opts) => registerTask(name, fn, opts, {})) as TaskRegistrar,
  {
    skip: ((name, fn, opts) =>
      registerTask(name, fn, opts, { skip: true })) as TaskRegistrar,
    only: ((name, fn, opts) =>
      registerTask(name, fn, opts, { only: true })) as TaskRegistrar,
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

/** Runs `fn` with `params` as the current sweep point: `task()` calls inside
 * inherit it as their params (explicit `TaskOptions.params` keys win). */
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

// Effective per-task flags: the task's own value, then its group's, then the
// suite-wide default.
export function taskIsolate(t: RegisteredTask, suiteIsolate: boolean): boolean {
  return t.opts?.isolate ?? t.groupIsolate ?? suiteIsolate
}

export function taskGc(t: RegisteredTask, suiteGc: boolean): boolean {
  return t.opts?.gc ?? t.groupGc ?? suiteGc
}

export function taskCpu(t: RegisteredTask, suiteCpu: boolean): boolean {
  return t.opts?.cpu ?? t.groupCpu ?? suiteCpu
}

export function taskAlloc(t: RegisteredTask, suiteAlloc: boolean): boolean {
  return t.opts?.alloc ?? t.groupAlloc ?? suiteAlloc
}

export function taskPeakMem(t: RegisteredTask, suitePeakMem: boolean): boolean {
  return t.opts?.peakMem ?? t.groupPeakMem ?? suitePeakMem
}

/** For the task at an index, the paths of the groups it opens (it's the first
 * measured task inside them: outermost first) and closes (the last: innermost
 * first), so group hooks wrap measured tasks only (a group's tasks needn't be
 * contiguous) and an outer group's hooks run once around its nested groups. */
export function groupEdges(
  tasks: readonly RegisteredTask[],
): (index: number) => { enter: string[]; leave: string[] } {
  const first = new Map<string, number>()
  const last = new Map<string, number>()
  tasks.forEach((t, i) => {
    if (t.skipped) return
    for (const { path } of t.groupChain ?? []) {
      if (!first.has(path)) first.set(path, i)
      last.set(path, i)
    }
  })
  return (i) => {
    const paths = (tasks[i]!.groupChain ?? []).map((f) => f.path)
    return {
      enter: paths.filter((p) => first.get(p) === i),
      leave: paths.filter((p) => last.get(p) === i).reverse(),
    }
  }
}

/** Runs the task's `before`/`after` hooks for the groups at `paths` (in the
 * order given; default: all its groups, outermost first for `before`,
 * innermost first for `after`). A path the task isn't in is skipped. */
export async function runGroupHooks(
  t: RegisteredTask,
  kind: "before" | "after",
  paths?: readonly string[],
): Promise<void> {
  const chain = t.groupChain ?? []
  const order =
    paths ??
    (kind === "before" ? chain : [...chain].reverse()).map((f) => f.path)
  for (const path of order) {
    await chain.find((f) => f.path === path)?.[kind]?.()
  }
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

/** The tasks a run measures: `.only` tasks when any exist (with a stderr
 * notice, since a forgotten `.only` silently shrinks a suite), else every
 * registered task - then narrowed by `filter`. Throws when that leaves
 * nothing, naming how many tasks the filter was matched against. */
export function selectTasks(
  registered: readonly RegisteredTask[],
  filter: string | undefined,
  where: string,
  // False in the follow-up processes of one run (isolated tasks, peak-memory
  // readings, ab repeats), so the notice prints once per suite file.
  announce = true,
): RegisteredTask[] {
  const onlyTasks = registered.filter((t) => t.only)
  const candidates = onlyTasks.length > 0 ? onlyTasks : registered
  if (announce && onlyTasks.length > 0) {
    process.stderr.write(
      `bench: ${onlyTasks.length} task(s) selected by .only\n`,
    )
  }
  const tasks = filterTasks(candidates, filter)
  if (tasks.length === 0) {
    throw new Error(
      `filter ${JSON.stringify(filter)} matched zero of ${candidates.length} registered task(s) in ${where}.`,
    )
  }
  return tasks
}
