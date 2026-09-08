import { describe, expect, test } from "bun:test"
import { readBoundedText } from "../../src/spawn/index"

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      // Split into small chunks so the reader loop actually iterates more
      // than once, exercising the head/tail bookkeeping across chunks.
      const CHUNK = 4096
      for (let i = 0; i < bytes.length; i += CHUNK) {
        controller.enqueue(bytes.subarray(i, i + CHUNK))
      }
      controller.close()
    },
  })
}

describe("readBoundedText", () => {
  test("returns the whole stream unchanged when it's under the cap", async () => {
    const text = "hello world\n".repeat(10)
    const result = await readBoundedText(streamOf(text), 1024)
    expect(result).toBe(text)
  })

  test("caps a stream over the limit to head + marker + tail, well under the original size", async () => {
    const head = "A".repeat(2000)
    const middle = "B".repeat(50_000)
    const tail = "C".repeat(2000)
    const text = head + middle + tail
    const cap = 4000 // 2000 head + 2000 tail

    const result = await readBoundedText(streamOf(text), cap)

    expect(result.length).toBeLessThan(text.length)
    expect(result.startsWith("A".repeat(100))).toBe(true)
    expect(result.endsWith("C".repeat(100))).toBe(true)
    expect(result).not.toContain("B")
    expect(result).toMatch(/bytes elided/)
  })

  test("bounds memory to roughly the cap regardless of how much the stream produces", async () => {
    // 10x the default cap: if this ever buffered the whole stream, the
    // string below would be ~10MB instead of ~1MB.
    const huge = "x".repeat(10 * 1024 * 1024)
    const result = await readBoundedText(streamOf(huge))
    expect(result.length).toBeLessThan(2 * 1024 * 1024)
  })
})
