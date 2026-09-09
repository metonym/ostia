import type { CpuEvidence } from "../../ir/types.ts"
import { parseCpuProfile, type RawCpuProfile } from "../cpu/parse.ts"

export interface InspectorCaptureOptions {
  intervalUs?: number
}

export interface InspectorCaptureResult<T> {
  result: T
  cpu: CpuEvidence
  diagnosticWallNs: number
}

const DEFAULT_INTERVAL_US = 1000

export async function captureInspectorProfile<T>(
  fn: () => T | Promise<T>,
  opts: InspectorCaptureOptions = {},
): Promise<InspectorCaptureResult<T>> {
  const intervalUs = opts.intervalUs ?? DEFAULT_INTERVAL_US
  // Loaded on first use: importing node:inspector costs ~4 ms of process
  // startup, which every `ostia` invocation would otherwise pay.
  const { Session } = await import("node:inspector/promises")
  const session = new Session()
  session.connect()

  const start = Bun.nanoseconds()
  try {
    await session.post("Profiler.enable")
    await session.post("Profiler.setSamplingInterval", { interval: intervalUs })
    await session.post("Profiler.start")

    const result = await fn()

    const { profile } = (await session.post("Profiler.stop")) as {
      profile: RawCpuProfile
    }
    const diagnosticWallNs = Bun.nanoseconds() - start
    const cpu = parseCpuProfile(profile, "inspector", intervalUs)
    return { result, cpu, diagnosticWallNs }
  } finally {
    session.disconnect()
  }
}
