import { run, task } from "../../src/index.ts"

let cleanedUp = false

task("solo", () => 1)

try {
  await run({ budgetMs: 20, minSamples: 3, noiseCheck: false })
} finally {
  cleanedUp = true
}

if (!cleanedUp) throw new Error("cleanup did not run")
