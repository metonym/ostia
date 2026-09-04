import { describe, expect, test } from "bun:test"
import { measureTask } from "../../src/measure/inprocess"

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

  test("warnings property exists and is an array", async () => {
    const result = await measureTask(() => 1, {
      timeBudgetMs: 15,
      minSamples: 5,
    })
    expect(Array.isArray(result.warnings)).toBe(true)
  })
})
