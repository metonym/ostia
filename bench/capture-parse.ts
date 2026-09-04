import { parseCpuProfile } from "../src/capture/cpu/parse.ts"
import { parseHeapSnapshot } from "../src/capture/heap/parse.ts"
import { parseJscProfile } from "../src/capture/jsc/parse.ts"
import { group, task } from "../src/index.ts"
import {
  LARGE_TREE,
  SMALL_TREE,
  syntheticCpuProfile,
  syntheticHeapSnapshot,
  syntheticJscTraces,
} from "./lib/fixtures.ts"

group("cpu-parse", () => {
  const small = syntheticCpuProfile(SMALL_TREE, 1_000)
  const large = syntheticCpuProfile(LARGE_TREE, 10_000)
  task("parseCpuProfile (1e3 samples, 341 frames)", () =>
    parseCpuProfile(small, "cpu-prof", 1000),
  )
  task("parseCpuProfile (1e4 samples, 9330 frames)", () =>
    parseCpuProfile(large, "cpu-prof", 1000),
  )
})

group("jsc-parse", () => {
  const small = syntheticJscTraces(SMALL_TREE, 1_000)
  const large = syntheticJscTraces(LARGE_TREE, 10_000)
  task("parseJscProfile (1e3 samples, 341 frames)", () =>
    parseJscProfile(small),
  )
  task("parseJscProfile (1e4 samples, 9330 frames)", () =>
    parseJscProfile(large),
  )
})

group("heap-parse", () => {
  const small = syntheticHeapSnapshot(1_000)
  const large = syntheticHeapSnapshot(100_000)
  task("parseHeapSnapshot (1e3 nodes)", () => parseHeapSnapshot(small))
  task("parseHeapSnapshot (1e5 nodes)", () => parseHeapSnapshot(large))
})
