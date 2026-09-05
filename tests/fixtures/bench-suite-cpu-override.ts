import { task } from "../../src/index.ts"

function hotInner(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}

task("with-cpu", () => hotInner(1_000), { cpu: true })
task("without-cpu", () => hotInner(1_000))
