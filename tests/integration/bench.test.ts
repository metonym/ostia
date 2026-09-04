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
    })

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
