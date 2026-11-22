import type { CpuEvidence } from "../ir/types.ts";
import { isRawCpuProfile, parseCpuProfile } from "./cpu-parse.ts";
import {
  DEFAULT_SAMPLING_INTERVAL_US,
  type SamplingOptions,
} from "./sampling.ts";

interface InspectorCaptureResult<T> {
  result: T;
  cpu: CpuEvidence;
  diagnosticWallNs: number;
}

export async function captureInspectorProfile<T>(
  fn: () => T | Promise<T>,
  opts: SamplingOptions = {},
): Promise<InspectorCaptureResult<T>> {
  const intervalUs = opts.intervalUs ?? DEFAULT_SAMPLING_INTERVAL_US;
  // perf: imported lazily, since importing node:inspector costs ~4ms of
  // startup for every invocation.
  const { Session } = await import("node:inspector/promises");
  const session = new Session();
  session.connect();

  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", {
      interval: intervalUs,
    });
    // Diagnostic window: profiler start through stop, nothing else. Matches
    // the jsc capture, which can only time `profile()` as a whole.
    const start = Bun.nanoseconds();
    await session.post("Profiler.start");

    const result = await fn();

    const { profile } = await session.post("Profiler.stop");
    if (!isRawCpuProfile(profile)) {
      throw new Error("ostia: the inspector returned no CPU profile");
    }
    const diagnosticWallNs = Bun.nanoseconds() - start;
    const cpu = parseCpuProfile(profile, "inspector", intervalUs);
    return { result, cpu, diagnosticWallNs };
  } finally {
    session.disconnect();
  }
}
