import { group, task } from "../../src/index.ts"

group("skip", () => {
  task("measured", () => 1)
  task.skip("skipped", () => 1)
})
