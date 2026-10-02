import type { Workload } from "../ir/types.ts"
import type { TimingRun } from "./select.ts"

export interface TimingRow {
  run: TimingRun
  workload: Workload | undefined
}

/** The explicit `entry.group` the bench runner records, else the "group/name"
 * id split on its last "/" (documents from before that field existed). */
export function groupOf(workload: Workload | undefined): string | undefined {
  if (!workload?.entry) return undefined
  if (workload.entry.group !== undefined) return workload.entry.group
  const id = workload.entry.task
  const idx = id.lastIndexOf("/")
  return idx === -1 ? undefined : id.slice(0, idx)
}

/** Each row's median over its reference median: its group's
 * `task(..., { baseline: true })` task, else the group's fastest. Ungrouped
 * rows use the fastest in the document; tasks never compare across groups.
 * Undefined with fewer than two rows, where "relative" means nothing. */
export function relativeRatios<R extends TimingRow>(
  rows: R[],
): Map<R, number> | undefined {
  if (rows.length < 2) return undefined
  const fastestMedian = Math.min(...rows.map((r) => r.run.timing.median))
  const siblingsByGroup = new Map<string, R[]>()
  for (const row of rows) {
    const key = groupOf(row.workload)
    if (key === undefined) continue
    const siblings = siblingsByGroup.get(key)
    if (siblings) siblings.push(row)
    else siblingsByGroup.set(key, [row])
  }

  const ratios = new Map<R, number>()
  for (const row of rows) {
    const key = groupOf(row.workload)
    let reference = fastestMedian
    if (key !== undefined) {
      const siblings = siblingsByGroup.get(key)!
      const baselineRow = siblings.find((s) => s.workload?.baseline)
      reference = baselineRow
        ? baselineRow.run.timing.median
        : Math.min(...siblings.map((s) => s.run.timing.median))
    }
    ratios.set(row, row.run.timing.median / reference)
  }
  return ratios
}
