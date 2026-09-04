import { describe, expect, test } from "bun:test"
import { canonicalJSON, fp } from "../../src/ir/fp.ts"

describe("canonicalJSON", () => {
  test("produces identical strings for objects with different key insertion order", () => {
    const obj1 = { b: 1, a: 2 }
    const obj2 = { a: 2, b: 1 }

    expect(canonicalJSON(obj1)).toBe(canonicalJSON(obj2))
  })

  test("produces identical strings for nested objects with different key order", () => {
    const obj1 = { x: { d: 1, c: 2 }, y: [1, 2, 3] }
    const obj2 = { y: [1, 2, 3], x: { c: 2, d: 1 } }

    expect(canonicalJSON(obj1)).toBe(canonicalJSON(obj2))
  })

  test("preserves array element order", () => {
    const arr1 = canonicalJSON([1, 2, 3])
    const arr2 = canonicalJSON([3, 2, 1])

    expect(arr1).not.toBe(arr2)
  })
})

describe("fp", () => {
  test("returns string matching the expected format", () => {
    const result = fp("wl", "a", "b")

    expect(result).toMatch(/^wl_[0-9a-f]{16}$/)
  })

  test("is deterministic", () => {
    const result1 = fp("run", { x: 1, y: 2 })
    const result2 = fp("run", { x: 1, y: 2 })

    expect(result1).toBe(result2)
  })

  test("is sensitive to input differences", () => {
    const sameTag1 = fp("run", "a")
    const sameTag2 = fp("run", "b")
    const differentTag1 = fp("a", "x")
    const differentTag2 = fp("b", "x")

    expect(sameTag1).not.toBe(sameTag2)
    expect(differentTag1).not.toBe(differentTag2)
  })

  test("ignores key order in object parts", () => {
    const result1 = fp("t", { a: 1, b: 2 })
    const result2 = fp("t", { b: 2, a: 1 })

    expect(result1).toBe(result2)
  })
})
