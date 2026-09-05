import { describe, expect, test } from "bun:test"
import { createTimingPhase, runTimingPhase } from "../../src/measure/timing"

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
