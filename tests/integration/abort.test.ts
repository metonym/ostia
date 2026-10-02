import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bench } from "../../src/bench/index.ts"
import { runCi } from "../../src/ci/index.ts"
import { baselinePath, DEFAULT_CONFIG } from "../../src/config/index.ts"
import { time } from "../../src/index.ts"
import { createDocument, saveDocument } from "../../src/ir/document.ts"

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

describe("ostia ci - AbortSignal and SIGINT", () => {
  const SLEEP = ["bun", "-e", "await Bun.sleep(30000)"]

  async function project(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ostia-ci-abort-"))
    await Bun.write(
      join(dir, "ostia.config.json"),
      JSON.stringify({
        samples: 3,
        warmup: 0,
        workloads: [
          { label: "sleepy", command: SLEEP, inputs: [] },
          { label: "never", command: ["bun", "-e", "1"] },
        ],
      }),
    )
    await saveDocument(
      createDocument([], []),
      join(dir, ".ostia/baselines/main.json"),
    )
    return dir
  }

  test("runCi resolves with a partial, uncompared document and caches nothing", async () => {
    const dir = await project()
    try {
      const config = {
        ...DEFAULT_CONFIG,
        outDir: join(dir, "out"),
        baselineDir: join(dir, "bl"),
        samples: 3,
        warmup: 0,
        noiseCheck: false,
        workloads: [
          { label: "sleepy", command: SLEEP, inputs: [] },
          { label: "never", command: ["bun", "-e", "1"] },
        ],
      }
      await saveDocument(createDocument([], []), baselinePath(config))
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 400)

      const start = Bun.nanoseconds()
      const outcome = await runCi({
        config,
        full: false,
        signal: controller.signal,
      })
      expect((Bun.nanoseconds() - start) / 1e6).toBeLessThan(5000)

      expect(outcome.aborted).toBe(true)
      expect(outcome.document.comparisons).toBeUndefined()
      // The second workload was never scheduled.
      expect(outcome.document.workloads).toHaveLength(1)
      const last = outcome.document.measurements.at(-1)!
      expect(last.warnings.some((w) => w.code === "aborted")).toBe(true)
      const cached = await readdir(config.outDir).catch(() => [])
      expect(cached).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

  test("SIGINT cancels the run, exits 130, prints the partial document and never saves a baseline", async () => {
    const dir = await project()
    try {
      const proc = Bun.spawn(
        [
          "bun",
          CLI,
          "ci",
          "--no-noise-check",
          "--format",
          "json",
          "--save-baseline",
        ],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      )
      setTimeout(() => proc.kill("SIGINT"), 800)
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ])
      expect(exitCode).toBe(130)
      const doc = JSON.parse(stdout)
      expect(doc.comparisons).toBeUndefined()
      expect(doc.workloads).toHaveLength(1)
      const baseline = await Bun.file(
        join(dir, ".ostia/baselines/main.json"),
      ).json()
      expect(baseline.workloads).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
