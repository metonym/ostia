import { captureJscProfile } from "../capture/jsc/index.ts"
import { cpuSampleCount } from "../ir/cpu.ts"
import type { CpuEvidence, JitTierBreakdown, Warning } from "../ir/types.ts"
import { isPromiseLike } from "./loop.ts"

/** JSC's 1000µs default gives a ~3ms task about three samples per call, too
 * few for a top-frame table to hold still between runs. */
export const DEFAULT_TASK_CPU_INTERVAL_US = 100
/** The sampler manages well under one sample per interval (about 0.6 at 100µs,
 * 0.8 at 1000µs on an idle M2), hence the 2x slack on the window. */
const TARGET_SAMPLES = 2000
const WINDOW_SLACK = 2
const MIN_WINDOW_MS = 200
const MAX_WINDOW_MS = 10_000
const LOW_SAMPLES = TARGET_SAMPLES / 2
const JIT_COLD_THRESHOLD_PCT = 20

export interface TaskCpuCaptureOptions {
  intervalUs?: number
}

export interface TaskCpuCaptureResult {
  cpu: CpuEvidence
  jit: JitTierBreakdown
  diagnosticWallNs: number
  warnings: Warning[]
}

/** Capture window, ms: about `TARGET_SAMPLES` at `intervalUs`, clamped to
 * [200ms, 10s]. A task slower than the window still runs once, whole. */
export function cpuWindowMs(intervalUs: number): number {
  const ms = (TARGET_SAMPLES * WINDOW_SLACK * intervalUs) / 1000
  return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, ms))
}

/** Loops `fn` under the JSC sampling profiler for `cpuWindowMs`; one call is
 * usually gone before the first tick. Never feeds timing stats. */
export async function captureTaskCpuProfile(
  fn: () => unknown | Promise<unknown>,
  opts: TaskCpuCaptureOptions = {},
): Promise<TaskCpuCaptureResult> {
  const intervalUs = opts.intervalUs ?? DEFAULT_TASK_CPU_INTERVAL_US
  const budgetNs = cpuWindowMs(intervalUs) * 1e6
  const looped = async (): Promise<void> => {
    const start = Bun.nanoseconds()
    do {
      const result = fn()
      if (isPromiseLike(result)) await result
    } while (Bun.nanoseconds() - start < budgetNs)
  }
  const { cpu, jit, diagnosticWallNs } = await captureJscProfile(looped, {
    intervalUs,
  })
  const warnings = [lowCpuSampleWarning(cpu), jitColdWarning(jit)].filter(
    (w): w is Warning => w !== undefined,
  )
  return { cpu, jit, diagnosticWallNs, warnings }
}

function lowCpuSampleWarning(cpu: CpuEvidence): Warning | undefined {
  const samples = cpuSampleCount(cpu)
  if (samples >= LOW_SAMPLES) return undefined
  return {
    code: "low-sample-count",
    message: `Only ${samples} CPU sample(s) at ${cpu.samplingIntervalUs}µs (target ${TARGET_SAMPLES}); frame shares this thin move several points between runs. Lower --cpu-interval for more.`,
    data: {
      samples,
      target: TARGET_SAMPLES,
      intervalUs: cpu.samplingIntervalUs,
    },
  }
}

/** Warns when over `JIT_COLD_THRESHOLD_PCT`% of samples are still in llint/baseline. */
export function jitColdWarning(jit: JitTierBreakdown): Warning | undefined {
  const { llint, baseline, dfg, ftl } = jit.tiers
  const total = llint + baseline + dfg + ftl
  if (total === 0) return undefined

  const llintPct = (llint / total) * 100
  const baselinePct = (baseline / total) * 100
  const dfgPct = (dfg / total) * 100
  const ftlPct = (ftl / total) * 100
  if (llintPct + baselinePct <= JIT_COLD_THRESHOLD_PCT) return undefined

  return {
    code: "jit-cold",
    message: `${(llintPct + baselinePct).toFixed(1)}% of CPU samples were in the llint/baseline tiers: the JIT never warmed this task up.`,
    data: { llintPct, baselinePct, dfgPct, ftlPct },
  }
}
