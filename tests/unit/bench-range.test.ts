import { describe, expect, test } from "bun:test"
import { range } from "../../src/bench/range"

describe("bench/range", () => {
  test("defaults to multiplier 8", () => {
    expect(range(100, 10_000)).toEqual([100, 800, 6400, 10_000])
  })

  test("always includes the end point even when overshot", () => {
    expect(range(100, 100_000)).toEqual([100, 800, 6400, 51_200, 100_000])
  })

  test("does not duplicate end when a step lands on it exactly", () => {
    expect(range(100, 800)).toEqual([100, 800])
  })

  test("single point when start === end", () => {
    expect(range(100, 100)).toEqual([100])
  })

  test("honors a custom multiplier", () => {
    expect(range(3, 10, 2)).toEqual([3, 6, 10])
  })

  test("rejects a multiplier that would never terminate", () => {
    expect(() => range(100, 10_000, 1)).toThrow(RangeError)
  })

  test("rejects a non-positive start that would never terminate", () => {
    expect(() => range(0, 10_000)).toThrow(RangeError)
  })
})
