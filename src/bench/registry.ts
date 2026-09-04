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
}

export interface GroupOptions {
  /** What this group measures and why. Flows into `Workload.groupDescription`
   * on every task in the group. */
  description?: string
}

export interface RegisteredTask {
  groupName?: string
  groupDescription?: string
  name: string
  fn: () => unknown | Promise<unknown>
  baseline?: boolean
  opts?: TaskOptions
}

const tasks: RegisteredTask[] = []
let currentGroup: { name: string; description?: string } | undefined

export function group(name: string, fn: () => void, opts?: GroupOptions): void {
  const previous = currentGroup
  currentGroup = { name, description: opts?.description }
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
  tasks.push({
    groupName: currentGroup?.name,
    groupDescription: currentGroup?.description,
    name,
    fn,
    baseline: opts?.baseline,
    opts,
  })
}

export function getRegisteredTasks(): readonly RegisteredTask[] {
  return tasks
}

export function resetRegistry(): void {
  tasks.length = 0
  currentGroup = undefined
}

export function taskId(t: RegisteredTask): string {
  return t.groupName ? `${t.groupName}/${t.name}` : t.name
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
