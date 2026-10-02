import { percentile } from "./index.ts"

/** Seeded PRNG, deterministic across platforms (32-bit integer math only). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MAX_SAMPLES_PER_SIDE = 2000
const DEFAULT_ITERATIONS = 2000

export interface BootstrapOptions {
  iterations?: number
  seed?: number
}

export interface BootstrapResult {
  /** 95% CI on the difference of medians, percent of the baseline median. */
  ci95: [number, number]
  seed: number
  data: {
    /** Either side was randomly cut to `MAX_SAMPLES_PER_SIDE` samples. */
    subsampled: boolean
    iterations: number
  }
}

/** Partial Fisher-Yates; returns `samples` itself when already within `max`. */
function subsample(
  samples: number[],
  rng: () => number,
  max: number,
): number[] {
  if (samples.length <= max) return samples
  const pool = [...samples]
  for (let i = 0; i < max; i++) {
    const j = i + Math.floor(rng() * (pool.length - i))
    const tmp = pool[i]!
    pool[i] = pool[j]!
    pool[j] = tmp
  }
  return pool.slice(0, max)
}

class Side {
  readonly sorted: Float64Array
  /** Sorted position of each original sample, so results for a given seed
   * match a naive `samples[floor(rng() * n)]` resample bit for bit. */
  readonly rankOf: Uint32Array
  readonly counts: Uint32Array
  readonly n: number
  constructor(samples: number[]) {
    const n = samples.length
    const order = new Uint32Array(n)
    for (let i = 0; i < n; i++) order[i] = i
    order.sort((x, y) => samples[x]! - samples[y]!)
    this.sorted = new Float64Array(n)
    this.rankOf = new Uint32Array(n)
    for (let k = 0; k < n; k++) {
      this.sorted[k] = samples[order[k]!]!
      this.rankOf[order[k]!] = k
    }
    this.n = n
    this.counts = new Uint32Array(n)
  }

  /** Median of a with-replacement resample, found with one O(n) walk over an
   * index histogram instead of sorting `n` values per round. */
  resampleMedian(rng: () => number): number {
    const { n, counts, sorted, rankOf } = this
    counts.fill(0)
    for (let i = 0; i < n; i++) counts[rankOf[Math.floor(rng() * n)]!]!++
    // 1-based middle order statistic(s) of the draws.
    const loRank = (n + 1) >> 1
    const hiRank = n % 2 === 0 ? loRank + 1 : loRank
    let seen = 0
    let lo = -1
    for (let k = 0; k < n; k++) {
      seen += counts[k]!
      if (lo < 0 && seen >= loRank) lo = k
      if (seen >= hiRank) {
        return lo === k ? sorted[k]! : (sorted[lo]! + sorted[k]!) / 2
      }
    }
    return sorted[n - 1]!
  }
}

/** Hash of both arrays, so identical input always gets the same CI and verdict. */
function seedFromSamples(base: number[], cand: number[]): number {
  const all = new Float64Array(base.length + cand.length + 1)
  all.set(base)
  all[base.length] = Number.NaN // keeps [a, b] | [c] apart from [a] | [b, c]
  all.set(cand, base.length + 1)
  return Bun.hash.crc32(all)
}

/** Bootstrap 95% CI on the difference of medians, in percent of `base`'s
 * observed median. Each side is capped at `MAX_SAMPLES_PER_SIDE` samples so a
 * many-thousand-sample task doesn't take seconds. Throws when a side is empty. */
export function bootstrapMedianDiffCi(
  base: number[],
  cand: number[],
  opts: BootstrapOptions = {},
): BootstrapResult {
  if (base.length === 0 || cand.length === 0) {
    throw new RangeError("bootstrapMedianDiffCi: both sides need samples")
  }
  const seed = opts.seed ?? seedFromSamples(base, cand)
  const rng = mulberry32(seed)
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS

  const subsampled =
    base.length > MAX_SAMPLES_PER_SIDE || cand.length > MAX_SAMPLES_PER_SIDE
  const baseSide = new Side(subsample(base, rng, MAX_SAMPLES_PER_SIDE))
  const candSide = new Side(subsample(cand, rng, MAX_SAMPLES_PER_SIDE))
  const baseMedian = percentile(baseSide.sorted, 0.5)

  const deltas = new Float64Array(iterations)
  for (let i = 0; i < iterations; i++) {
    const b = baseSide.resampleMedian(rng)
    const c = candSide.resampleMedian(rng)
    const diff = c - b
    deltas[i] =
      baseMedian === 0
        ? diff === 0
          ? 0
          : diff * Infinity
        : (diff / baseMedian) * 100
  }
  deltas.sort()

  return {
    ci95: [percentile(deltas, 0.025), percentile(deltas, 0.975)],
    seed,
    data: { subsampled, iterations },
  }
}
