import { group, task } from "../../src/index.ts"

function spin(ms: number): number {
  const end = Bun.nanoseconds() + ms * 1e6
  let acc = 0
  while (Bun.nanoseconds() < end) acc = (acc + 1) | 0
  return acc
}

group("overrides", () => {
  task("global", () => spin(1))
  task("pinned", () => spin(1), { budgetMs: 5, minSamples: 40 })
})
