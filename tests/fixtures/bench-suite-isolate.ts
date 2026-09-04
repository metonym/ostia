import { group, task } from "../../src/index.ts"

task("plain", () => 1)
task("solo-isolated", () => 2, { isolate: true })

group(
  "g-isolated",
  () => {
    task("a", () => 3)
    task("b", () => 4, { isolate: false })
  },
  { isolate: true },
)
