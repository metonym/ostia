import { describe, expect, test } from "bun:test"
import { measureAllocPerOp } from "../../src/measure/alloc"

describe("measure/alloc", () => {
  test("reports bytesPerOp for a task that allocates", async () => {
    const result = await measureAllocPerOp(() => {
      const arr = new Array(1000).fill(0)
      return arr.length
    }, 20)
    expect(result.memory.origin).toBe("heapStats")
    expect(result.memory.bytesPerOp).toBeGreaterThanOrEqual(0)
    expect(result.diagnosticWallNs).toBeGreaterThan(0)
  })

  test("works with an async task", async () => {
    const result = await measureAllocPerOp(async () => {
      await Promise.resolve()
      return 1
    }, 10)
    expect(result.memory.origin).toBe("heapStats")
  })
})
