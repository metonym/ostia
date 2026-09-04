import { group, task } from "../src/index.ts"
import {
  makeArtifactRef,
  makeInstrumentedRun,
  makeSubprocessWorkload,
  makeTimingRun,
  newDocument,
  serializeDocument,
} from "../src/ir/document.ts"
import { canonicalJSON, fp, sortKeysDeep } from "../src/ir/fp.ts"
import { computeTimingStats } from "../src/stats/index.ts"
import {
  cpuEvidenceFromTree,
  SMALL_TREE,
  syntheticSamples,
} from "./lib/fixtures.ts"

group("ir", () => {
  const parts = {
    workloadId: "wl_x",
    phase: "timing",
    configFingerprint: "cfg_x",
    bunVersion: "1.4.0",
    toolVersion: "0.1.0",
  }
  const nested = { b: [1, 2, 3], a: { z: 1, y: 2 }, c: "hello" }

  task("fp() id generation", () => fp("run", parts))
  task("canonicalJSON (nested object)", () => canonicalJSON(nested))
  task("sortKeysDeep (nested object)", () => sortKeysDeep(nested))
})

group("document", () => {
  const workload = makeSubprocessWorkload(["bun", "x.ts"], "x")
  const trials = syntheticSamples(1_000).map((wallNs, i) => ({
    i,
    wallNs,
    exitCode: 0,
  }))
  const cpu = cpuEvidenceFromTree(SMALL_TREE, 1_000)
  const timing = computeTimingStats(trials.map((t) => t.wallNs))

  task("makeTimingRun (1e3 trials)", () =>
    makeTimingRun({
      workload,
      configFingerprint: "cfg_dogfood",
      trials,
      timing,
      warnings: [],
    }),
  )

  task("makeInstrumentedRun (341-frame cpu evidence)", () =>
    makeInstrumentedRun({
      workload,
      phase: "cpu",
      configFingerprint: "cfg_dogfood",
      diagnosticWallNs: 1_000_000,
      cpu,
      warnings: [],
      artifacts: [],
    }),
  )

  const timingRun = makeTimingRun({
    workload,
    configFingerprint: "cfg_dogfood",
    trials,
    timing,
    warnings: [],
  })
  const doc = newDocument([workload], [timingRun])

  task("serializeDocument (1e3-trial doc)", () => serializeDocument(doc))

  task("makeArtifactRef (sha256 of bench/lib/fixtures.ts)", () =>
    makeArtifactRef("run_x", "other", "bench/lib/fixtures.ts"),
  )
})
