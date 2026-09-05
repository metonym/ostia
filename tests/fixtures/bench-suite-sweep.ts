import { group, range, sweep, task } from "../../src/index.ts"

function hotInner(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}

group("sweep", () => {
  sweep(
    { size: range(100, 800), impl: ["current", "fast"] },
    ({ size, impl }) => {
      task(impl, () => hotInner(impl === "fast" ? size / 2 : size))
    },
  )
})
