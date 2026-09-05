import { describe, expect, test } from "bun:test"
import { captureTaskCpuProfile, jitColdWarning } from "../../src/measure/cpu"

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

describe("jitColdWarning", () => {
  test("undefined when llint+baseline is at or below the 20% threshold", () => {
    const warning = jitColdWarning({
      origin: "jsc-profile",
      tiers: { llint: 5, baseline: 15, dfg: 30, ftl: 50 },
    })
    expect(warning).toBeUndefined()
  })

  test("undefined when there are zero samples", () => {
    const warning = jitColdWarning({
      origin: "jsc-profile",
      tiers: { llint: 0, baseline: 0, dfg: 0, ftl: 0 },
    })
    expect(warning).toBeUndefined()
  })

  test("fires with tier percentages when llint+baseline exceeds 20%", () => {
    const warning = jitColdWarning({
      origin: "jsc-profile",
      tiers: { llint: 30, baseline: 20, dfg: 30, ftl: 20 },
    })
    expect(warning).toBeDefined()
    expect(warning!.code).toBe("jit-cold")
    expect(warning!.data).toEqual({
      llintPct: 30,
      baselinePct: 20,
      dfgPct: 30,
      ftlPct: 20,
    })
  })
})
