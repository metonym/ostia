import { describe, expect, test } from "bun:test"
import {
  defaultSampleFloor,
  keep,
  measureTask,
  rigorFloor,
} from "../../src/measure/inprocess"

function spin(ms: number): number {
  const end = Bun.nanoseconds() + ms * 1e6
  let acc = 0
  while (Bun.nanoseconds() < end) acc = (acc + 1) | 0
  return acc
}

describe("measure/inprocess", () => {
  test("respects minSamples and produces trial wall times", async () => {
    const result = await measureTask(() => 1 + 1, {
      timeBudgetMs: 20,
      minSamples: 5,
    })
    expect(result.trials.length).toBeGreaterThanOrEqual(5)
    const sampleSize = Math.min(result.trials.length, 50)
    for (let i = 0; i < sampleSize; i++) {
      expect(result.trials[i]!.i).toBe(i)
      expect(typeof result.trials[i]!.wallNs).toBe("number")
      expect(result.trials[i]!.wallNs).toBeGreaterThanOrEqual(0)
    }
    expect(result.timing.samples.length).toBe(result.trials.length)
    expect(result.timing.unit).toBe("ns")
  })

  test("handles async functions", async () => {
    const result = await measureTask(
      async () => {
        await Promise.resolve()
        return 42
      },
      { timeBudgetMs: 20, minSamples: 5 },
    )
    expect(result.trials.length).toBeGreaterThanOrEqual(5)
    expect(result.timing.samples.length).toBeGreaterThanOrEqual(5)
  })

  test("measures timing differences between fast and slow functions", async () => {
    const trivialResult = await measureTask(() => 1, {
      timeBudgetMs: 20,
      minSamples: 5,
    })

    const slowResult = await measureTask(
      () => {
        let acc = 0
        for (let i = 0; i < 200_000; i++) acc += i
        return acc
      },
      { timeBudgetMs: 20, minSamples: 5 },
    )

    expect(slowResult.timing.median).toBeGreaterThan(
      trivialResult.timing.median * 5,
    )
  })

  test("handles various return types without crashing", async () => {
    const undefinedResult = await measureTask(() => undefined, {
      timeBudgetMs: 10,
      minSamples: 3,
    })
    expect(undefinedResult.trials.length).toBeGreaterThanOrEqual(3)

    const nullResult = await measureTask(() => null, {
      timeBudgetMs: 10,
      minSamples: 3,
    })
    expect(nullResult.trials.length).toBeGreaterThanOrEqual(3)

    const objResult = await measureTask(() => ({ x: 1 }), {
      timeBudgetMs: 10,
      minSamples: 3,
    })
    expect(objResult.trials.length).toBeGreaterThanOrEqual(3)

    const strResult = await measureTask(() => "hello", {
      timeBudgetMs: 10,
      minSamples: 3,
    })
    expect(strResult.trials.length).toBeGreaterThanOrEqual(3)
  })

  test("gc option resolves without error", async () => {
    const result = await measureTask(() => 1, {
      timeBudgetMs: 10,
      minSamples: 3,
      gc: true,
    })
    expect(result.trials.length).toBeGreaterThanOrEqual(3)
    expect(Array.isArray(result.trials)).toBe(true)
  })

  test("a sub-microsecond task is batched so a budget yields bounded trials", async () => {
    const result = await measureTask(() => 1, { timeBudgetMs: 100 })
    // Target is ~10k per full budget; allow JIT tier-up mid-run to overshoot it.
    expect(result.trials.length).toBeLessThan(100_000)
    expect(result.trials.length).toBeGreaterThanOrEqual(3)
  })

  test("default sample floor is cost-aware: a slow task does not overrun the budget by 20x", async () => {
    const callMs = 20
    const start = Bun.nanoseconds()
    const result = await measureTask(() => spin(callMs), { timeBudgetMs: 100 })
    const totalMs = (Bun.nanoseconds() - start) / 1e6
    // Budget fits 5 calls; the old rule forced 20 (400ms+).
    expect(result.trials.length).toBeGreaterThanOrEqual(3)
    expect(result.trials.length).toBeLessThan(10)
    expect(totalMs).toBeLessThan(300)
  })

  test("rigor floor rises two samples per decade of per-trial cost, 3..10", () => {
    const ms = 1e6
    expect(rigorFloor(30)).toBe(3) // 30ns
    expect(rigorFloor(50_000)).toBe(3) // 50µs
    expect(rigorFloor(1 * ms)).toBe(3)
    expect(rigorFloor(10 * ms)).toBe(5)
    expect(rigorFloor(100 * ms)).toBe(7)
    expect(rigorFloor(140 * ms)).toBe(7)
    expect(rigorFloor(1_000 * ms)).toBe(9)
    expect(rigorFloor(2_400 * ms)).toBe(10)
    expect(rigorFloor(60_000 * ms)).toBe(10)
  })

  test("default floor: budget-fit (max 20) for cheap tasks, rigor floor for expensive ones", () => {
    const ms = 1e6
    const budget = 500 * ms
    // 30ns/call, batched: thousands fit, floor caps at 20 (the loop is time-bound anyway).
    expect(defaultSampleFloor(1_000, budget)).toBe(20)
    // 30ms: 16 fit, above the 6 rigor floor.
    expect(defaultSampleFloor(30 * ms, budget)).toBe(16)
    // 140ms: only 3 fit, but the cost class earns 7 (was 3 under the old clamp).
    expect(defaultSampleFloor(140 * ms, budget)).toBe(7)
    // 2.4s: nothing fits; earns 10 (was 3).
    expect(defaultSampleFloor(2_400 * ms, budget)).toBe(10)
    // A tighter global budget does not lower the rigor floor.
    expect(defaultSampleFloor(2_400 * ms, 50 * ms)).toBe(10)
  })

  test("an expensive task gets its rigor floor even when the budget fits fewer", async () => {
    // ~15ms/call, 20ms budget: only 1 fits; the cost class (10..30ms) earns 5.
    const result = await measureTask(() => spin(15), { timeBudgetMs: 20 })
    expect(result.trials.length).toBeGreaterThanOrEqual(5)
    expect(result.trials.length).toBeLessThanOrEqual(7)
    expect(result.warnings.some((w) => w.code === "low-sample-count")).toBe(
      false,
    )
  })

  test("an explicit minSamples below the cost-class floor is honored but flagged low-sample-count", async () => {
    // ~15ms/call, 20ms budget, hard floor 2: ends at 2 samples (fewer than the
    // 5 the cost class earns). The policy is not overridden; it is reported.
    const result = await measureTask(() => spin(15), {
      timeBudgetMs: 20,
      minSamples: 2,
    })
    expect(result.trials.length).toBeLessThan(5)
    const warning = result.warnings.find((w) => w.code === "low-sample-count")
    expect(warning).toBeDefined()
    expect(warning!.data).toMatchObject({
      samples: result.trials.length,
      target: 5,
    })
    expect(typeof warning!.data!.trialCostNs).toBe("number")
  })

  test("a cheap task never carries low-sample-count, even with a tiny explicit floor", async () => {
    const result = await measureTask(() => 1, {
      timeBudgetMs: 10,
      minSamples: 1,
    })
    expect(result.warnings.some((w) => w.code === "low-sample-count")).toBe(
      false,
    )
  })

  test("explicit minSamples is a hard floor even past the budget", async () => {
    const result = await measureTask(() => spin(2), {
      timeBudgetMs: 5,
      minSamples: 12,
    })
    expect(result.trials.length).toBeGreaterThanOrEqual(12)
  })

  test("warmupFraction 0 still measures", async () => {
    const result = await measureTask(() => 1, {
      timeBudgetMs: 10,
      warmupFraction: 0,
    })
    expect(result.trials.length).toBeGreaterThanOrEqual(3)
  })

  test("warnings property exists and is an array", async () => {
    const result = await measureTask(() => 1, {
      timeBudgetMs: 15,
      minSamples: 5,
    })
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  test("keep() accepts numbers, objects, and nullish values without throwing", () => {
    expect(() => {
      keep(42)
      keep({ some: "object" })
      keep("a string")
      keep(undefined)
      keep(null)
    }).not.toThrow()
  })
})
