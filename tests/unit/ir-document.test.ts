import { describe, expect, test } from "bun:test"
import {
  loadDocument,
  makeEntryWorkload,
  newDocument,
} from "../../src/ir/document.ts"
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

describe("makeEntryWorkload - params fold into the workload id (item 8)", () => {
  test("no params: id matches the pre-existing (params-less) hash exactly", () => {
    const withoutOpts = makeEntryWorkload("suite.ts", "parse/small")
    const withEmptyOpts = makeEntryWorkload("suite.ts", "parse/small", {})
    expect(withoutOpts.id).toBe(withEmptyOpts.id)
    expect(withoutOpts.params).toBeUndefined()
  })

  test("two points sharing a task name but different params get distinct ids", () => {
    const a = makeEntryWorkload("suite.ts", "current", {
      params: { size: 100 },
    })
    const b = makeEntryWorkload("suite.ts", "current", {
      params: { size: 200 },
    })
    expect(a.id).not.toBe(b.id)
    expect(a.params).toEqual({ size: 100 })
    expect(b.params).toEqual({ size: 200 })
  })

  test("the same task name and params reproduce the same id", () => {
    const a = makeEntryWorkload("suite.ts", "current", {
      params: { size: 100 },
    })
    const b = makeEntryWorkload("suite.ts", "current", {
      params: { size: 100 },
    })
    expect(a.id).toBe(b.id)
  })

  test("adding params to a previously params-less task changes its id (expected: it's a different point now)", () => {
    const before = makeEntryWorkload("suite.ts", "t")
    const after = makeEntryWorkload("suite.ts", "t", { params: { size: 100 } })
    expect(before.id).not.toBe(after.id)
  })
})

describe("newDocument - git metadata (item 17)", () => {
  test("attaches sha/branch/dirty when run inside a git repo, additive alongside environment", () => {
    const doc = newDocument([], [])
    expect(doc.git).toBeDefined()
    expect(typeof doc.git!.sha).toBe("string")
    expect(doc.git!.sha.length).toBeGreaterThan(0)
    expect(typeof doc.git!.branch).toBe("string")
    expect(typeof doc.git!.dirty).toBe("boolean")
  })
})
