import { group, task } from "../../src/index.ts"

const input = Array.from({ length: 2_000 }, (_, i) => i % 500)

function dedupeNaive(xs: number[]): number[] {
  const out: number[] = []
  for (const x of xs) if (!out.includes(x)) out.push(x)
  return out
}

function dedupeSet(xs: number[]): number[] {
  return [...new Set(xs)]
}

group("dedupe", () => {
  task("naive (indexOf scan, O(n²))", () => dedupeNaive(input))
  task("Set-based (O(n))", () => dedupeSet(input))
})
