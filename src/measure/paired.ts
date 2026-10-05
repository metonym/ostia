import { percentile } from "../stats/index.ts"
import { compileLoop, isPromiseLike, SINK_SIZE } from "./inprocess.ts"

type TaskBody = () => unknown | Promise<unknown>

/** What `measurePaired` throws when one side's task throws, naming the
 * side; the task's own error is `cause`. */
export class PairedSideError extends Error {
  constructor(
    readonly side: "base" | "cand",
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
  p25: number
  p75: number
  flagged?: "regressed" | "improved"
}

const DEFAULT_ROUNDS = 15
// Each side's batch is sized to about this long: timer resolution and call
// overhead vanish, and a round is still short enough that the machine barely
// changes between its two halves.
const ROUND_BATCH_NS = 10_000_000
// Warmup doubles both sides' batch until one spans this long, so each side's
// compiled loop is hot before its batch size is planned.
const WARMUP_CHUNK_NS = 1_000_000
const WARM_ROUNDS = 3

/** Times `base` and `cand` against each other in one process: after a
 * warmup, `rounds` rounds of one ~10ms batch per side, alternating which side
 * goes first so neither always runs on a warmer machine. Whatever drifts over
 * the run (load from other processes, thermal throttling) lands on both
 * halves of a round alike and cancels in that round's ratio, which a
 * baseline measured minutes earlier can't do. Each side is timed through its
 * own compiled loop (see `compileLoop`). A throw from either side rejects
 * with a `PairedSideError` naming it. */
export async function measurePaired(
  base: TaskBody,
  cand: TaskBody,
  opts: PairedTimingOptions = {},
): Promise<PairedTimingResult> {
  const rounds = opts.rounds ?? DEFAULT_ROUNDS
  const start = Bun.nanoseconds()

  const first = async (fn: TaskBody) => {
    const t0 = Bun.nanoseconds()
    const value = fn()
    const isAsync = isPromiseLike(value)
    const result = isAsync ? await value : value
    return { isAsync, result, ns: Math.max(1, Bun.nanoseconds() - t0) }
  }
  const baseFirst = await onSide("base", () => first(base))
  const candFirst = await onSide("cand", () => first(cand))
  const sameOutput = Bun.deepEquals(baseFirst.result, candFirst.result)

  const side = (name: "base" | "cand", fn: TaskBody, isAsync: boolean) => {
    const loop = compileLoop(isAsync)
    const sink: unknown[] = new Array(SINK_SIZE)
    return (n: number): Promise<number> => onSide(name, () => loop(fn, sink, n))
  }
  const timeBase = side("base", base, baseFirst.isAsync)
  const timeCand = side("cand", cand, candFirst.isAsync)

  let baseCallNs = baseFirst.ns
  let candCallNs = candFirst.ns
  for (let n = 1; ; n *= 2) {
    const b = await timeBase(n)
    const c = await timeCand(n)
    baseCallNs = Math.max(1, b / n)
    candCallNs = Math.max(1, c / n)
    if (b >= WARMUP_CHUNK_NS && c >= WARMUP_CHUNK_NS) break
  }

  const batch = Math.max(
    1,
    Math.round(ROUND_BATCH_NS / Math.max(baseCallNs, candCallNs)),
  )
  for (let r = 0; r < WARM_ROUNDS; r++) {
    await timeBase(batch)
    await timeCand(batch)
  }

  const baseSamples: number[] = []
  const candSamples: number[] = []
  const ratios: number[] = []
  for (let r = 0; r < rounds; r++) {
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

/** Median and quartiles of per-round candidate/base ratios, and whether they
 * cross `thresholdPct`: `regressed` when the median ratio is above
 * `1 + thresholdPct/100` and the 25th percentile is above 1 (the candidate
 * was slower in at least three quarters of rounds); `improved` is the mirror
 * image. The quartile condition keeps a few wild rounds from flagging a
 * workload whose typical round shows no change. */
export function ratioStats(ratios: number[], thresholdPct: number): RatioStats {
  const sorted = Float64Array.from(ratios).sort()
  const medianRatio = percentile(sorted, 0.5)
  const p25 = percentile(sorted, 0.25)
  const p75 = percentile(sorted, 0.75)
  const t = thresholdPct / 100
  const flagged =
    medianRatio > 1 + t && p25 > 1
      ? "regressed"
      : medianRatio < 1 - t && p75 < 1
        ? "improved"
        : undefined
  return { medianRatio, p25, p75, ...(flagged && { flagged }) }
}
