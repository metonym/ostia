import { percentile } from "./index.ts"

/** mulberry32: a small, fast, seeded PRNG. Deterministic across platforms
 * (32-bit integer arithmetic only), good enough for resampling; not
 * cryptographic. */
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
  /** Seed used for the PRNG, so the result is reproducible. */
  seed: number
  data: {
    /** Whether either side was randomly subsampled to `MAX_SAMPLES_PER_SIDE`
     * before bootstrapping, so a 10k-sample task doesn't take seconds. */
    subsampled: boolean
    iterations: number
  }
}

function median(sorted: Float64Array): number {
  const n = sorted.length
  const mid = n >> 1
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** Random subsample without replacement (partial Fisher-Yates), capped at
 * `max`. Returns `samples` itself, unchanged, when already at or under `max`. */
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

/** One side of the bootstrap: the sorted sample plus a reusable histogram of
 * how many times each sorted index was drawn in the current round. */
class Side {
  readonly sorted: Float64Array
  /** Sorted position of each original sample, so a draw of original index
   * `i` (what a literal `samples[floor(rng() * n)]` resample would pick)
   * lands on the same value: results for a given seed match a naive
   * resample bit for bit. */
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

  /** Median of a with-replacement resample. Drawing index `k` of the sorted
   * array is the same as drawing `sorted[k]`, so the resample's median is the
   * value at the median of the drawn indices - found with one O(n) walk over
   * an index histogram instead of sorting `n` values per round. Consumes
   * exactly `n` rng values, one per draw, like a literal resample would. */
  resampleMedian(rng: () => number): number {
    const { n, counts, sorted, rankOf } = this
    counts.fill(0)
    for (let i = 0; i < n; i++) counts[rankOf[Math.floor(rng() * n)]!]!++
    // 1-based order statistics of the drawn indices: for odd n the middle
    // one; for even n the mean of the two middle ones.
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

/** Bootstrap 95% CI on the difference of medians between `base` and `cand`,
 * reported in percent of `base`'s (observed, unresampled) median. Each of
 * `iterations` rounds resamples both sides with replacement and takes the
 * difference of the two resample medians. Caps work at
 * `MAX_SAMPLES_PER_SIDE` samples per side (randomly subsampled) so a
 * many-thousand-sample task doesn't turn a compare into a multi-second
 * operation. */
export function bootstrapMedianDiffCi(
  base: number[],
  cand: number[],
  opts: BootstrapOptions = {},
): BootstrapResult {
  const seed =
    opts.seed ?? (Date.now() ^ Math.imul(base.length, 2654435761)) >>> 0
  const rng = mulberry32(seed)
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS

  const subsampled =
    base.length > MAX_SAMPLES_PER_SIDE || cand.length > MAX_SAMPLES_PER_SIDE
  const baseSide = new Side(subsample(base, rng, MAX_SAMPLES_PER_SIDE))
  const candSide = new Side(subsample(cand, rng, MAX_SAMPLES_PER_SIDE))
  const baseMedian = median(baseSide.sorted)

  const deltas = new Float64Array(iterations)
  for (let i = 0; i < iterations; i++) {
    const b = baseSide.resampleMedian(rng)
    const c = candSide.resampleMedian(rng)
    deltas[i] =
      baseMedian === 0
        ? c - b === 0
          ? 0
          : Infinity
        : ((c - b) / baseMedian) * 100
  }
  deltas.sort()

  return {
    ci95: [percentile(deltas, 0.025), percentile(deltas, 0.975)],
    seed,
    data: { subsampled, iterations },
  }
}
