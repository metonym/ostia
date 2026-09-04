import { describe, expect, test } from "bun:test"
import { run } from "../../src/index.ts"

const FIXTURE = `${import.meta.dir}/../fixtures/work.ts`

describe("run() - timing phase, real spawned trials", () => {
  test("produces a well-formed ProfileDocument for a single workload", async () => {
    const doc = await run({ commands: [`bun ${FIXTURE}`], runs: 5, warmup: 1 })

    expect(doc.schemaVersion).toBe(1)
    expect(doc.bunVersion).toBe(Bun.version)
    expect(doc.workloads).toHaveLength(1)
    expect(doc.runs).toHaveLength(1)

    const workload = doc.workloads[0]!
    expect(workload.kind).toBe("subprocess")
    expect(workload.command).toEqual(["bun", FIXTURE])

    const run0 = doc.runs[0]!
    expect(run0.workloadId).toBe(workload.id)
    expect(run0.phase).toBe("timing")
    expect(run0.instrumented).toBe(false)
    expect(run0.trials).toHaveLength(5)

    for (const [i, trial] of run0.trials.entries()) {
      expect(trial.i).toBe(i)
      expect(trial.wallNs).toBeGreaterThan(0)
      expect(trial.exitCode).toBe(0)
    }

    expect(run0.timing).toBeDefined()
    expect(run0.timing!.samples).toHaveLength(5)
    expect(run0.timing!.mean).toBeGreaterThan(0)
    expect(run0.timing!.min).toBeLessThanOrEqual(run0.timing!.median)
    expect(run0.timing!.max).toBeGreaterThanOrEqual(run0.timing!.median)
  }, 20_000)

  test("runs multiple workloads independently with stable, distinct IDs", async () => {
    const doc = await run({
      commands: [`bun ${FIXTURE}`, `bun -e "1+1"`],
      runs: 3,
      warmup: 0,
    })

    expect(doc.workloads).toHaveLength(2)
    expect(doc.runs).toHaveLength(2)
    const [wa, wb] = doc.workloads as [
      (typeof doc.workloads)[0],
      (typeof doc.workloads)[0],
    ]
    expect(wa.id).not.toBe(wb.id)

    const docAgain = await run({
      commands: [`bun ${FIXTURE}`],
      runs: 1,
      warmup: 0,
    })
    expect(docAgain.workloads[0]!.id).toBe(wa.id)
  }, 20_000)

  test("records a non-zero exit code without throwing", async () => {
    const doc = await run({
      commands: [["bun", "-e", "process.exit(1)"]],
      runs: 2,
      warmup: 0,
    })
    const run0 = doc.runs[0]!
    expect(run0.trials.every((t) => t.exitCode === 1)).toBe(true)
  }, 20_000)
})
