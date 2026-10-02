import type { NoiseFloor } from "../ir/types.ts"
import { computeTimingStats } from "../stats/index.ts"

const DEFAULT_BUDGET_MS = 200
// Keeps a trial in the microsecond range so timer resolution doesn't dominate.
const HASHES_PER_TRIAL = 64

// Fixed, allocation-free workload: trial-to-trial variance is the machine's noise.
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

/** `mad / median` of `samples`, as a percent. */
export function computeNoiseFloor(samples: number[]): NoiseFloor {
  const stats = computeTimingStats(samples)
  return {
    floorPct: stats.median === 0 ? 0 : (stats.mad / stats.median) * 100,
    referenceMedianNs: stats.median,
    samples: samples.length,
  }
}

/** Samples the reference hash loop for `budgetMs`; characterizes the machine,
 * not any workload, so run it once per document. */
export function measureNoiseFloor(budgetMs = DEFAULT_BUDGET_MS): NoiseFloor {
  const budgetNs = budgetMs * 1e6
  const trials: number[] = []
  // biome-ignore lint/correctness/noUnusedVariables: write-only, defeats DCE
  let sink = 0

  const start = Bun.nanoseconds()
  while (Bun.nanoseconds() - start < budgetNs) {
    const trialStart = Bun.nanoseconds()
    for (let i = 0; i < HASHES_PER_TRIAL; i++) {
      sink ^= hashBuffer(REFERENCE_BUFFER, i)
    }
    trials.push((Bun.nanoseconds() - trialStart) / HASHES_PER_TRIAL)
  }

  return computeNoiseFloor(trials)
}
