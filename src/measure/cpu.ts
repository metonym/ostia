import { captureJscProfile } from "../capture/jsc/index.ts"
import type { CpuEvidence, JitTierBreakdown, Warning } from "../ir/types.ts"
import { cpuSampleCount } from "../renderers/format.ts"
import { isPromiseLike } from "./inprocess.ts"

/** `--cpu`'s default sampling interval for in-process tasks. JSC's 1000µs
 * default gives a ~3ms task about three samples per call, too few for a
 * top-frame table to hold still between runs. */
export const DEFAULT_TASK_CPU_INTERVAL_US = 100
/** Samples a capture aims for. The window is sized from the interval to
 * reach it; the sampler doesn't manage one sample per interval (about 0.6 at
 * 100µs, 0.8 at 1000µs on an idle M2), hence the 2x. */
const TARGET_SAMPLES = 2000
const WINDOW_SLACK = 2
const MIN_WINDOW_MS = 200
const MAX_WINDOW_MS = 10_000
/** Below this many samples, `--cpu` warns `low-sample-count`. */
const LOW_SAMPLES = TARGET_SAMPLES / 2
const JIT_COLD_THRESHOLD_PCT = 20

export interface TaskCpuCaptureOptions {
  /** Sampling interval, µs (default: `DEFAULT_TASK_CPU_INTERVAL_US`). */
  intervalUs?: number
}

export interface TaskCpuCaptureResult {
  cpu: CpuEvidence
  jit: JitTierBreakdown
  diagnosticWallNs: number
  warnings: Warning[]
}

/** How long a capture loops the task: long enough to collect about
 * `TARGET_SAMPLES` at `intervalUs`, within [200ms, 10s]. A task slower than
 * the window still runs once, whole. */
export function cpuWindowMs(intervalUs: number): number {
  const ms = (TARGET_SAMPLES * WINDOW_SLACK * intervalUs) / 1000
  return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, ms))
}

/** Loops `fn` under `bun:jsc`'s sampling profiler for `cpuWindowMs`, so a
 * fast in-process task collects enough samples to be meaningful - a single
 * call is usually gone before the profiler's first tick. A separate,
 * instrumented measurement from timing: this never feeds the task's timing
 * stats, the same rule `ostia time --cpu` follows. */
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
  const warnings: Warning[] = []
  const lowSamples = lowCpuSampleWarning(cpu)
  if (lowSamples) warnings.push(lowSamples)
  const jitWarning = jitColdWarning(jit)
  if (jitWarning) warnings.push(jitWarning)
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

/** More than `JIT_COLD_THRESHOLD_PCT`% of a `--cpu` capture's samples still in
 * llint/baseline means the JIT never warmed the task up during the capture,
 * so its CPU (and, by extension, timing) numbers may not reflect steady
 * state. */
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
