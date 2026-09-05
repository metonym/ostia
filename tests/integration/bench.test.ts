import { afterAll, describe, expect, test } from "bun:test"
import { bench } from "../../src/index.ts"

const SUITE = `${import.meta.dir}/../fixtures/bench-suite.ts`
const OUT_DIR = `${import.meta.dir}/../../.ostia-test-bench`

describe("bench() - real in-process suite, one spawned child per suite file", () => {
  afterAll(async () => {
    await Bun.spawn(["rm", "-rf", OUT_DIR]).exited
  })

  test("registers group()/task() calls and measures each task independently", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [SUITE],
      timeBudgetMs: 50,
      minSamples: 5,
      outDir: OUT_DIR,
    })

    expect(doc.workloads).toHaveLength(3)
    expect(doc.measurements).toHaveLength(3)

    const byLabel = new Map(doc.workloads.map((w) => [w.label, w]))
    expect(byLabel.has("math/hotInner-small")).toBe(true)
    expect(byLabel.has("math/hotInner-large")).toBe(true)
    expect(byLabel.has("noop")).toBe(true)

    const smallWorkload = byLabel.get("math/hotInner-small")!
    expect(smallWorkload.kind).toBe("inprocess")
    expect(smallWorkload.entry).toEqual({
      file: SUITE,
      task: "math/hotInner-small",
      group: "math",
    })
    expect(byLabel.get("noop")!.entry).toEqual({ file: SUITE, task: "noop" })

    const largeWorkload = byLabel.get("math/hotInner-large")!
    const smallRun = doc.measurements.find(
      (r) => r.workloadId === smallWorkload.id,
    )!
    const largeRun = doc.measurements.find(
      (r) => r.workloadId === largeWorkload.id,
    )!
    expect(smallRun.instrumented).toBe(false)
    expect(smallRun.phase).toBe("timing")
    expect(smallRun.trials.length).toBeGreaterThanOrEqual(5)
    expect(largeRun.timing!.median).toBeGreaterThan(smallRun.timing!.median)
  }, 20_000)

  test("workload id is stable across separate bench() invocations of the same suite", async () => {
    const a = await bench({
      noiseCheck: false,
      suites: [SUITE],
      timeBudgetMs: 20,
      minSamples: 5,
      outDir: `${OUT_DIR}-a`,
    })
    const b = await bench({
      noiseCheck: false,
      suites: [SUITE],
      timeBudgetMs: 20,
      minSamples: 5,
      outDir: `${OUT_DIR}-b`,
    })

    const idsA = new Set(a.workloads.map((w) => w.id))
    const idsB = new Set(b.workloads.map((w) => w.id))
    expect(idsA).toEqual(idsB)

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-a`, `${OUT_DIR}-b`]).exited
  }, 20_000)

  test("per-task options override the suite-wide budget and sample floor", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [`${import.meta.dir}/../fixtures/bench-suite-overrides.ts`],
      timeBudgetMs: 5,
      minSamples: 5,
      outDir: `${OUT_DIR}-overrides`,
    })
    const byLabel = new Map(doc.workloads.map((w) => [w.label, w]))
    const runOf = (label: string) =>
      doc.measurements.find((r) => r.workloadId === byLabel.get(label)!.id)!
    const global = runOf("overrides/global")
    const pinned = runOf("overrides/pinned")
    // ~1ms per call, 5ms budget: the global task takes ~5 trials, the pinned one
    // is held to its own 40-sample floor.
    expect(global.trials.length).toBeLessThan(40)
    expect(pinned.trials.length).toBeGreaterThanOrEqual(40)
    expect(pinned.configFingerprint).not.toBe(global.configFingerprint)

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-overrides`]).exited
  }, 20_000)

  test("a suite with no registered tasks fails the bench run instead of silently returning nothing", async () => {
    const emptySuite = `${OUT_DIR}-empty-suite.ts`
    await Bun.write(emptySuite, "export {}\n")

    await expect(
      bench({ suites: [emptySuite], outDir: `${OUT_DIR}-empty` }),
    ).rejects.toThrow()

    await Bun.spawn(["rm", "-f", emptySuite]).exited
    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-empty`]).exited
  }, 20_000)

  test("--filter runs only tasks whose group/name id matches the regex", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [SUITE],
      timeBudgetMs: 20,
      minSamples: 5,
      filter: "math",
      outDir: `${OUT_DIR}-filter-match`,
    })

    expect(doc.workloads).toHaveLength(2)
    const labels = doc.workloads.map((w) => w.label).sort()
    expect(labels).toEqual(["math/hotInner-large", "math/hotInner-small"])

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-filter-match`]).exited
  }, 20_000)

  test("--filter matching zero tasks fails the bench run instead of returning an empty table", async () => {
    await expect(
      bench({
        suites: [SUITE],
        timeBudgetMs: 20,
        minSamples: 5,
        filter: "nonexistent-xyz",
        outDir: `${OUT_DIR}-filter-empty`,
      }),
    ).rejects.toThrow()

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-filter-empty`]).exited
  }, 20_000)

  test("group()/task() descriptions flow into the document as workload annotations", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [`${import.meta.dir}/../fixtures/bench-suite-described.ts`],
      timeBudgetMs: 10,
      minSamples: 3,
      outDir: `${OUT_DIR}-described`,
    })
    const byLabel = new Map(doc.workloads.map((w) => [w.label, w]))
    const described = byLabel.get("dedupe/Set-based")!
    expect(described.entry?.group).toBe("dedupe")
    expect(described.description).toBe("O(n) via Set; the expected winner")
    expect(described.groupDescription).toBe(
      "dedupe strategies on a 2k-element array with 500 distinct values",
    )
    const plain = byLabel.get("dedupe/naive")!
    expect(plain.description).toBeUndefined()
    expect(plain.groupDescription).toBe(described.groupDescription)
    const solo = byLabel.get("ungrouped")!
    expect(solo.entry?.group).toBeUndefined()
    expect(solo.groupDescription).toBeUndefined()
    expect(solo.description).toBe("a task outside any group")

    // Annotations never change the workload id, so existing baselines still match.
    const bare = await bench({
      noiseCheck: false,
      suites: [`${import.meta.dir}/../fixtures/bench-suite.ts`],
      timeBudgetMs: 10,
      minSamples: 3,
      outDir: `${OUT_DIR}-described-b`,
    })
    expect(bare.workloads.map((w) => w.id)).not.toContain(described.id)

    await Bun.spawn([
      "rm",
      "-rf",
      `${OUT_DIR}-described`,
      `${OUT_DIR}-described-b`,
    ]).exited
  }, 20_000)

  test("jobs > 1 runs suite files concurrently but keeps command-line order in the document", async () => {
    const suites = [
      `${import.meta.dir}/../fixtures/bench-suite-overrides.ts`,
      SUITE,
      `${import.meta.dir}/../fixtures/bench-suite-described.ts`,
    ]
    const sequential = await bench({
      noiseCheck: false,
      suites,
      timeBudgetMs: 10,
      minSamples: 3,
      outDir: `${OUT_DIR}-jobs-1`,
    })
    const concurrent = await bench({
      noiseCheck: false,
      suites,
      timeBudgetMs: 10,
      minSamples: 3,
      jobs: 3,
      outDir: `${OUT_DIR}-jobs-3`,
    })
    expect(concurrent.workloads.map((w) => w.label)).toEqual(
      sequential.workloads.map((w) => w.label),
    )
    expect(concurrent.measurements.map((r) => r.workloadId)).toEqual(
      sequential.measurements.map((r) => r.workloadId),
    )
    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-jobs-1`, `${OUT_DIR}-jobs-3`])
      .exited
  }, 30_000)

  test("jobs > 1 fails the whole run when any suite fails", async () => {
    const emptySuite = `${OUT_DIR}-jobs-empty-suite.ts`
    await Bun.write(emptySuite, "export {}\n")
    await expect(
      bench({
        suites: [SUITE, emptySuite],
        timeBudgetMs: 10,
        minSamples: 3,
        jobs: 2,
        outDir: `${OUT_DIR}-jobs-fail`,
      }),
    ).rejects.toThrow(/Bench suite failed/)
    await Bun.spawn(["rm", "-f", emptySuite]).exited
    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-jobs-fail`]).exited
  }, 20_000)

  test("isolate: true marks every task's workload as isolated and preserves registration order", async () => {
    const bare = await bench({
      noiseCheck: false,
      suites: [SUITE],
      timeBudgetMs: 10,
      minSamples: 3,
      outDir: `${OUT_DIR}-isolate-bare`,
    })
    const isolated = await bench({
      noiseCheck: false,
      suites: [SUITE],
      timeBudgetMs: 10,
      minSamples: 3,
      isolate: true,
      outDir: `${OUT_DIR}-isolate-all`,
    })

    expect(isolated.workloads.map((w) => w.label)).toEqual(
      bare.workloads.map((w) => w.label),
    )
    expect(bare.workloads.every((w) => w.isolated === undefined)).toBe(true)
    expect(isolated.workloads.every((w) => w.isolated === true)).toBe(true)

    await Bun.spawn([
      "rm",
      "-rf",
      `${OUT_DIR}-isolate-bare`,
      `${OUT_DIR}-isolate-all`,
    ]).exited
  }, 30_000)

  test("per-task/group isolate overrides work without a suite-wide isolate flag", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [`${import.meta.dir}/../fixtures/bench-suite-isolate.ts`],
      timeBudgetMs: 10,
      minSamples: 3,
      outDir: `${OUT_DIR}-isolate-mixed`,
    })

    const byLabel = new Map(doc.workloads.map((w) => [w.label, w]))
    // registration order is preserved regardless of which subprocess a task
    // ran in
    expect(doc.workloads.map((w) => w.label)).toEqual([
      "plain",
      "solo-isolated",
      "g-isolated/a",
      "g-isolated/b",
    ])
    expect(byLabel.get("plain")!.isolated).toBeUndefined()
    expect(byLabel.get("solo-isolated")!.isolated).toBe(true)
    expect(byLabel.get("g-isolated/a")!.isolated).toBe(true)
    // task-level isolate: false overrides the enclosing group's isolate: true
    expect(byLabel.get("g-isolated/b")!.isolated).toBeUndefined()

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-isolate-mixed`]).exited
  }, 30_000)

  test("--filter narrows correctly under isolate: true - unmatched tasks are never spawned", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [SUITE],
      timeBudgetMs: 10,
      minSamples: 3,
      isolate: true,
      filter: "math",
      outDir: `${OUT_DIR}-isolate-filter`,
    })
    expect(doc.workloads.map((w) => w.label).sort()).toEqual([
      "math/hotInner-large",
      "math/hotInner-small",
    ])
    expect(doc.workloads.every((w) => w.isolated === true)).toBe(true)

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-isolate-filter`]).exited
  }, 20_000)

  test("isolate: true + jobs still produces one document with correct per-task attribution", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [SUITE],
      timeBudgetMs: 10,
      minSamples: 3,
      isolate: true,
      jobs: 3,
      outDir: `${OUT_DIR}-isolate-jobs`,
    })
    expect(doc.workloads).toHaveLength(3)
    expect(doc.measurements).toHaveLength(3)
    const runByWorkload = new Map(
      doc.measurements.map((r) => [r.workloadId, r]),
    )
    for (const w of doc.workloads) {
      expect(runByWorkload.get(w.id)).toBeDefined()
    }

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-isolate-jobs`]).exited
  }, 30_000)

  test("per-task/group gc overrides resolve independently of the suite-wide flag", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [`${import.meta.dir}/../fixtures/bench-suite-gc.ts`],
      timeBudgetMs: 10,
      minSamples: 3,
      outDir: `${OUT_DIR}-gc-mixed`,
    })

    const byLabel = new Map(doc.workloads.map((w) => [w.label, w]))
    const fingerprintFor = (label: string) =>
      doc.measurements.find((r) => r.workloadId === byLabel.get(label)!.id)!
        .configFingerprint

    // "plain" (gc: false, resolved) and "g-gc/a" (gc: true via its group) must
    // fingerprint differently even though neither set a suite-wide --gc.
    expect(fingerprintFor("plain")).not.toBe(fingerprintFor("g-gc/a"))
    expect(fingerprintFor("solo-gc")).toBe(fingerprintFor("g-gc/a"))
    // task-level gc: false overrides the enclosing group's gc: true
    expect(fingerprintFor("g-gc/b")).toBe(fingerprintFor("plain"))

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-gc-mixed`]).exited
  }, 30_000)

  test("a suite that needs a preload-installed global fails without --preload", async () => {
    await expect(
      bench({
        suites: [`${import.meta.dir}/../fixtures/bench-suite-needs-dom.ts`],
        timeBudgetMs: 10,
        minSamples: 3,
        outDir: `${OUT_DIR}-preload-missing`,
      }),
    ).rejects.toThrow()

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-preload-missing`]).exited
  }, 20_000)

  test("--preload runs before the suite file loads, in the same subprocess", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [`${import.meta.dir}/../fixtures/bench-suite-needs-dom.ts`],
      timeBudgetMs: 10,
      minSamples: 3,
      preload: [`${import.meta.dir}/../fixtures/bench-preload-dom-setup.ts`],
      outDir: `${OUT_DIR}-preload-dom`,
    })

    expect(doc.workloads.map((w) => w.label)).toEqual(["reads-document-title"])

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-preload-dom`]).exited
  }, 20_000)

  test("multiple --preload scripts run in order, sharing state with each other and the suite", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [`${import.meta.dir}/../fixtures/bench-suite-preload-order.ts`],
      timeBudgetMs: 10,
      minSamples: 3,
      preload: [
        `${import.meta.dir}/../fixtures/bench-preload-order-a.ts`,
        `${import.meta.dir}/../fixtures/bench-preload-order-b.ts`,
      ],
      outDir: `${OUT_DIR}-preload-order`,
    })

    expect(doc.workloads.map((w) => w.label)).toEqual(["order-check"])

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-preload-order`]).exited
  }, 20_000)

  test("a suite that needs a --bun-flags-defined constant fails without it", async () => {
    await expect(
      bench({
        suites: [
          `${import.meta.dir}/../fixtures/bench-suite-needs-bun-flag.ts`,
        ],
        timeBudgetMs: 10,
        minSamples: 3,
        outDir: `${OUT_DIR}-bun-flags-missing`,
      }),
    ).rejects.toThrow()

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-bun-flags-missing`]).exited
  }, 20_000)

  test("--bun-flags passes extra flags through to the bun invocation", async () => {
    const doc = await bench({
      noiseCheck: false,
      suites: [`${import.meta.dir}/../fixtures/bench-suite-needs-bun-flag.ts`],
      timeBudgetMs: 10,
      minSamples: 3,
      bunFlags: ["--define", 'process.env.OSTIA_BUN_FLAG_TEST:"1"'],
      outDir: `${OUT_DIR}-bun-flags-set`,
    })

    expect(doc.workloads.map((w) => w.label)).toEqual(["reads-bun-flag"])

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-bun-flags-set`]).exited
  }, 20_000)

  test("scratch IPC directory is cleaned up after a successful run", async () => {
    const runOutDir = `${OUT_DIR}-cleanup`
    await bench({
      noiseCheck: false,
      suites: [SUITE],
      timeBudgetMs: 20,
      minSamples: 5,
      outDir: runOutDir,
    })
    const stillExists =
      (await Bun.spawn(["test", "-d", `${runOutDir}/bench-tmp`]).exited) === 0
    expect(stillExists).toBe(false)

    await Bun.spawn(["rm", "-rf", runOutDir]).exited
  }, 20_000)
})

