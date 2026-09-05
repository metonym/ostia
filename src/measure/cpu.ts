import { captureJscProfile } from "../capture/jsc/index.ts"
import type { CpuEvidence, JitTierBreakdown, Warning } from "../ir/types.ts"

const DEFAULT_WINDOW_MS = 200
const JIT_COLD_THRESHOLD_PCT = 20

export interface TaskCpuCaptureResult {
  cpu: CpuEvidence
  jit: JitTierBreakdown
  diagnosticWallNs: number
}

/** Runs `fn` in a loop for `windowMs` (default 200) under `bun:jsc`'s
 * sampling profiler, so a fast in-process task collects enough samples to
 * be meaningful - a single call is usually gone before the profiler's
 * first tick. A separate, instrumented measurement from timing: this never
 * feeds the task's timing stats, the same rule `ostia time --cpu` follows. */
export async function captureTaskCpuProfile(
  fn: () => unknown | Promise<unknown>,
  windowMs: number = DEFAULT_WINDOW_MS,
): Promise<TaskCpuCaptureResult> {
  const budgetNs = windowMs * 1e6
  const looped = async (): Promise<void> => {
    const start = Bun.nanoseconds()
    while (Bun.nanoseconds() - start < budgetNs) {
      const result = fn()
      if (result instanceof Promise) await result
    }
  }
  const { cpu, jit, diagnosticWallNs } = await captureJscProfile(looped)
  return { cpu, jit, diagnosticWallNs }
}

/** More than `JIT_COLD_THRESHOLD_PCT`% of a `--cpu` capture's samples still in
 * llint/baseline means the JIT never warmed the task up in that 200ms window,
 * so its CPU (and, by extension, timing) numbers may not reflect steady state. */
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
