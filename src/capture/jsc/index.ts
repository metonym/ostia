import { profile as jscProfile } from "bun:jsc"
import type { CpuEvidence, JitTierBreakdown } from "../../ir/types.ts"
import {
  DEFAULT_SAMPLING_INTERVAL_US,
  type SamplingOptions,
} from "../sampling.ts"
import { parseJscProfile, type RawStackTraces } from "./parse.ts"

export interface JscCaptureResult<T> {
  result: T
  cpu: CpuEvidence
  jit: JitTierBreakdown
  diagnosticWallNs: number
}

export async function captureJscProfile<T>(
  fn: () => T | Promise<T>,
  opts: SamplingOptions = {},
): Promise<JscCaptureResult<T>> {
  const intervalUs = opts.intervalUs ?? DEFAULT_SAMPLING_INTERVAL_US
  let result!: T // `bun:jsc.profile` returns only the profile, not fn's value

  // Diagnostic window: profiler start through stop, nothing else. Matches the
  // inspector capture, whose session setup is outside it.
  const start = Bun.nanoseconds()
  const raw = (await jscProfile(async () => {
    result = await fn()
    return result
  }, intervalUs)) as unknown as { stackTraces: RawStackTraces }
  const diagnosticWallNs = Bun.nanoseconds() - start

  const { cpu, jit } = parseJscProfile(raw.stackTraces, intervalUs)
  return { result, cpu, jit, diagnosticWallNs }
}
