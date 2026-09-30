import { describe, expect, test } from "bun:test"
import {
  captureTaskCpuProfile,
  cpuWindowMs,
  jitColdWarning,
} from "../../src/measure/cpu"
import { cpuSampleCount } from "../../src/renderers/format"

function hotInner(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}

describe("measure/cpu", () => {
  test("samples at 100µs by default, for about 2,000 samples", async () => {
    const result = await captureTaskCpuProfile(() => hotInner(1_000))
    expect(result.cpu.origin).toBe("jsc-profile")
    expect(result.cpu.samplingIntervalUs).toBe(100)
    expect(result.jit.origin).toBe("jsc-profile")
    expect(result.diagnosticWallNs).toBeGreaterThan(300e6)
    // The target is 2,000; a loaded machine samples less often than asked.
    expect(cpuSampleCount(result.cpu)).toBeGreaterThan(1000)
  }, 10_000)

  test("works with an async task", async () => {
    const result = await captureTaskCpuProfile(
      async () => {
        await Promise.resolve()
        return hotInner(100)
      },
      { intervalUs: 10 },
    )
    expect(result.cpu.origin).toBe("jsc-profile")
    expect(result.cpu.samplingIntervalUs).toBe(10)
  }, 10_000)

  test("warns low-sample-count when the task barely runs JS during the capture", async () => {
    const result = await captureTaskCpuProfile(() => Bun.sleep(50), {
      intervalUs: 10,
    })
    const warning = result.warnings.find((w) => w.code === "low-sample-count")
    expect(warning).toBeDefined()
    expect(warning!.data).toMatchObject({ target: 2000, intervalUs: 10 })
  }, 10_000)
})

describe("cpuWindowMs", () => {
  test("sized for 2,000 samples at twice the interval, within 200ms..10s", () => {
    expect(cpuWindowMs(100)).toBe(400)
    expect(cpuWindowMs(1000)).toBe(4000)
    expect(cpuWindowMs(10)).toBe(200)
    expect(cpuWindowMs(100_000)).toBe(10_000)
  })
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
