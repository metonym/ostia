import { describe, expect, test } from "bun:test"
import { runTimingPhase } from "../../src/measure/timing"
import { runPrepare, runTrial } from "../../src/spawn/index"

describe("spawn - timeoutMs", () => {
  test("runTrial kills a hung process with SIGKILL and resolves (not rejects) with exitCode: null, timedOut: true", async () => {
    const start = Bun.nanoseconds()
    const result = await runTrial({
      argv: ["bun", "-e", "await Bun.sleep(5000)"],
      timeoutMs: 200,
    })
    const elapsedMs = (Bun.nanoseconds() - start) / 1e6
    expect(elapsedMs).toBeLessThan(1000)
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
  }, 10_000)

  test("runTrial with no timeoutMs never times out a fast command", async () => {
    const result = await runTrial({ argv: ["bun", "-e", "1"] })
    expect(result.timedOut).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })

  test("runPrepare kills a hung command-form hook and throws a clear timeout error", async () => {
    await expect(
      runPrepare(
        ["bun", "-e", "await Bun.sleep(5000)"],
        { phase: "timing", index: 0 },
        { timeoutMs: 200 },
      ),
    ).rejects.toThrow(/timed out after 200ms before timing trial 0/)
  }, 10_000)

  test("a timing phase where every trial times out has no timing stats and carries a timeout warning", async () => {
    const result = await runTimingPhase({
      argv: ["bun", "-e", "await Bun.sleep(5000)"],
      samples: 2,
      warmup: 0,
      timeoutMs: 200,
    })
    expect(result.timing).toBeUndefined()
    expect(result.trials).toHaveLength(2)
    for (const t of result.trials) expect(t.timedOut).toBe(true)
    const warning = result.warnings.find((w) => w.code === "timeout")
    expect(warning).toBeDefined()
    expect(warning?.data).toEqual({ timeoutMs: 200, trials: 2 })
  }, 10_000)

  test("a timing phase where only some trials time out still samples the ones that finished", async () => {
    const path = `${import.meta.dir}/../../.ostia-test-timeout-${crypto.randomUUID()}.txt`
    // First trial writes the marker and returns fast; once the marker
    // exists, the command hangs instead - so trial 0 finishes and trial 1
    // times out, deterministically.
    const result = await runTimingPhase({
      argv: [
        "bun",
        "-e",
        `if (await Bun.file(${JSON.stringify(path)}).exists()) { await Bun.sleep(5000) } else { await Bun.write(${JSON.stringify(path)}, "1") }`,
      ],
      samples: 2,
      warmup: 0,
      timeoutMs: 300,
    })
    expect(result.timing).toBeDefined()
    expect(result.timing!.samples).toHaveLength(1)
    expect(result.trials).toHaveLength(2)
    expect(result.trials[0]!.timedOut).toBeUndefined()
    expect(result.trials[1]!.timedOut).toBe(true)
    const warning = result.warnings.find((w) => w.code === "timeout")
    expect(warning?.data).toEqual({ timeoutMs: 300, trials: 1 })
    await Bun.spawn(["rm", "-f", path]).exited
  }, 10_000)
})
