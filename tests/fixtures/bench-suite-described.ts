import { group, task } from "../../src/index.ts"

const input = Array.from({ length: 2_000 }, (_, i) => i % 500)

group(
  "dedupe",
  () => {
    task("naive", () => {
      const out: number[] = []
      for (const x of input) if (!out.includes(x)) out.push(x)
      return out
    })
    task("Set-based", () => [...new Set(input)], {
      description: "O(n) via Set; the expected winner",
    })
  },
  {
    description:
      "dedupe strategies on a 2k-element array with 500 distinct values",
  },
)

task("ungrouped", () => 1, { description: "a task outside any group" })
