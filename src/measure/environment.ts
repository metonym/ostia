import os from "node:os"
import type { Environment, Warning } from "../ir/types.ts"
import { measureNoiseFloor } from "./noise.ts"

const LOAD_WARNING_FRACTION = 0.75

/** Takes ~200ms (runs the noise-floor workload): call once per invocation, not per workload. */
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

export function noisyMachineWarning(env: Environment): Warning | undefined {
  if (env.loadAvg1 <= env.cores * LOAD_WARNING_FRACTION) return undefined
  return {
    code: "noisy-machine",
    message: `Load average ${env.loadAvg1.toFixed(2)} exceeds ${LOAD_WARNING_FRACTION * 100}% of ${env.cores} available core(s); timing noise may be elevated.`,
    data: { loadAvg1: env.loadAvg1, cores: env.cores },
  }
}
