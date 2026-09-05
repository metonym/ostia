import { describe, expect, test } from "bun:test"
import { loadDocument } from "../../src/ir/document.ts"
import type { ProfileDocument } from "../../src/ir/types.ts"

const V1_FIXTURE_PATH = `${import.meta.dir}/../../.ostia-test-v1-fixture.json`

const V1_DOCUMENT = {
  schemaVersion: 1,
  toolVersion: "0.1.0",
  bunVersion: "1.4.0",
  platform: { os: "darwin", arch: "arm64" },
  createdAt: "2026-01-01T00:00:00.000Z",
  workloads: [{ id: "wl_a", kind: "subprocess", command: ["bun", "a.ts"] }],
  runs: [
    {
      id: "run_a",
      workloadId: "wl_a",
      phase: "timing",
      instrumented: false,
      configFingerprint: "cfg_a",
      trials: [{ i: 0, wallNs: 1_000_000, exitCode: 0 }],
      timing: {
        unit: "ns",
        samples: [1_000_000],
        mean: 1_000_000,
        median: 1_000_000,
        stddev: 0,
        min: 1_000_000,
        max: 1_000_000,
        outliers: { mild: 0, severe: 0 },
      },
      warnings: [],
      artifacts: [],
      baselineRunId: "run_prior",
    },
  ],
  comparisons: [
    {
      id: "cmp_a",
      baselineRunId: "run_prior",
      candidateRunId: "run_a",
      timing: { medianDeltaPct: 1, meanDeltaPct: 1, verdict: "unchanged" },
      thresholds: {
        timingPct: 5,
        frameSelfPct: 10,
        heapTypePct: 10,
        minFrameSelfUs: 1000,
      },
      verdict: "pass",
    },
  ],
}

describe("loadDocument - v1 -> v2 upgrade", () => {
  test("upgrades a hand-written v1 fixture (runs, Comparison.baselineRunId/candidateRunId) in memory", async () => {
    await Bun.write(V1_FIXTURE_PATH, JSON.stringify(V1_DOCUMENT))
    try {
      const doc = await loadDocument(V1_FIXTURE_PATH)

      expect(doc.schemaVersion).toBe(2)
      expect(doc.measurements).toHaveLength(1)
      expect(doc.measurements[0]!.id).toBe("run_a")
      expect(doc.measurements[0]!.baselineMeasurementId).toBe("run_prior")

      expect(doc.comparisons).toHaveLength(1)
      expect(doc.comparisons![0]!.baselineMeasurementId).toBe("run_prior")
      expect(doc.comparisons![0]!.candidateMeasurementId).toBe("run_a")
    } finally {
      await Bun.spawn(["rm", "-f", V1_FIXTURE_PATH]).exited
    }
  })

  test("passes a v2 document through unchanged", async () => {
    const path = `${import.meta.dir}/../../.ostia-test-v2-fixture.json`
    const v2: ProfileDocument = {
      schemaVersion: 2,
      toolVersion: "0.1.0",
      bunVersion: "1.4.0",
      platform: { os: "darwin", arch: "arm64" },
      createdAt: "2026-01-01T00:00:00.000Z",
      workloads: [],
      measurements: [],
    }
    await Bun.write(path, JSON.stringify(v2))
    try {
      const doc = await loadDocument(path)
      expect(doc).toEqual(v2)
    } finally {
      await Bun.spawn(["rm", "-f", path]).exited
    }
  })
})
