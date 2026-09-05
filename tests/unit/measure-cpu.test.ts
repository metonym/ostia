import { describe, expect, test } from "bun:test"
import { captureTaskCpuProfile } from "../../src/measure/cpu"

function hotInner(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}

describe("measure/cpu", () => {
  test("loops the task for the given window and returns cpu/jit evidence", async () => {
    const result = await captureTaskCpuProfile(() => hotInner(1_000), 30)
    expect(result.cpu.origin).toBe("jsc-profile")
    expect(result.jit.origin).toBe("jsc-profile")
    expect(result.diagnosticWallNs).toBeGreaterThan(0)
  }, 10_000)

  test("works with an async task", async () => {
    const result = await captureTaskCpuProfile(async () => {
      await Promise.resolve()
      return hotInner(100)
    }, 30)
    expect(result.cpu.origin).toBe("jsc-profile")
  }, 10_000)
})
