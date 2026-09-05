import { afterAll, describe, expect, test } from "bun:test"
import { profile, time } from "../../src/index.ts"

const FIXTURE = `${import.meta.dir}/../fixtures/work.ts`
const OUT_DIR = `${import.meta.dir}/../../.ostia-test-capture`

describe("capture - real subprocess CPU/heap trials", () => {
  afterAll(async () => {
    await Bun.spawn(["rm", "-rf", OUT_DIR]).exited
  })

  test("--cpu produces a labeled, instrumented CpuEvidence run with an artifact on disk", async () => {
    const doc = await time({
      commands: [`bun ${FIXTURE}`],
      runs: 3,
      warmup: 1,
      cpu: true,
      cpuIntervalUs: 100,
      outDir: OUT_DIR,
    })

    const timingRun = doc.measurements.find((r) => r.phase === "timing")!
    const cpuRun = doc.measurements.find((r) => r.phase === "cpu")!
    expect(timingRun).toBeDefined()
    expect(cpuRun).toBeDefined()
    expect(cpuRun.instrumented).toBe(true)
    expect(timingRun.trials).toHaveLength(3)
    expect(cpuRun.trials).toHaveLength(1)

    expect(cpuRun.cpu).toBeDefined()
    expect(cpuRun.cpu!.origin).toBe("cpu-prof")
    expect(cpuRun.cpu!.samplingIntervalUs).toBe(100)
    expect(cpuRun.cpu!.frames.length).toBeGreaterThan(0)
    expect(cpuRun.cpu!.totals.length).toBeGreaterThan(0)

    const hotFrame = cpuRun.cpu!.totals.find(
      (t) => cpuRun.cpu!.frames[t.frameIx]?.name === "hotInner",
    )
    expect(hotFrame).toBeDefined()
    expect(hotFrame!.selfUs).toBeGreaterThan(0)

    expect(cpuRun.artifacts).toHaveLength(1)
    const artifact = cpuRun.artifacts[0]!
    expect(artifact.kind).toBe("cpuprofile")
    expect(artifact.bytes).toBeGreaterThan(0)
    expect(await Bun.file(artifact.path).exists()).toBe(true)
  }, 20_000)

  test("--heap produces a HeapEvidence summary with a snapshot artifact on disk", async () => {
    const doc = await time({
      commands: [`bun ${FIXTURE}`],
      runs: 1,
      warmup: 0,
      heap: true,
      outDir: OUT_DIR,
    })

    const heapRun = doc.measurements.find((r) => r.phase === "heap")!
    expect(heapRun).toBeDefined()
    expect(heapRun.instrumented).toBe(true)
    expect(heapRun.heap).toBeDefined()
    expect(heapRun.heap!.origin).toBe("heap-prof")
    expect(heapRun.heap!.objectCount).toBeGreaterThan(0)
    expect(heapRun.heap!.typeCounts.length).toBeGreaterThan(0)

    const artifact = heapRun.artifacts[0]!
    expect(artifact.kind).toBe("heapsnapshot")
    expect(await Bun.file(artifact.path).exists()).toBe(true)
  }, 20_000)

  test("timing run carries free per-trial memory evidence from resourceUsage()", async () => {
    const doc = await time({ commands: [`bun ${FIXTURE}`], runs: 3, warmup: 0 })
    const timingRun = doc.measurements.find((r) => r.phase === "timing")!
    expect(timingRun.memory).toBeDefined()
    expect(timingRun.memory!.origin).toBe("resourceUsage")
    expect(timingRun.memory!.maxRssBytes).toBeGreaterThan(0)
  }, 20_000)

  test("a non-bun workload warns artifact-missing instead of throwing", async () => {
    const doc = await time({
      commands: [["sleep", "0.05"]],
      runs: 1,
      warmup: 0,
      cpu: true,
      outDir: OUT_DIR,
    })
    const cpuRun = doc.measurements.find((r) => r.phase === "cpu")!
    expect(cpuRun.cpu).toBeUndefined()
    expect(cpuRun.warnings.some((w) => w.code === "artifact-missing")).toBe(
      true,
    )
  }, 20_000)
})

describe("profile() - in-process windowed capture via node:inspector", () => {
  test("captures CPU evidence around a synchronous function and returns its result", async () => {
    function hotLoop(): number {
      let acc = 0
      for (let i = 0; i < 2_000_000; i++) acc = (acc + i) % 1000000007
      return acc
    }

    const { result, run: capturedRun } = await profile(hotLoop, {
      intervalUs: 100,
    })

    expect(typeof result).toBe("number")
    expect(capturedRun.phase).toBe("cpu")
    expect(capturedRun.instrumented).toBe(true)
    expect(capturedRun.cpu).toBeDefined()
    expect(capturedRun.cpu!.origin).toBe("inspector")
    expect(capturedRun.cpu!.frames.length).toBeGreaterThan(0)
  }, 10_000)

  test("workload id is stable for the same function source across calls", async () => {
    function stableFn(): number {
      return 42
    }
    const a = await profile(stableFn)
    const b = await profile(stableFn)
    expect(a.run.workloadId).toBe(b.run.workloadId)
  }, 10_000)
})
