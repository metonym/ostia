import { heapStats } from "bun:jsc"
import { isPromiseLike } from "./inprocess.ts"

/** RSS and live JS memory at one moment; see `memorySnapshot`. */
export interface MemorySnapshot {
  rssBytes: number
  liveBytes: number
}

/** Current RSS, and the JS heap's live objects plus the memory they own
 * outside it (string and array buffers). Taken in a peak-memory process
 * before it imports the suite, so `measurePeakMem` can tell how much of the
 * RSS the call starts from is the suite's live data and how much is memory
 * its setup freed that the allocator hasn't returned to the OS yet. */
export function memorySnapshot(): MemorySnapshot {
  const { heapSize, extraMemorySize } = heapStats()
  return {
    rssBytes: process.memoryUsage.rss(),
    liveBytes: heapSize + extraMemorySize,
  }
}

/** RSS growth since `since` that live JS memory doesn't account for: mostly
 * freed memory the allocator hasn't returned to the OS yet, plus whatever
 * else the process loaded (code, JIT output). */
function residentFree(now: MemorySnapshot, since: MemorySnapshot): number {
  return now.rssBytes - since.rssBytes - (now.liveBytes - since.liveBytes)
}

export interface PeakMemResult {
  /** How far the call pushed the process's peak RSS, measured from its RSS
   * when the call started. Absent when the call never got past the peak
   * earlier work in the process had set. */
  peakBytes?: number
  /** Memory the call could have used without raising RSS: how far the
   * high-water mark already was above the starting RSS, or the freed but
   * still resident memory estimated from `since`, whichever is larger. The
   * call's reading can be low by up to this much. */
  slackBytes: number
  wallNs: number
}

/** How far one call of `fn` raises this process's peak RSS. After a full
 * GC, reads current RSS and the peak-RSS high-water mark
 * (`process.resourceUsage().maxRSS`), makes the call, and reads the
 * high-water mark again. The high-water mark catches the call's true peak
 * whatever happens in between (sampled RSS depends on when the allocator
 * returns freed pages, which varies by seconds), provided nothing earlier in
 * the process left memory for the call to reuse: meant for the first call in
 * a fresh process, which is why there's no warmup here. */
export async function measurePeakMem(
  fn: () => unknown | Promise<unknown>,
  since?: MemorySnapshot,
): Promise<PeakMemResult> {
  Bun.gc(true)
  const start = memorySnapshot()
  const highWaterBefore = process.resourceUsage().maxRSS * 1024
  const startNs = Bun.nanoseconds()
  const result = fn()
  if (isPromiseLike(result)) await result
  const wallNs = Bun.nanoseconds() - startNs
  const highWaterAfter = process.resourceUsage().maxRSS * 1024

  const slackBytes = Math.max(
    0,
    highWaterBefore - start.rssBytes,
    since ? residentFree(start, since) : 0,
  )
  return {
    ...(highWaterAfter > highWaterBefore && {
      peakBytes: highWaterAfter - start.rssBytes,
    }),
    slackBytes,
    wallNs,
  }
}
