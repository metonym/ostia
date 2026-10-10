import { heapStats } from "bun:jsc"
import { isPromiseLike } from "./loop.ts"

export interface MemorySnapshot {
  rssBytes: number
  residentBytes: number
  liveBytes: number
}

/** Taken before the suite loads so `measurePeakMem` can split the starting RSS
 * into live data and memory setup freed that the allocator still holds. */
export function memorySnapshot(): MemorySnapshot {
  const { heapSize, extraMemorySize } = heapStats()
  const rssBytes = process.memoryUsage.rss()
  return {
    rssBytes,
    residentBytes: residentBytes() ?? rssBytes,
    liveBytes: heapSize + extraMemorySize,
  }
}

// Bun 1.4.3+ reports the physical footprint as RSS on macOS, which misses
// reused freed pages for a while (oven-sh/bun#44951). Resident size doesn't.
function residentBytes(): number | undefined {
  if (process.platform !== "darwin") return undefined
  const ps = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(process.pid)], {
    stderr: "ignore",
  })
  const kib = Number(ps.stdout.toString().trim())
  return ps.success && kib > 0 ? kib * 1024 : undefined
}

// Worker body: waits for `go`, then polls RSS flat out (~1µs) keeping the max
// in KiB in slot 1 until `stop`. Slot 0 is the CONTROL handshake.
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

/** Start before taking the snapshots it's compared against, so the worker's
 * own memory counts as setup. Single use: `during` terminates the worker. */
export interface RssSampler {
  /** Runs `call`, returning the highest RSS seen meanwhile, bytes. */
  during(call: () => Promise<void>): Promise<number>
}

// Generous: only a sampler that never answers (startup failure under heavy
// load aside) should hit it.
const HANDSHAKE_TIMEOUT_MS = 10_000

export async function startRssSampler(
  source: string = SAMPLER_SOURCE,
): Promise<RssSampler> {
  const slots = new Int32Array(new SharedArrayBuffer(8))
  const worker = new Worker(
    URL.createObjectURL(new Blob([source], { type: "application/javascript" })),
  )
  // Rejects if the worker errors or exits before it finishes sampling, so a
  // dead sampler fails the measurement instead of hanging it.
  const died = new Promise<never>((_, reject) => {
    const fail = (why: string) =>
      reject(new Error(`RSS sampler worker failed: ${why}`))
    worker.onerror = (event) => fail(event.message || "uncaught error")
    worker.addEventListener("close", () => fail("worker exited unexpectedly"))
  })
  died.catch(() => {})
  const stopped = new Promise((resolve) => {
    worker.onmessage = resolve
  })
  try {
    worker.postMessage(slots.buffer)
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
    while (Atomics.load(slots, 0) !== CONTROL.ready) {
      if (Date.now() > deadline) {
        throw new Error("RSS sampler worker failed: did not start in time")
      }
      await Promise.race([Bun.sleep(1), died])
    }
  } catch (err) {
    worker.terminate()
    throw err
  }
  return {
    async during(call) {
      try {
        Atomics.store(slots, 0, CONTROL.go)
        Atomics.notify(slots, 0)
        // Spin first: the sampler must be polling before `call` starts, and
        // it normally is within microseconds. Past that, yield so a dead
        // worker's `died` can surface.
        const spinUntil = Bun.nanoseconds() + 50e6
        while (
          Atomics.load(slots, 0) !== CONTROL.sampling &&
          Bun.nanoseconds() < spinUntil
        ) {}
        const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
        while (Atomics.load(slots, 0) !== CONTROL.sampling) {
          if (Date.now() > deadline) {
            throw new Error("RSS sampler worker failed: did not start sampling")
          }
          await Promise.race([Bun.sleep(1), died])
        }
        await call()
        Atomics.store(slots, 0, CONTROL.stop)
        await Promise.race([stopped, died])
        return Atomics.load(slots, 1) * 1024
      } finally {
        worker.terminate()
      }
    },
  }
}

export interface PeakMemResult {
  /** RSS rise above where it stood when the call started. */
  peakBytes: number
  /** Setup-freed memory the allocator still held at call start (from `since`):
   * the call can reuse it unseen, so `peakBytes` can be low by this much. */
  slackBytes: number
  wallNs: number
}

/** How far one call of `fn` raises this process's RSS, garbage included: the
 * higher of the worker-sampled peak and the `maxRSS` high-water mark (if the
 * call moved it), after a full GC. Sampling alone can miss a spike between
 * polls; the high-water mark alone misses any call peaking below an earlier
 * peak (on Linux, every call smaller than process startup). Meant for the
 * first call in a fresh process: memory an earlier call freed but the
 * allocator holds (macOS returns it seconds later) is reused unseen. */
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
    ? start.residentBytes -
      since.residentBytes -
      (start.liveBytes - since.liveBytes)
    : 0
  return {
    peakBytes: Math.max(0, peak - start.rssBytes),
    slackBytes: Math.max(0, residentFree),
    wallNs,
  }
}
