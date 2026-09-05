import { heapStats } from "bun:jsc"
import type { MemoryEvidence } from "../ir/types.ts"

const DEFAULT_BATCH_SIZE = 100

function currentHeapSizeBytes(): number {
  // `bun:jsc`'s heapStats().heapSize is the more precise reading (the JS
  // heap only, post-GC); fall back to the whole process's heap if it's ever
  // unavailable.
  try {
    return heapStats().heapSize
  } catch {
    return process.memoryUsage().heapUsed
  }
}

export interface AllocCaptureResult {
  memory: MemoryEvidence
  diagnosticWallNs: number
}

/** Bytes allocated per call: `Bun.gc(true)` settles the heap, one batch of
 * `batchSize` calls runs, `Bun.gc(true)` settles it again, and the heap size
 * delta is divided by the batch size. A separate, instrumented measurement
 * from timing - this never feeds the task's timing stats. */
export async function measureAllocPerOp(
  fn: () => unknown | Promise<unknown>,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<AllocCaptureResult> {
  const start = Bun.nanoseconds()
  Bun.gc(true)
  const before = currentHeapSizeBytes()
  for (let i = 0; i < batchSize; i++) {
    const result = fn()
    if (result instanceof Promise) await result
  }
  Bun.gc(true)
  const after = currentHeapSizeBytes()
  const diagnosticWallNs = Bun.nanoseconds() - start

  return {
    memory: {
      origin: "heapStats",
      bytesPerOp: Math.max(0, (after - before) / batchSize),
    },
    diagnosticWallNs,
  }
}
