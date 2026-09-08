import { describe, expect, test } from "bun:test"
import { CliUsageError, parseIntFlag } from "../../src/cli/main.ts"

describe("parseIntFlag", () => {
  test("parses a valid integer", () => {
    expect(parseIntFlag("--samples", "25", { min: 1 })).toBe(25)
  })

  test("rejects a non-numeric value", () => {
    expect(() => parseIntFlag("--samples", "abc", { min: 1 })).toThrow(
      CliUsageError,
    )
    expect(() => parseIntFlag("--samples", "abc", { min: 1 })).toThrow(
      `Invalid --samples "abc": expected an integer ≥ 1`,
    )
  })

  test("rejects a value below min", () => {
    expect(() => parseIntFlag("--samples", "0", { min: 1 })).toThrow(
      CliUsageError,
    )
  })

  test("rejects a non-integer value", () => {
    expect(() => parseIntFlag("--warmup", "1.5", { min: 0 })).toThrow(
      CliUsageError,
    )
  })

  test("allows the floor value itself", () => {
    expect(parseIntFlag("--warmup", "0", { min: 0 })).toBe(0)
  })

  test("defaults min to 1 when not given", () => {
    expect(() => parseIntFlag("--min-samples", "0", {})).toThrow(CliUsageError)
  })

  test("allowAuto accepts the literal auto, resolved to a job count", () => {
    expect(
      parseIntFlag("--jobs", "auto", { min: 1, allowAuto: true }),
    ).toBeGreaterThanOrEqual(1)
  })

  test("allowAuto still rejects other non-numeric values", () => {
    expect(() =>
      parseIntFlag("--jobs", "x", { min: 1, allowAuto: true }),
    ).toThrow(CliUsageError)
  })
})
