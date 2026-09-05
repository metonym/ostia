import os from "node:os"
import type { Environment, Warning } from "../ir/types.ts"
import { measureNoiseFloor } from "./noise.ts"

const LOAD_WARNING_FRACTION = 0.75

/** Captures machine conditions (CPU, cores, load, noise floor) for stamping
 * onto a document. Runs the noise-floor reference workload, so this takes
 * about 200ms - call it once per `time()`/`bench()` invocation, not per
 * workload. */
export function captureEnvironment(): Environment {
  const [loadAvg1 = 0, loadAvg5 = 0] = os.loadavg()
  return {
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cores: os.availableParallelism(),
    loadAvg1,
    loadAvg5,
    noise: measureNoiseFloor(),
  }
}

/** A `noisy-machine` warning when the 1-minute load average is already past
 * 75% of available cores at measurement time - a signal that whatever else
 * is running on this machine, not the workload, may be inflating the
 * numbers. */
export function noisyMachineWarning(env: Environment): Warning | undefined {
  if (env.loadAvg1 <= env.cores * LOAD_WARNING_FRACTION) return undefined
  return {
    code: "noisy-machine",
    message: `Load average ${env.loadAvg1.toFixed(2)} exceeds 75% of ${env.cores} available core(s); timing noise may be elevated.`,
    data: { loadAvg1: env.loadAvg1, cores: env.cores },
  }
}
