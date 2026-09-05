import { describe, expect, test } from "bun:test"
import { formatDuration, pickDurationUnit } from "../../src/renderers/format.ts"

describe("formatDuration - adaptive unit, ~3 significant digits", () => {
  test("picks ns/µs/ms/s so the value reads as a small number", () => {
    expect(formatDuration(3.024)).toBe("3.02 ns")
    expect(formatDuration(12_400)).toBe("12.4 µs")
    expect(formatDuration(275_800_000)).toBe("275.8 ms")
    expect(formatDuration(2_410_000_000)).toBe("2.41 s")
  })

  test("pickDurationUnit matches the unit formatDuration chooses on its own", () => {
    expect(pickDurationUnit(3.024)).toBe("ns")
    expect(pickDurationUnit(12_400)).toBe("µs")
    expect(pickDurationUnit(275_800_000)).toBe("ms")
    expect(pickDurationUnit(2_410_000_000)).toBe("s")
  })

  test("an explicit unit forces smaller/larger values onto the same scale", () => {
    // A min far below the median still renders in the median's unit (ms),
    // so a Range column lines up with its row's Median column.
    expect(formatDuration(50_000, "ms")).toBe("0.05 ms")
    expect(formatDuration(9_000_000_000, "ms")).toBe("9000.0 ms")
  })
})
