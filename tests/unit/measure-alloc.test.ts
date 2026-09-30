import { describe, expect, test } from "bun:test"
import { measureAllocPerOp } from "../../src/measure/alloc"
import { measurePeakMem } from "../../src/measure/peak"

describe("measure/alloc", () => {
  test("reports bytesPerOp for a task that allocates", async () => {
    const result = await measureAllocPerOp(() => {
      const arr = new Array(1000).fill(0)
      return arr.length
    }, 20)
    expect(result.memory.origin).toBe("heapStats")
    expect(result.memory.kind).toBe("retained")
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

describe("measure/alloc - retained, not allocated", () => {
  test("a task that allocates only garbage reads near zero", async () => {
    const result = await measureAllocPerOp(() => {
      const arr = new Array(100_000).fill(1.5)
      return arr.length
    }, 20)
    // ~800KB allocated per call, all of it dropped before the second GC.
    expect(result.memory.bytesPerOp!).toBeLessThan(10_000)
  })

  test("a task that keeps what it allocates reads about that much", async () => {
    const kept: number[][] = []
    const result = await measureAllocPerOp(() => {
      kept.push(new Array(10_000).fill(1.5))
      return kept.length
    }, 20)
    expect(result.memory.bytesPerOp!).toBeGreaterThan(40_000)
  })
})

describe("measure/peak", () => {
  // Fresh processes: this one has run other tests, whose freed memory the
  // call could reuse unseen.
  async function inFreshProcess(body: string) {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `import { measurePeakMem, memorySnapshot } from "${import.meta.dir}/../../src/measure/peak.ts"
         ${body}`,
      ],
      { stdout: "pipe" },
    )
    const result = JSON.parse(await new Response(proc.stdout).text())
    expect(await proc.exited).toBe(0)
    return result
  }

  test("sees a call's transient allocation that --alloc can't", async () => {
    const result = await inFreshProcess(`
      const since = memorySnapshot()
      console.log(JSON.stringify(await measurePeakMem(() => new Array(5_000_000).fill(1.5).length, since)))`)
    expect(result.peakBytes).toBeGreaterThan(30 * 1024 * 1024)
    expect(result.slackBytes).toBeLessThan(16 * 1024 * 1024)
    expect(result.wallNs).toBeGreaterThan(0)
  }, 20_000)

  test("sees the call, or reports the slack, after earlier work peaked higher", async () => {
    const result = await inFreshProcess(`
      const since = memorySnapshot()
      new Array(8_000_000).fill(1.5)
      console.log(JSON.stringify(await measurePeakMem(() => new Array(5_000_000).fill(1.5).length, since)))`)
    // Where the allocator returns freed memory at once (Linux), the call's
    // RSS rise is all visible; where it holds on to it (macOS), the call
    // reuses it and the reading says how much could be missing.
    expect(
      result.peakBytes > 30 * 1024 * 1024 ||
        result.slackBytes > 30 * 1024 * 1024,
    ).toBe(true)
  }, 20_000)

  test("works with an async task", async () => {
    const result = await measurePeakMem(async () => {
      await Promise.resolve()
      return 1
    })
    expect(result.slackBytes).toBeGreaterThanOrEqual(0)
    expect(result.wallNs).toBeGreaterThan(0)
  })
})
