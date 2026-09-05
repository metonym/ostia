import type { NoiseFloor } from "../ir/types.ts"
import { computeTimingStats } from "../stats/index.ts"

const DEFAULT_BUDGET_MS = 200
// Kept in the microsecond range regardless of how fast a single hash is, so
// the timer's own resolution doesn't dominate the reading (same reasoning
// as measure/inprocess.ts's batching).
const HASHES_PER_TRIAL = 64

// Fixed, deterministic, no-allocation reference workload: what varies trial
// to trial is the machine's own noise (scheduling, thermal, turbo), not the
// work itself.
const REFERENCE_BUFFER = (() => {
  const buf = new Uint8Array(4096)
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) & 0xff
  return buf
})()

function hashBuffer(buf: Uint8Array, seed: number): number {
  let h = seed
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i]!
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** `mad / median` of `samples`, as a percent - how noisy those trial times
 * were, independent of what produced them. Split out from
 * `measureNoiseFloor` so it can be tested on fixed sample arrays without
 * depending on real timing. */
export function computeNoiseFloor(samples: number[]): NoiseFloor {
  const stats = computeTimingStats(samples)
  const mad = stats.mad ?? 0
  return {
    floorPct: stats.median === 0 ? 0 : (mad / stats.median) * 100,
    referenceMedianNs: stats.median,
    samples: samples.length,
  }
}

/** Measures this machine's current noise floor: samples a fixed-cost,
 * deterministic, allocation-free hash loop for `budgetMs` and reports
 * `mad / median` of the trial times. Run once before the first
 * command/task in a document, not per workload - it characterizes the
 * machine, not what's being measured. */
export function measureNoiseFloor(budgetMs = DEFAULT_BUDGET_MS): NoiseFloor {
  const budgetNs = budgetMs * 1e6
  const trials: number[] = []
  // biome-ignore lint/correctness/noUnusedVariables: write-only, defeats DCE
  let sink = 0

  const start = Bun.nanoseconds()
  let elapsed = 0
  while (elapsed < budgetNs) {
    const trialStart = Bun.nanoseconds()
    for (let i = 0; i < HASHES_PER_TRIAL; i++) {
      sink ^= hashBuffer(REFERENCE_BUFFER, i)
    }
    const trialEnd = Bun.nanoseconds()
    trials.push((trialEnd - trialStart) / HASHES_PER_TRIAL)
    elapsed = Bun.nanoseconds() - start
  }

  return computeNoiseFloor(trials)
}
