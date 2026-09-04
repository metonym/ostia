import { group, task } from "../src/index.ts"
import { buildParentMap, computeNodeTimes } from "../src/renderers/cpu-tree.ts"
import { cpuEvidenceFromTree, LARGE_TREE } from "./lib/fixtures.ts"

group("cpu-tree", () => {
  const cpu = cpuEvidenceFromTree(LARGE_TREE, 10_000)
  task("buildParentMap (9330 nodes)", () => buildParentMap(cpu))
  task("computeNodeTimes (1e4 samples, 9330 nodes)", () =>
    computeNodeTimes(cpu),
  )
})
