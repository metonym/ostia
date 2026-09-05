import type { Measurement, Workload } from "../ir/types.ts"

export interface TimingRow {
  run: Measurement & { timing: NonNullable<Measurement["timing"]> }
  workload: Workload | undefined
}

/** Group a task belongs to. Prefers the explicit `entry.group` the bench
 * runner records; falls back to splitting the "group/name" id on its last "/"
 * for documents written before that field existed. Workloads without a group
 * (or not from `task()` at all) return undefined. */
function groupOf(workload: Workload | undefined): string | undefined {
  if (!workload?.entry) return undefined
  if (workload.entry.group !== undefined) return workload.entry.group
  const id = workload.entry.task
  const idx = id.lastIndexOf("/")
  return idx === -1 ? undefined : id.slice(0, idx)
}

/** Reference median for each row's Relative value. Grouped tasks compare
 * against their own group: its `task(..., { baseline: true })` task if one is
 * marked, else its fastest task (which, for a single-task group, is itself).
 * Ungrouped rows fall back to the fastest median in the whole document. A
 * suite spanning nanoseconds to seconds never compares tasks across groups. */
export function relativeReferences<R extends TimingRow>(
  rows: R[],
): Map<R, number> {
  const fastestMedian = Math.min(...rows.map((r) => r.run.timing.median))
  const siblingsByGroup = new Map<string, R[]>()
  for (const row of rows) {
    const key = groupOf(row.workload)
    if (key === undefined) continue
    const arr = siblingsByGroup.get(key)
    if (arr) arr.push(row)
    else siblingsByGroup.set(key, [row])
  }

  const refs = new Map<R, number>()
  for (const row of rows) {
    const groupKey = groupOf(row.workload)
    if (groupKey === undefined) {
      refs.set(row, fastestMedian)
      continue
    }
    const siblings = siblingsByGroup.get(groupKey) ?? [row]
    const baselineRow = siblings.find((s) => s.workload?.baseline)
    refs.set(
      row,
      baselineRow
        ? baselineRow.run.timing.median
        : Math.min(...siblings.map((s) => s.run.timing.median)),
    )
  }
  return refs
}
