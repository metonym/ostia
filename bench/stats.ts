import { group, task } from "../src/index.ts"
import { computeTimingStats, timingWarnings } from "../src/stats/index.ts"
import { syntheticSamples } from "./lib/fixtures.ts"

group("stats", () => {
  const small = syntheticSamples(1_000)
  const large = syntheticSamples(10_000)
  const exitCodesSmall = small.map(() => 0)

  task("computeTimingStats (1e3 samples)", () => computeTimingStats(small))
  task("computeTimingStats (1e4 samples)", () => computeTimingStats(large))

  task("timingWarnings (1e3 samples)", () => {
    const stats = computeTimingStats(small)
    return timingWarnings(stats, exitCodesSmall, "subprocess")
  })
})
