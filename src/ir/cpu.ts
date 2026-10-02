import type { CpuEvidence } from "./types.ts"

/** The sample stream's length when the capture kept one, else the summed
 * per-frame self counts. */
export function cpuSampleCount(cpu: CpuEvidence): number {
  return (
    cpu.samples?.nodeIds.length ??
    cpu.totals.reduce((sum, t) => sum + t.samples, 0)
  )
}
