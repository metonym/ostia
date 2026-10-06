import type { MemoryChange } from "../ir/types.ts"
import { percentile, sortedCopy } from "../stats/index.ts"
import { batchTimer, probeFirstCall, type TaskBody } from "./loop.ts"

export type Side = "base" | "cand"

/** `"candidate"` for `"cand"`, for messages; other sides as they are. */
export function sideLabel(side: Side | "both"): string {
  return side === "cand" ? "candidate" : side
}

/** What `measurePaired` throws when one side's task throws, naming the
 * side; the task's own error is `cause`. */
export class PairedSideError extends Error {
  constructor(
    readonly side: Side,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

/** Runs `fn`, rethrowing anything it throws as a `PairedSideError` for
 * `side`. */
async function onSide<T>(
  side: "base" | "cand",
  fn: () => T | Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw err instanceof PairedSideError ? err : new PairedSideError(side, err)
  }
}

export interface PairedTimingOptions {
  /** Rounds of one base batch and one candidate batch (default: 15). */
  rounds?: number
  /** Aborting rejects `measurePaired` with the signal's reason at the next
   * batch boundary; partial rounds are discarded. */
  signal?: AbortSignal
}

export interface PairedTimingResult {
  rounds: number
  /** Calls per side per round. */
  batch: number
  /** Per-call time of each side in each round, ns, index-aligned. */
  baseSamples: number[]
  candSamples: number[]
  /** `candSamples[i] / baseSamples[i]`. */
  ratios: number[]
  /** Whether the two sides' first calls returned deep-equal values. */
  sameOutput: boolean
  diagnosticWallNs: number
}

export interface RatioStats {
  medianRatio: number
  ratioP25: number
  ratioP75: number
  flagged?: "regressed" | "improved"
}

const DEFAULT_ROUNDS = 15
// Long enough that timer resolution vanishes, short enough that the machine
// barely changes between a round's two halves.
const ROUND_BATCH_NS = 10_000_000
// Warmup doubles each side's batch until it spans this long.
const WARMUP_CHUNK_NS = 1_000_000
const WARM_ROUNDS = 3

/** Times `base` and `cand` against each other in one process: after warmup,
 * `rounds` rounds of one ~10ms batch per side, alternating which goes first.
 * Drift (load, thermal throttling) hits both halves of a round alike and
 * cancels in that round's ratio, which a baseline measured minutes earlier
 * can't do. A throw from either side rejects with a `PairedSideError`
 * naming it. */
export async function measurePaired(
  base: TaskBody,
  cand: TaskBody,
  opts: PairedTimingOptions = {},
): Promise<PairedTimingResult> {
  const rounds = opts.rounds ?? DEFAULT_ROUNDS
  const { signal } = opts
  signal?.throwIfAborted()
  const start = Bun.nanoseconds()

  const baseFirst = await onSide("base", () => probeFirstCall(base))
  const candFirst = await onSide("cand", () => probeFirstCall(cand))
  const sameOutput = Bun.deepEquals(baseFirst.result, candFirst.result)

  const side = (name: "base" | "cand", fn: TaskBody, isAsync: boolean) => {
    const time = batchTimer(fn, isAsync)
    return (n: number): Promise<number> => onSide(name, () => time(n))
  }
  const timeBase = side("base", base, baseFirst.isAsync)
  const timeCand = side("cand", cand, candFirst.isAsync)

  // Each side warms alone: sharing one doubling would run a slow side
  // thousands of times just to get a fast side's batch past the chunk.
  const warmUp = async (time: (n: number) => number | Promise<number>) => {
    for (let n = 1; ; n *= 2) {
      signal?.throwIfAborted()
      const ns = await time(n)
      if (ns >= WARMUP_CHUNK_NS) return Math.max(1, ns / n)
    }
  }
  const baseCallNs = await warmUp(timeBase)
  const candCallNs = await warmUp(timeCand)

  const batch = Math.max(
    1,
    Math.round(ROUND_BATCH_NS / Math.max(baseCallNs, candCallNs)),
  )
  for (let r = 0; r < WARM_ROUNDS; r++) {
    signal?.throwIfAborted()
    await timeBase(batch)
    await timeCand(batch)
  }

  const baseSamples: number[] = []
  const candSamples: number[] = []
  const ratios: number[] = []
  for (let r = 0; r < rounds; r++) {
    signal?.throwIfAborted()
    let b: number
    let c: number
    if (r % 2 === 0) {
      b = await timeBase(batch)
      c = await timeCand(batch)
    } else {
      c = await timeCand(batch)
      b = await timeBase(batch)
    }
    b = Math.max(1, b)
    c = Math.max(1, c)
    baseSamples.push(b / batch)
    candSamples.push(c / batch)
    ratios.push(c / b)
  }

  return {
    rounds,
    batch,
    baseSamples,
    candSamples,
    ratios,
    sameOutput,
    diagnosticWallNs: Bun.nanoseconds() - start,
  }
}

/** False when the suite file changed and the two sides' outputs differ:
 * the sides then likely ran different benchmarks, and their time ratio says
 * nothing about the code under test. */
export function comparable(p: {
  suiteChanged?: true
  sameOutput: boolean
}): boolean {
  return !(p.suiteChanged && !p.sameOutput)
}

/** `regressed` when the candidate exceeds the base by more than
 * `thresholdPct` of the base and more than `floorBytes`; `improved` is the
 * mirror. */
export function memoryChange(
  baseBytes: number,
  candBytes: number,
  thresholdPct: number,
  floorBytes: number,
): MemoryChange {
  const diff = candBytes - baseBytes
  const counts =
    Math.abs(diff) > Math.max(floorBytes, (baseBytes * thresholdPct) / 100)
  return {
    baseBytes,
    candBytes,
    verdict: !counts ? "unchanged" : diff > 0 ? "regressed" : "improved",
    floorBytes,
  }
}

/** `regressed` when the median ratio is above `1 + thresholdPct/100` and the
 * 25th percentile is above 1 (slower in at least three quarters of rounds);
 * `improved` is the mirror. The quartile condition keeps a few wild rounds
 * from flagging a workload whose typical round shows no change. */
export function ratioStats(ratios: number[], thresholdPct: number): RatioStats {
  const sorted = sortedCopy(ratios)
  const medianRatio = percentile(sorted, 0.5)
  const ratioP25 = percentile(sorted, 0.25)
  const ratioP75 = percentile(sorted, 0.75)
  const t = thresholdPct / 100
  const flagged =
    medianRatio > 1 + t && ratioP25 > 1
      ? "regressed"
      : medianRatio < 1 - t && ratioP75 < 1
        ? "improved"
        : undefined
  return { medianRatio, ratioP25, ratioP75, ...(flagged && { flagged }) }
}
