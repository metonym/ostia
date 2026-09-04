import { group, task } from "../../src/index.ts"

task("plain", () => 1)
task("solo-gc", () => 2, { gc: true })

group(
  "g-gc",
  () => {
    task("a", () => 3)
    task("b", () => 4, { gc: false })
  },
  { gc: true },
)
