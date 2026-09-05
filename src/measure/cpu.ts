import { captureJscProfile } from "../capture/jsc/index.ts"
import type { CpuEvidence, JitTierBreakdown } from "../ir/types.ts"

const DEFAULT_WINDOW_MS = 200

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
