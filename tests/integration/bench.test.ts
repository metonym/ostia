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
      suites: [SUITE],
      timeBudgetMs: 50,
      minSamples: 5,
      outDir: OUT_DIR,
    })

    expect(doc.workloads).toHaveLength(3)
    expect(doc.runs).toHaveLength(3)

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
    const smallRun = doc.runs.find((r) => r.workloadId === smallWorkload.id)!
    const largeRun = doc.runs.find((r) => r.workloadId === largeWorkload.id)!
    expect(smallRun.instrumented).toBe(false)
    expect(smallRun.phase).toBe("timing")
    expect(smallRun.trials.length).toBeGreaterThanOrEqual(5)
    expect(largeRun.timing!.median).toBeGreaterThan(smallRun.timing!.median)
  }, 20_000)

  test("workload id is stable across separate bench() invocations of the same suite", async () => {
    const a = await bench({
      suites: [SUITE],
      timeBudgetMs: 20,
      minSamples: 5,
      outDir: `${OUT_DIR}-a`,
    })
    const b = await bench({
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
      suites: [`${import.meta.dir}/../fixtures/bench-suite-overrides.ts`],
      timeBudgetMs: 5,
      minSamples: 5,
      outDir: `${OUT_DIR}-overrides`,
    })
    const byLabel = new Map(doc.workloads.map((w) => [w.label, w]))
    const runOf = (label: string) =>
      doc.runs.find((r) => r.workloadId === byLabel.get(label)!.id)!
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
      suites,
      timeBudgetMs: 10,
      minSamples: 3,
      outDir: `${OUT_DIR}-jobs-1`,
    })
    const concurrent = await bench({
      suites,
      timeBudgetMs: 10,
      minSamples: 3,
      jobs: 3,
      outDir: `${OUT_DIR}-jobs-3`,
    })
    expect(concurrent.workloads.map((w) => w.label)).toEqual(
      sequential.workloads.map((w) => w.label),
    )
    expect(concurrent.runs.map((r) => r.workloadId)).toEqual(
      sequential.runs.map((r) => r.workloadId),
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

  test("scratch IPC directory is cleaned up after a successful run", async () => {
    const runOutDir = `${OUT_DIR}-cleanup`
    await bench({
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