describe("bench() - noise floor (item 7)", () => {
  afterAll(async () => {
    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-noise`, `${OUT_DIR}-no-noise`])
      .exited
  })

  test("stamps environment.noise by default", async () => {
    const doc = await bench({
      suites: [SUITE],
      timeBudgetMs: 10,
      minSamples: 3,
      outDir: `${OUT_DIR}-noise`,
    })
    expect(doc.environment).toBeDefined()
    expect(doc.environment!.noise.floorPct).toBeGreaterThanOrEqual(0)
    expect(doc.environment!.cores).toBeGreaterThan(0)
  }, 20_000)

  test("noiseCheck: false skips the reference measurement", async () => {
    const doc = await bench({
      suites: [SUITE],
      timeBudgetMs: 10,
      minSamples: 3,
      noiseCheck: false,
      outDir: `${OUT_DIR}-no-noise`,
    })
    expect(doc.environment).toBeUndefined()
  }, 20_000)
})

describe("bench() - sweep() and structured params (item 8)", () => {
  test("registers one workload per cartesian point, each with distinct params and id", async () => {
    const doc = await bench({
      suites: [`${import.meta.dir}/../fixtures/bench-suite-sweep.ts`],
      timeBudgetMs: 5,
      minSamples: 3,
      noiseCheck: false,
      outDir: `${OUT_DIR}-sweep`,
    })

    expect(doc.workloads).toHaveLength(4)
    const paramsList = doc.workloads.map((w) => w.params)
    expect(paramsList).toEqual(
      expect.arrayContaining([
        { size: 100, impl: "current" },
        { size: 100, impl: "fast" },
        { size: 800, impl: "current" },
        { size: 800, impl: "fast" },
      ]),
    )
    const ids = new Set(doc.workloads.map((w) => w.id))
    expect(ids.size).toBe(4)

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-sweep`]).exited
  }, 20_000)
})

