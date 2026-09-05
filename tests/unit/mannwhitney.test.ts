import { describe, expect, test } from "bun:test"
import { mannWhitneyU } from "../../src/stats/mannwhitney.ts"

describe("mannWhitneyU", () => {
  test("identical distributions give a high (non-significant) p-value", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const b = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const result = mannWhitneyU(a, b)
    expect(result.pValue).toBeGreaterThan(0.5)
  })

  test("fully separated samples give a small (significant) p-value", () => {
    const a = [1, 2, 3, 4, 5]
    const b = [100, 101, 102, 103, 104]
    const result = mannWhitneyU(a, b)
    expect(result.pValue).toBeLessThan(0.01)
    expect(result.u).toBe(0)
  })

  test("is symmetric: swapping the groups mirrors z but leaves p-value unchanged", () => {
    const a = [1, 2, 3, 4, 5]
    const b = [100, 101, 102, 103, 104]
    const ab = mannWhitneyU(a, b)
    const ba = mannWhitneyU(b, a)
    expect(ba.z).toBeCloseTo(-ab.z, 6)
    expect(ba.pValue).toBeCloseTo(ab.pValue, 10)
  })

  test("tie correction: ties reduce variance without crashing on all-tied input", () => {
    const a = [5, 5, 5, 5, 5]
    const b = [5, 5, 5, 5, 5]
    const result = mannWhitneyU(a, b)
    expect(result.z).toBe(0)
    expect(result.pValue).toBeCloseTo(1, 6)
  })

  test("p-value stays within [0, 1]", () => {
    const result = mannWhitneyU([1, 1, 1], [1, 1, 1, 2])
    expect(result.pValue).toBeGreaterThanOrEqual(0)
    expect(result.pValue).toBeLessThanOrEqual(1)
  })
})
