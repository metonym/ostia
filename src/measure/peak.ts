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

// Runs on its own thread: idles until the main thread says go, then polls
// this process's RSS as fast as it can (about once a microsecond), keeping
// the maximum, in KiB, in slot 1, until told to stop. Slot 0 is the
// handshake, one of the CONTROL states.
const CONTROL = { ready: 1, go: 2, sampling: 3, stop: 4 } as const
const SAMPLER_SOURCE = `self.onmessage = (event) => {
  const slots = new Int32Array(event.data)
  Atomics.store(slots, 0, ${CONTROL.ready})
  Atomics.wait(slots, 0, ${CONTROL.ready})
  if (Atomics.compareExchange(slots, 0, ${CONTROL.go}, ${CONTROL.sampling}) === ${CONTROL.go}) {
    while (Atomics.load(slots, 0) === ${CONTROL.sampling}) {
      const kib = (process.memoryUsage.rss() / 1024) | 0
      if (kib > Atomics.load(slots, 1)) Atomics.store(slots, 1, kib)
    }
  }
  postMessage(0)
}`

/** A worker thread that samples this process's RSS through one call. Start
 * it before taking the snapshots it's compared against: the worker's own
 * memory then counts as setup, not as the call's. */
export interface RssSampler {
  /** Runs `call`, returning the highest RSS seen while it ran, bytes. */
  during(call: () => Promise<void>): Promise<number>
}

export async function startRssSampler(): Promise<RssSampler> {
  const slots = new Int32Array(new SharedArrayBuffer(8))
  const worker = new Worker(
    URL.createObjectURL(
      new Blob([SAMPLER_SOURCE], { type: "application/javascript" }),
    ),
  )
  const stopped = new Promise((resolve) => {
    worker.onmessage = resolve
  })
  worker.postMessage(slots.buffer)
  while (Atomics.load(slots, 0) !== CONTROL.ready) await Bun.sleep(1)
  return {
    async during(call) {
      try {
        Atomics.store(slots, 0, CONTROL.go)
        Atomics.notify(slots, 0)
        while (Atomics.load(slots, 0) !== CONTROL.sampling) {}
        await call()
        Atomics.store(slots, 0, CONTROL.stop)
        await stopped
        return Atomics.load(slots, 1) * 1024
      } finally {
        worker.terminate()
      }
    },
  }
}

export interface PeakMemResult {
  /** How far RSS rose above where it stood when the call started. */
  peakBytes: number
  /** Memory the process's setup freed that the allocator still held when
   * the call started (estimated from `since`), which the call could reuse
   * without RSS rising: the reading can be low by up to this much. */
  slackBytes: number
  wallNs: number
}

/** How far one call of `fn` raises this process's RSS, garbage included.
 * After a full GC, the peak is the higher of two readings, each measured
 * from the RSS the call started at: RSS sampled throughout the call from a
 * worker thread, and the peak-RSS high-water mark
 * (`process.resourceUsage().maxRSS`) if the call moved it. Sampling alone
 * can miss a brief spike between polls; the high-water mark alone misses
 * any call that peaks below an earlier peak in the process, which on Linux,
 * where freed memory goes back to the OS at once, is every call smaller than
 * the process's own startup. Meant for the first call in a fresh process:
 * memory an earlier call freed but the allocator still holds (macOS returns
 * it seconds later) is memory this one can reuse unseen. */
export async function measurePeakMem(
  fn: () => unknown | Promise<unknown>,
  since?: MemorySnapshot,
  sampler?: RssSampler,
): Promise<PeakMemResult> {
  const rss = sampler ?? (await startRssSampler())
  Bun.gc(true)
  const start = memorySnapshot()
  const highWaterBefore = process.resourceUsage().maxRSS * 1024
  const startNs = Bun.nanoseconds()
  let wallNs = 0
  const sampledMax = await rss.during(async () => {
    const result = fn()
    if (isPromiseLike(result)) await result
    wallNs = Bun.nanoseconds() - startNs
  })
  const highWaterAfter = process.resourceUsage().maxRSS * 1024
  const peak = Math.max(
    sampledMax,
    highWaterAfter > highWaterBefore ? highWaterAfter : 0,
  )

  const residentFree = since
    ? start.rssBytes - since.rssBytes - (start.liveBytes - since.liveBytes)
    : 0
  return {
    peakBytes: Math.max(0, peak - start.rssBytes),
    slackBytes: Math.max(0, residentFree),
    wallNs,
  }
}
