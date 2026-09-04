import type { TimingStats, Trial, Warning } from "../ir/types.ts"
import { computeTimingStats, timingWarnings } from "../stats/index.ts"

export interface InprocessTimingOptions {
  timeBudgetMs?: number
  minSamples?: number
  warmupFraction?: number
  gc?: boolean
}

const DEFAULT_TIME_BUDGET_MS = 500
const DEFAULT_MIN_SAMPLES = 20
const DEFAULT_WARMUP_FRACTION = 0.1
const BATCH_THRESHOLD_NS = 1000

export interface InprocessTimingResult {
  trials: Trial[]
  timing: TimingStats
  warnings: Warning[]
}

// Prevents the JIT from eliminating calls whose result is otherwise unused. Write-only
// by design. The accumulation itself, not the final value, defeats dead-code
// elimination; nothing needs to read it back.
// biome-ignore lint/correctness/noUnusedVariables: intentionally write-only, see above
let sink = 0
function consume(value: unknown): void {
  if (typeof value === "number") sink += value
  else if (value !== undefined && value !== null) sink += 1
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<unknown>).then === "function"
  )
}

export async function measureTask(
  fn: () => unknown | Promise<unknown>,
  opts: InprocessTimingOptions = {},
): Promise<InprocessTimingResult> {
  const timeBudgetNs = (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS) * 1e6
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES
  const warmupBudgetNs =
    timeBudgetNs * (opts.warmupFraction ?? DEFAULT_WARMUP_FRACTION)

  const warmupStart = Bun.nanoseconds()
  while (Bun.nanoseconds() - warmupStart < warmupBudgetNs) {
    consume(await fn())
  }

  const calibStart = Bun.nanoseconds()
  consume(await fn())
  const singleCallNs = Math.max(1, Bun.nanoseconds() - calibStart)
  const batchSize =
    singleCallNs < BATCH_THRESHOLD_NS
      ? Math.max(1, Math.ceil(BATCH_THRESHOLD_NS / singleCallNs))
      : 1

  const trials: Trial[] = []
  const start = Bun.nanoseconds()
  let elapsed = 0
  let i = 0
  while (i < minSamples || elapsed < timeBudgetNs) {
    const trialStart = Bun.nanoseconds()
    for (let b = 0; b < batchSize; b++) {
      // Only suspend on an actual promise: `await` on a plain value still costs a
      // microtask turn per call, which at sub-microsecond task cost is most of what
      // gets measured.
      const result = fn()
      consume(isPromiseLike(result) ? await result : result)
    }
    const trialEnd = Bun.nanoseconds()
    trials.push({ i, wallNs: (trialEnd - trialStart) / batchSize })
    i++
    elapsed = Bun.nanoseconds() - start
    if (opts.gc) Bun.gc(true)
  }

  const samples = trials.map((t) => t.wallNs)
  const timing = computeTimingStats(samples)
  const warnings = timingWarnings(timing, [], "inprocess")
  return { trials, timing, warnings }
}
