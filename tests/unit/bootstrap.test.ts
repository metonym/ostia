import { describe, expect, test } from "bun:test"
import { bootstrapMedianDiffCi, mulberry32 } from "../../src/stats/bootstrap.ts"

describe("mulberry32", () => {
  test("is deterministic for a given seed", () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = Array.from({ length: 5 }, () => a())
    const seqB = Array.from({ length: 5 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  test("produces values in [0, 1)", () => {
    const rng = mulberry32(1)
    for (let i = 0; i < 100; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  test("different seeds diverge", () => {
    const a = mulberry32(1)()
    const b = mulberry32(2)()
    expect(a).not.toBe(b)
  })
})

describe("bootstrapMedianDiffCi", () => {
  test("is reproducible for a fixed seed", () => {
    const base = [10_000, 10_100, 9_900, 10_050, 9_950, 10_020]
    const cand = [11_000, 11_100, 10_900, 11_050, 10_950, 11_020]
    const a = bootstrapMedianDiffCi(base, cand, { seed: 7 })
    const b = bootstrapMedianDiffCi(base, cand, { seed: 7 })
    expect(a.ci95).toEqual(b.ci95)
    expect(a.seed).toBe(7)
  })

  test("identical distributions give a CI straddling 0", () => {
    const samples = Array.from({ length: 40 }, (_, i) => 10_000 + (i % 6) * 10)
    const result = bootstrapMedianDiffCi(samples, [...samples], { seed: 1 })
    expect(result.ci95[0]).toBeLessThanOrEqual(0)
    expect(result.ci95[1]).toBeGreaterThanOrEqual(0)
  })

  test("a clearly shifted distribution gives a CI entirely above 0", () => {
    const base = Array.from({ length: 40 }, (_, i) => 10_000 + (i % 6) * 10)
    const cand = Array.from({ length: 40 }, (_, i) => 13_000 + (i % 6) * 10)
    const result = bootstrapMedianDiffCi(base, cand, { seed: 1 })
    expect(result.ci95[0]).toBeGreaterThan(0)
    expect(result.ci95[1]).toBeGreaterThan(0)
  })

  test("notes when either side was subsampled to the 2000-sample cap", () => {
    const base = Array.from({ length: 5000 }, (_, i) => 10_000 + (i % 100))
    const cand = Array.from({ length: 100 }, (_, i) => 10_000 + (i % 10))
    const result = bootstrapMedianDiffCi(base, cand, {
      seed: 1,
      iterations: 50,
    })
    expect(result.data.subsampled).toBe(true)
  })

  test("does not subsample when both sides are at or under the cap", () => {
    const base = Array.from({ length: 100 }, (_, i) => 10_000 + i)
    const cand = Array.from({ length: 100 }, (_, i) => 10_050 + i)
    const result = bootstrapMedianDiffCi(base, cand, {
      seed: 1,
      iterations: 50,
    })
    expect(result.data.subsampled).toBe(false)
  })
})
