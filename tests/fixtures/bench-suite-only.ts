import { group, task } from "../../src/index.ts"

group("only", () => {
  task.only("selected", () => 1)
  task("ignored", () => 1)
})