describe("bench() - before/after hooks (item 9)", () => {
  test("group before/after wrap the group's tasks; task before/after nest inside", async () => {
    const markerPath = `${import.meta.dir}/../../.ostia-test-bench-hooks-marker.json`
    await Bun.spawn(["rm", "-f", markerPath]).exited

    await bench({
      suites: [`${import.meta.dir}/../fixtures/bench-suite-hooks.ts`],
      timeBudgetMs: 5,
      minSamples: 3,
      noiseCheck: false,
      outDir: `${OUT_DIR}-hooks`,
    })

    const order = (await Bun.file(markerPath).json()) as string[]
    expect(order).toEqual([
      "group-before",
      "task-a-before",
      "task-a-after",
      "task-b-before",
      "task-b-after",
      "group-after",
    ])

    await Bun.spawn(["rm", "-rf", markerPath, `${OUT_DIR}-hooks`]).exited
  }, 20_000)
})

describe("bench() - unified timing vocabulary (item 11)", () => {
  test("samples produces an exact per-task trial count, ignoring the budget", async () => {
    const doc = await bench({
      suites: [SUITE],
      samples: 4,
      budgetMs: 1, // would otherwise be far too small to reach 4 trials
      noiseCheck: false,
      outDir: `${OUT_DIR}-vocab-samples`,
    })
    for (const m of doc.measurements) {
      expect(m.trials).toHaveLength(4)
    }
    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-vocab-samples`]).exited
  }, 20_000)

  test("configFingerprint is identical for an old-name (timeBudgetMs) and new-name (budgetMs) call with the same effective settings", async () => {
    const withOldName = await bench({
      suites: [SUITE],
      timeBudgetMs: 20,
      minSamples: 3,
      noiseCheck: false,
      outDir: `${OUT_DIR}-vocab-old`,
    })
    const withNewName = await bench({
      suites: [SUITE],
      budgetMs: 20,
      minSamples: 3,
      noiseCheck: false,
      outDir: `${OUT_DIR}-vocab-new`,
    })
    expect(withNewName.measurements.map((m) => m.configFingerprint)).toEqual(
      withOldName.measurements.map((m) => m.configFingerprint),
    )
    await Bun.spawn([
      "rm",
      "-rf",
      `${OUT_DIR}-vocab-old`,
      `${OUT_DIR}-vocab-new`,
    ]).exited
  }, 20_000)
})
