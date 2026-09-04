import { group, task } from "../../src/index.ts"

function hotInner(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}

group("math", () => {
  task("hotInner-small", () => hotInner(1_000))
  task("hotInner-large", () => hotInner(50_000))
})

task("noop", () => 1)
