import type { CpuEvidence, Warning } from "../../ir/types.ts"
import { type ProfiledRunOptions, runProfiled } from "../bunflags.ts"
import { parseCpuProfile, type RawCpuProfile } from "./parse.ts"

export interface CpuCaptureOptions extends ProfiledRunOptions {
  intervalUs: number
}

export interface CpuCaptureResult {
  diagnosticWallNs: number
  exitCode: number
  artifactPath?: string
  cpu?: CpuEvidence
  warnings: Warning[]
}

// BUN_CPU_PROFILE is documented but doesn't work on Bun 1.4.0, hence flags/BUN_OPTIONS.
export async function runCpuCapture(
  opts: CpuCaptureOptions,
): Promise<CpuCaptureResult> {
  const { raw, ...run } = await runProfiled<RawCpuProfile>(
    opts,
    [
      "--cpu-prof",
      "--cpu-prof-dir",
      opts.artifactDir,
      "--cpu-prof-name",
      opts.fileName,
      "--cpu-prof-interval",
      String(opts.intervalUs),
    ],
    { what: "a .cpuprofile", kind: "CPU" },
  )
  if (!raw) return run

  if (raw.samples.length === 0) {
    run.warnings.push({
      code: "empty-profile",
      message: "CPU capture produced zero samples.",
    })
  }
  return { ...run, cpu: parseCpuProfile(raw, "cpu-prof", opts.intervalUs) }
}
