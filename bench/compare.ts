import { compareDocuments, compareWorkload } from "../src/compare/index.ts"
import { group, task } from "../src/index.ts"
import {
  cpuEvidenceFromTree,
  SMALL_TREE,
  syntheticDocument,
} from "./lib/fixtures.ts"

group("compare", () => {
  const cpuA = cpuEvidenceFromTree(SMALL_TREE, 5_000)
  const cpuB = cpuEvidenceFromTree(SMALL_TREE, 5_000)
  const base = syntheticDocument(1_000, cpuA)
  const cand = syntheticDocument(1_000, cpuB)

  task("compareDocuments (timing + 341 cpu frames)", () =>
    compareDocuments(base, cand),
  )
  task("compareWorkload (single workload, timing + cpu)", () =>
    compareWorkload(base, cand, base.workloads[0]!.id),
  )
})
