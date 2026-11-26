import type { NoiseFloor } from "../ir/types.ts";
import { computeTimingStats } from "../stats/index.ts";

// The default check samples for at least MIN_MS, then until its median
// holds within STABLE_PCT between checkpoints, for at most MAX_MS: a
// longer check doesn't give a steadier floor, since the spread comes from
// the machine, not the sample count (metonym/ostia#52).
const MIN_MS = 25;
const MAX_MS = 50;
const CHECK_EVERY = 16;
const STABLE_PCT = 1;
// perf: the end-of-run check only needs the median, for drift, and the
// median holds from 25 ms.
export const DRIFT_BUDGET_MS = 25;
// Keeps a trial in the microsecond range so timer resolution
// doesn't dominate.
const HASHES_PER_TRIAL = 64;

// Fixed and allocation-free, so trial-to-trial variance is the
// machine's noise.
const REFERENCE_BUFFER = (() => {
  const buf = new Uint8Array(4096);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) & 0xff;
  return buf;
})();

function hashBuffer(buf: Uint8Array, seed: number): number {
  let h = seed;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i] ?? 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function computeNoiseFloor(samples: number[]): NoiseFloor {
  const stats = computeTimingStats(samples);
  return {
    floorPct: stats.median === 0 ? 0 : (stats.mad / stats.median) * 100,
    referenceMedianNs: stats.median,
    samples: samples.length,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

// Samples the reference hash loop; characterizes the machine, not any
// workload, so run it once per document. With `budgetMs`, for exactly
// that long, as `--noise-budget` asks; without, adaptively.
export function measureNoiseFloor(budgetMs?: number): NoiseFloor {
  const minNs = (budgetMs ?? MIN_MS) * 1e6;
  const maxNs = (budgetMs ?? MAX_MS) * 1e6;
  const trials: number[] = [];
  let sink = 0;
  let checkpoint: number | undefined;

  const start = Bun.nanoseconds();
  for (;;) {
    const elapsed = Bun.nanoseconds() - start;
    if (elapsed >= maxNs) break;
    if (
      budgetMs === undefined &&
      elapsed >= minNs &&
      trials.length % CHECK_EVERY === 0
    ) {
      const now = median(trials);
      const held =
        checkpoint !== undefined &&
        checkpoint > 0 &&
        (Math.abs(now - checkpoint) / checkpoint) * 100 <= STABLE_PCT;
      if (held) break;
      checkpoint = now;
    }
    const trialStart = Bun.nanoseconds();
    for (let i = 0; i < HASHES_PER_TRIAL; i++) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- write-only, defeats DCE
      sink ^= hashBuffer(REFERENCE_BUFFER, i);
    }
    trials.push((Bun.nanoseconds() - trialStart) / HASHES_PER_TRIAL);
  }

  return {
    ...computeNoiseFloor(trials),
    checkMs: (Bun.nanoseconds() - start) / 1e6,
    ...(budgetMs !== undefined && { budgetMs }),
  };
}
