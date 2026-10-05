import { heapStats } from "bun:jsc"
import type { MemoryEvidence } from "../ir/types.ts"
import { isPromiseLike } from "./loop.ts"

const DEFAULT_BATCH_SIZE = 100
// Calls stop early once the batch has run this long, so a slow task costs
// about a second here, not `batchSize` of its calls. Fast tasks never reach it.
const DEFAULT_BUDGET_MS = 1000

export interface AllocCaptureResult {
  memory: MemoryEvidence
  diagnosticWallNs: number
}

/** Retained heap growth per call: heap size after a batch and a full GC, minus
 * before, over the calls made: up to `batchSize`, fewer (at least one) once
 * `budgetMs` has passed. Garbage is collected, so this is a leak check and
 * a garbage-heavy task reads near zero. Never feeds timing stats. */
export async function measureAllocPerOp(
  fn: () => unknown | Promise<unknown>,
  batchSize: number = DEFAULT_BATCH_SIZE,
  budgetMs: number = DEFAULT_BUDGET_MS,
): Promise<AllocCaptureResult> {
  const start = Bun.nanoseconds()
  Bun.gc(true)
  const before = heapStats().heapSize
  const budgetEnd = Bun.nanoseconds() + budgetMs * 1e6
  let calls = 0
  while (calls < batchSize && (calls === 0 || Bun.nanoseconds() < budgetEnd)) {
    const result = fn()
    if (isPromiseLike(result)) await result
    calls++
  }
  Bun.gc(true)
  const after = heapStats().heapSize
  const diagnosticWallNs = Bun.nanoseconds() - start

  return {
    memory: {
      origin: "heapStats",
      kind: "retained",
      bytesPerOp: Math.max(0, (after - before) / calls),
    },
    diagnosticWallNs,
  }
}
