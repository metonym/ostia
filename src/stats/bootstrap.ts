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

function resampleMedian(samples: number[], rng: () => number): number {
  const n = samples.length
  const resampled = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    resampled[i] = samples[Math.floor(rng() * n)]!
  }
  resampled.sort()
  return median(resampled)
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
  const baseSample = subsample(base, rng, MAX_SAMPLES_PER_SIDE)
  const candSample = subsample(cand, rng, MAX_SAMPLES_PER_SIDE)

  const baseSorted = new Float64Array(baseSample)
  baseSorted.sort()
  const baseMedian = median(baseSorted)

  const deltas = new Float64Array(iterations)
  for (let i = 0; i < iterations; i++) {
    const b = resampleMedian(baseSample, rng)
    const c = resampleMedian(candSample, rng)
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
