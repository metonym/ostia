import { captureInspectorProfile } from "./capture/inspector/index.ts"
import { captureJscProfile } from "./capture/jsc/index.ts"
import {
  configFingerprint,
  createDocument,
  makeInprocessWorkload,
  makeInstrumentedMeasurement,
} from "./ir/document.ts"
import type { Measurement, ProfileDocument, Warning } from "./ir/types.ts"
import { abortedWarning, DEFAULT_CPU_INTERVAL_US } from "./time.ts"

export interface ProfileOptions {
  /** Sampling interval in µs; default 1000. Named like `time()`'s and
   * `bench()`'s option, the config key and `--cpu-interval`. */
  cpuIntervalUs?: number
  /** Names the workload: it becomes the label and, instead of the function's
   * name and source, what the id hashes, so closures that differ only in
   * captured values get distinct ids and the id survives editing the function. */
  name?: string
  /** `"inspector"` (default) captures through CDP and writes a portable
   * .cpuprofile; `"jsc"` uses `bun:jsc.profile` and adds LLInt/Baseline/DFG/FTL
   * tier data. */
  origin?: "inspector" | "jsc"
  /** There's no child to kill, so an already-aborted signal skips the profiler,
   * calls `fn` plain (still returning its `result`) and records an `aborted`
   * warning instead of CPU evidence. It can't interrupt a running `fn`. */
  signal?: AbortSignal
}

export interface ProfileResult<T> {
  result: T
  measurement: Measurement
  document: ProfileDocument
}

export async function profile<T>(
  fn: () => T | Promise<T>,
  opts: ProfileOptions = {},
): Promise<ProfileResult<T>> {
  if (
    opts.name !== undefined &&
    (typeof opts.name !== "string" || !opts.name)
  ) {
    throw new TypeError("profile(): name must be a non-empty string")
  }
  const workload = makeInprocessWorkload(fn, opts.name)
  const intervalUs = opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US
  const configFp = configFingerprint({
    intervalUs,
    origin: opts.origin ?? "inspector",
  })
  const result = (result: T, measurement: Measurement) => ({
    result,
    measurement,
    document: createDocument([workload], [measurement]),
  })

  if (opts.signal?.aborted) {
    const start = Bun.nanoseconds()
    const value = await fn()
    return result(
      value,
      makeInstrumentedMeasurement({
        workload,
        phase: "cpu",
        configFingerprint: configFp,
        diagnosticWallNs: Bun.nanoseconds() - start,
        warnings: [abortedWarning()],
        artifacts: [],
      }),
    )
  }

  const captured =
    opts.origin === "jsc"
      ? await captureJscProfile(fn, { intervalUs })
      : {
          ...(await captureInspectorProfile(fn, { intervalUs })),
          jit: undefined,
        }
  const warnings: Warning[] =
    captured.cpu.samples?.nodeIds.length === 0
      ? [
          {
            code: "empty-profile",
            message: "In-process capture produced zero samples.",
          },
        ]
      : []
  return result(
    captured.result,
    makeInstrumentedMeasurement({
      workload,
      phase: "cpu",
      configFingerprint: configFp,
      diagnosticWallNs: captured.diagnosticWallNs,
      cpu: captured.cpu,
      jit: captured.jit,
      warnings,
      artifacts: [],
    }),
  )
}
