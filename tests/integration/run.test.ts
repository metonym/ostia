import { describe, expect, test } from "bun:test"
import { run, time } from "../../src/index.ts"

const FIXTURE = `${import.meta.dir}/../fixtures/work.ts`

describe("time() - timing phase, real spawned trials", () => {
  test("produces a well-formed ProfileDocument for a single workload", async () => {
    const doc = await time({
      commands: [`bun ${FIXTURE}`],
      runs: 5,
      warmup: 1,
      noiseCheck: false,
    })

    expect(doc.schemaVersion).toBe(2)
    expect(doc.bunVersion).toBe(Bun.version)
    expect(doc.workloads).toHaveLength(1)
    expect(doc.measurements).toHaveLength(1)

    const workload = doc.workloads[0]!
    expect(workload.kind).toBe("subprocess")
    expect(workload.command).toEqual(["bun", FIXTURE])

    const run0 = doc.measurements[0]!
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
    const doc = await time({
      commands: [`bun ${FIXTURE}`, `bun -e "1+1"`],
      runs: 3,
      warmup: 0,
      noiseCheck: false,
    })

    expect(doc.workloads).toHaveLength(2)
    expect(doc.measurements).toHaveLength(2)
    const [wa, wb] = doc.workloads as [
      (typeof doc.workloads)[0],
      (typeof doc.workloads)[0],
    ]
    expect(wa.id).not.toBe(wb.id)

    const docAgain = await time({
      commands: [`bun ${FIXTURE}`],
      runs: 1,
      warmup: 0,
      noiseCheck: false,
    })
    expect(docAgain.workloads[0]!.id).toBe(wa.id)
  }, 20_000)

  test("records a non-zero exit code without throwing", async () => {
    const doc = await time({
      commands: [["bun", "-e", "process.exit(1)"]],
      runs: 2,
      warmup: 0,
      noiseCheck: false,
    })
    const run0 = doc.measurements[0]!
    expect(run0.trials.every((t) => t.exitCode === 1)).toBe(true)
  }, 20_000)

  test("the deprecated run() alias still works", async () => {
    const doc = await run({
      commands: [`bun ${FIXTURE}`],
      runs: 1,
      warmup: 0,
      noiseCheck: false,
    })
    expect(doc.measurements).toHaveLength(1)
  }, 20_000)
})

describe("time() - noise floor (item 7)", () => {
  test("stamps environment.noise by default", async () => {
    const doc = await time({
      commands: [`bun ${FIXTURE}`],
      runs: 2,
      warmup: 0,
    })
    expect(doc.environment).toBeDefined()
    expect(doc.environment!.noise.floorPct).toBeGreaterThanOrEqual(0)
    expect(doc.environment!.cores).toBeGreaterThan(0)
  }, 20_000)

  test("noiseCheck: false skips the reference measurement", async () => {
    const doc = await time({
      commands: [`bun ${FIXTURE}`],
      runs: 2,
      warmup: 0,
      noiseCheck: false,
    })
    expect(doc.environment).toBeUndefined()
  }, 20_000)
})

describe("time() - unified timing vocabulary (item 11)", () => {
  test("samples produces the same trial count as the deprecated runs", async () => {
    const doc = await time({
      commands: [`bun ${FIXTURE}`],
      samples: 4,
      warmup: 0,
      noiseCheck: false,
    })
    expect(doc.measurements[0]!.trials).toHaveLength(4)
  }, 20_000)

  test("configFingerprint is identical for an old-name (runs) and new-name (samples) call with the same effective settings", async () => {
    const withOldName = await time({
      commands: [`bun ${FIXTURE}`],
      runs: 3,
      warmup: 0,
      noiseCheck: false,
    })
    const withNewName = await time({
      commands: [`bun ${FIXTURE}`],
      samples: 3,
      warmup: 0,
      noiseCheck: false,
    })
    expect(withNewName.measurements[0]!.configFingerprint).toBe(
      withOldName.measurements[0]!.configFingerprint,
    )
  }, 20_000)

  test("budgetMs runs a min-total-time loop like the default, for at least the given budget", async () => {
    const doc = await time({
      commands: [`bun ${FIXTURE}`],
      budgetMs: 200,
      warmup: 0,
      noiseCheck: false,
    })
    const totalNs = doc.measurements[0]!.trials.reduce(
      (sum, t) => sum + t.wallNs,
      0,
    )
    expect(totalNs).toBeGreaterThanOrEqual(200 * 1e6 * 0.9) // small slack
  }, 20_000)
})

describe("time() - interleaved trials for multi-command runs (item 14)", () => {
  const MARKER = `${import.meta.dir}/../fixtures/interleave-marker.ts`

  test("round-robins trials across commands by default with 2+ commands", async () => {
    const logPath = `${import.meta.dir}/../../.ostia-test-interleave-default.log`
    await Bun.spawn(["rm", "-f", logPath]).exited

    const doc = await time({
      commands: [
        ["bun", MARKER, "a", logPath],
        ["bun", MARKER, "b", logPath],
      ],
      runs: 3,
      warmup: 0,
      noiseCheck: false,
    })

    const log = await Bun.file(logPath).text()
    expect(log.trim().split("\n")).toEqual(["a", "b", "a", "b", "a", "b"])
    expect(doc.measurements.every((m) => m.interleaved === true)).toBe(true)

    await Bun.spawn(["rm", "-f", logPath]).exited
  }, 20_000)

  test("--no-interleave (interleave: false) runs each command's loop to completion first", async () => {
    const logPath = `${import.meta.dir}/../../.ostia-test-interleave-off.log`
    await Bun.spawn(["rm", "-f", logPath]).exited

    const doc = await time({
      commands: [
        ["bun", MARKER, "a", logPath],
        ["bun", MARKER, "b", logPath],
      ],
      runs: 3,
      warmup: 0,
      interleave: false,
      noiseCheck: false,
    })

    const log = await Bun.file(logPath).text()
    expect(log.trim().split("\n")).toEqual(["a", "a", "a", "b", "b", "b"])
    expect(doc.measurements.every((m) => m.interleaved === undefined)).toBe(
      true,
    )

    await Bun.spawn(["rm", "-f", logPath]).exited
  }, 20_000)

  test("a single command is never interleaved even by default", async () => {
    const doc = await time({
      commands: [`bun ${FIXTURE}`],
      runs: 3,
      warmup: 0,
      noiseCheck: false,
    })
    expect(doc.measurements[0]!.interleaved).toBeUndefined()
  }, 20_000)
})
