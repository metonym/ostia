import { profile as jscProfile } from "bun:jsc"
import type { CpuEvidence, JitTierBreakdown } from "../../ir/types.ts"
import { parseJscProfile, type RawStackTraces } from "./parse.ts"

// `bun:jsc.profile(fn, intervalUs)` only returns the SamplingProfile, not fn's return value.

export interface JscCaptureOptions {
  intervalUs?: number
}

export interface JscCaptureResult<T> {
  result: T
  cpu: CpuEvidence
  jit: JitTierBreakdown
  diagnosticWallNs: number
}

const DEFAULT_INTERVAL_US = 1000

export async function captureJscProfile<T>(
  fn: () => T | Promise<T>,
  opts: JscCaptureOptions = {},
): Promise<JscCaptureResult<T>> {
  const intervalUs = opts.intervalUs ?? DEFAULT_INTERVAL_US
  let result!: T

  const start = Bun.nanoseconds()
  const raw = (await jscProfile(async () => {
    result = await fn()
    return result
  }, intervalUs)) as unknown as { stackTraces: RawStackTraces }
  const diagnosticWallNs = Bun.nanoseconds() - start

  const { cpu, jit } = parseJscProfile(raw.stackTraces, intervalUs)
  return { result, cpu, jit, diagnosticWallNs }
}
