import { describe, expect, test } from "bun:test"
import { instructionCounter } from "../../src/measure/instructions"
import { formatInstructions } from "../../src/renderers/format"

function spin(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}

describe("instructionCounter", () => {
  test("is either a reader or a reason", () => {
    const counter = instructionCounter()
    expect(counter.read === undefined).toBe(counter.unavailable !== undefined)
    expect(instructionCounter()).toBe(counter)
  })

  test.skipIf(instructionCounter().unavailable !== undefined)(
    "counts this thread's instructions in proportion to its work",
    () => {
      const read = instructionCounter().read!
      // Median of several, past warmup: a call can still run in a lower JIT
      // tier.
      const count = (n: number) => {
        const counts = Array.from({ length: 9 }, () => {
          const before = read()
          spin(n)
          return read() - before
        })
        return counts.sort((a, b) => a - b)[4]!
      }
      for (let i = 0; i < 5; i++) count(100_000)
      const small = count(100_000)
      const large = count(400_000)
      expect(small).toBeGreaterThan(100_000)
      expect(large / small).toBeGreaterThan(3.8)
      expect(large / small).toBeLessThan(4.2)
    },
  )
})

describe("formatInstructions", () => {
  test("scales to K, M and G", () => {
    expect(formatInstructions(840)).toBe("840")
    expect(formatInstructions(12_400)).toBe("12.4K")
    expect(formatInstructions(3_020_000)).toBe("3.02M")
    expect(formatInstructions(1_250_000_000)).toBe("1.25G")
  })
})
