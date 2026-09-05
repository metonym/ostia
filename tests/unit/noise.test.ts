import { describe, expect, test } from "bun:test"
import {
  computeNoiseFloor,
  measureNoiseFloor,
} from "../../src/measure/noise.ts"

describe("computeNoiseFloor - mad/median on fixed synthetic samples", () => {
  test("a perfectly steady reference workload has a 0% floor", () => {
    const samples = Array.from({ length: 50 }, () => 1_000)
    const floor = computeNoiseFloor(samples)
    expect(floor.floorPct).toBe(0)
    expect(floor.referenceMedianNs).toBe(1_000)
    expect(floor.samples).toBe(50)
  })

  test("known mad/median ratio on 1..100 (mad=25, median=50.5 -> ~49.5%)", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    const floor = computeNoiseFloor(samples)
    expect(floor.referenceMedianNs).toBe(50.5)
    expect(floor.floorPct).toBeCloseTo((25 / 50.5) * 100, 6)
  })

  test("a noisier sample set reports a higher floorPct than a steadier one", () => {
    const steady = Array.from({ length: 40 }, (_, i) => 1_000 + (i % 2))
    const noisy = Array.from({ length: 40 }, (_, i) => 1_000 + (i % 2) * 200)
    expect(computeNoiseFloor(noisy).floorPct).toBeGreaterThan(
      computeNoiseFloor(steady).floorPct,
    )
  })
})

describe("measureNoiseFloor - real reference workload", () => {
  test("runs for roughly the requested budget and returns a sane floor", () => {
    const floor = measureNoiseFloor(20)
    expect(floor.samples).toBeGreaterThan(0)
    expect(floor.referenceMedianNs).toBeGreaterThan(0)
    expect(floor.floorPct).toBeGreaterThanOrEqual(0)
  }, 5_000)
})
