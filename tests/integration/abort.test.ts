import { describe, expect, test } from "bun:test"
import { bench } from "../../src/bench/index.ts"
import { time } from "../../src/index.ts"

const CLI = `${import.meta.dir}/../../src/cli/main.ts`
const BENCH_SUITE = `${import.meta.dir}/../fixtures/bench-suite.ts`

describe("time() - AbortSignal", () => {
  test("aborting after 300ms of a 5s budget resolves promptly with at least one measurement", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)

    const start = Bun.nanoseconds()
    const doc = await time({
      commands: ["bun -e 1"],
      budgetMs: 5000,
      warmup: 0,
      signal: controller.signal,
    })
    const elapsedMs = (Bun.nanoseconds() - start) / 1e6

    expect(elapsedMs).toBeLessThan(2000)
    expect(doc.measurements.length).toBeGreaterThanOrEqual(1)
    const last = doc.measurements[doc.measurements.length - 1]!
    expect(last.warnings.some((w) => w.code === "aborted")).toBe(true)
  }, 10_000)

  test("never rejects on abort, even when aborted before the first trial", async () => {
    const controller = new AbortController()
    controller.abort()
    const doc = await time({
      commands: ["bun -e 1"],
      samples: 5,
      warmup: 0,
      signal: controller.signal,
    })
    expect(doc.measurements.length).toBe(1)
    expect(doc.measurements[0]!.timing).toBeUndefined()
    expect(
      doc.measurements[0]!.warnings.some((w) => w.code === "aborted"),
    ).toBe(true)
  })
})

describe("bench() - AbortSignal", () => {
  test("aborting mid-run kills the in-flight suite subprocess and resolves (not rejects) instead of surfacing its kill as a failure", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)

    const start = Bun.nanoseconds()
    const doc = await bench({
      suites: [BENCH_SUITE],
      budgetMs: 5000,
      signal: controller.signal,
    })
    const elapsedMs = (Bun.nanoseconds() - start) / 1e6

    expect(elapsedMs).toBeLessThan(3000)
    // Killed before it could write its result: dropped entirely rather than
    // partially represented.
    expect(doc.workloads).toEqual([])
  }, 10_000)

  test("never rejects when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const doc = await bench({
      suites: [BENCH_SUITE],
      budgetMs: 500,
      signal: controller.signal,
    })
    expect(doc.workloads).toEqual([])
    expect(doc.measurements).toEqual([])
  })
})

describe("ostia time - SIGINT", () => {
  test("SIGINT cancels the run and exits 130", async () => {
    const proc = Bun.spawn(
      ["bun", CLI, "time", "--budget", "10000", "--warmup", "0", "bun -e 1"],
      { stdout: "pipe", stderr: "pipe" },
    )
    setTimeout(() => proc.kill("SIGINT"), 300)
    const exitCode = await proc.exited
    expect(exitCode).toBe(130)
  }, 10_000)
})
