import { describe, expect, test } from "bun:test"
import {
  assertSamplingOptions,
  createTimingPhase,
  isHarnessFailure,
  runTimingPhase,
} from "../../src/measure/timing"

const FIXTURE = `${import.meta.dir}/../fixtures/work.ts`

describe("measure/timing - createTimingPhase", () => {
  test("step() runs trials until the exact samples count, then returns false", async () => {
    const phase = createTimingPhase({
      argv: ["bun", FIXTURE],
      samples: 3,
      warmup: 0,
    })
    expect(phase.done()).toBe(false)
    expect(await phase.step()).toBe(true)
    expect(await phase.step()).toBe(true)
    expect(await phase.step()).toBe(true)
    expect(phase.done()).toBe(true)
    expect(await phase.step()).toBe(false)

    const result = phase.result()
    expect(result.trials).toHaveLength(3)
    expect(result.trials.map((t) => t.i)).toEqual([0, 1, 2])
  }, 20_000)

  test("warmup() runs discarded trials that never appear in result()", async () => {
    const phase = createTimingPhase({
      argv: ["bun", FIXTURE],
      samples: 2,
      warmup: 2,
    })
    await phase.warmup()
    while (await phase.step()) {
      /* drain */
    }
    expect(phase.result().trials).toHaveLength(2)
  }, 20_000)

  test("runTimingPhase (warmup + drain to completion) matches createTimingPhase driven manually", async () => {
    const viaHelper = await runTimingPhase({
      argv: ["bun", FIXTURE],
      samples: 4,
      warmup: 0,
    })
    expect(viaHelper.trials).toHaveLength(4)

    const phase = createTimingPhase({
      argv: ["bun", FIXTURE],
      samples: 4,
      warmup: 0,
    })
    await phase.warmup()
    while (await phase.step()) {
      /* drain */
    }
    expect(phase.result().trials).toHaveLength(4)
  }, 20_000)

  test("without an exact samples count, done() requires both minSamples and budgetMs satisfied", async () => {
    const phase = createTimingPhase({
      argv: ["bun", FIXTURE],
      minSamples: 2,
      budgetMs: 10_000, // effectively never satisfied by 2 fast trials alone
      warmup: 0,
    })
    await phase.step()
    await phase.step()
    // minSamples (2) is met, but the huge budget isn't, so the phase isn't done.
    expect(phase.done()).toBe(false)
  }, 20_000)
})

describe("measure/timing - assertSamplingOptions", () => {
  test("rejects non-positive counts and a non-finite budget, naming the caller", () => {
    expect(() => assertSamplingOptions("time", { samples: 0 })).toThrow(
      "time: samples must be >= 1, got 0",
    )
    expect(() => assertSamplingOptions("bench", { minSamples: -1 })).toThrow(
      "bench: minSamples must be >= 1, got -1",
    )
    expect(() => assertSamplingOptions("time", { budgetMs: Infinity })).toThrow(
      "time: budgetMs must be finite",
    )
    expect(() =>
      assertSamplingOptions("time", { samples: 3, budgetMs: 100 }),
    ).not.toThrow()
  })

  test("validates warmup (>= 0) and timeoutMs (> 0)", () => {
    expect(() => assertSamplingOptions("time", { warmup: -1 })).toThrow(
      "time: warmup must be >= 0, got -1",
    )
    expect(() => assertSamplingOptions("time", { warmup: NaN })).toThrow(
      "time: warmup must be >= 0",
    )
    expect(() => assertSamplingOptions("time", { timeoutMs: 0 })).toThrow(
      "time: timeoutMs must be > 0, got 0",
    )
    expect(() => assertSamplingOptions("time", { timeoutMs: NaN })).toThrow(
      "time: timeoutMs must be > 0",
    )
    expect(() =>
      assertSamplingOptions("time", { warmup: 0, timeoutMs: 1 }),
    ).not.toThrow()
  })

  test("createTimingPhase applies it to a per-command timeoutMs", () => {
    expect(() =>
      createTimingPhase({ argv: ["bun", FIXTURE], timeoutMs: -5 }),
    ).toThrow("timeoutMs must be > 0")
  })
})

describe("measure/timing - isHarnessFailure", () => {
  const trial = (exitCode?: number, timedOut?: true) => ({
    i: 0,
    wallNs: 1,
    ...(exitCode !== undefined && { exitCode }),
    ...(timedOut && { timedOut }),
  })
  const timing = {} as never

  test("a non-ignored non-zero exit fails; an ignored one doesn't", () => {
    expect(isHarnessFailure({ trials: [trial(1)], timing })).toBe(true)
    expect(isHarnessFailure({ trials: [trial(1)], timing }, [1])).toBe(false)
  })

  test("a timed-out trial has no exit code: it fails the run only when no samples remain", () => {
    expect(
      isHarnessFailure({ trials: [trial(0), trial(undefined, true)], timing }),
    ).toBe(false)
    expect(
      isHarnessFailure({ trials: [trial(undefined, true)], timing: undefined }),
    ).toBe(true)
  })
})
