import { statSync } from "node:fs"
import { rm } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { OstiaUsageError } from "../errors.ts"
import { loadDocument } from "../ir/document.ts"
import type { Measurement, ProfileDocument, Warning } from "../ir/types.ts"
import {
  captureEnvironment,
  noisyMachineWarning,
} from "../measure/environment.ts"
import { killSwitch } from "../spawn/index.ts"
import { percentile } from "../stats/index.ts"

// A plain join, not path.resolve: the path is hashed into workload ids, so
// normalizing "./x" would orphan existing baselines.
export function absolutePath(cwd: string, file: string): string {
  return isAbsolute(file) ? file : `${cwd}/${file}`
}

/** A suite file named on the command line or in config doesn't exist. */
class SuiteNotFoundError extends OstiaUsageError {}

/** Throws `SuiteNotFoundError` unless `absolute` is a file; `given` is the
 * path as the caller wrote it, for the message. */
export function assertSuiteExists(given: string, absolute: string): void {
  if (!statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
    throw new SuiteNotFoundError(`Suite not found: ${given}`)
  }
}

/** A scratch directory under `outDir` no other run shares, so concurrent
 * `bench()`/`ab()` calls (or a rerun after a crash) never delete each
 * other's files. */
export function uniqueTmpDir(outDir: string, kind: "bench" | "ab"): string {
  return `${outDir}/${kind}-tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
}

export function median(values: number[]): number {
  return percentile(Float64Array.from(values).sort(), 0.5)
}

export function removeDir(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true })
}

/** `undefined` when a runner killed mid-run never wrote its output. */
export async function loadIfExists(
  path: string,
): Promise<ProfileDocument | undefined> {
  return (await Bun.file(path).exists()) ? loadDocument(path) : undefined
}

export function captureRunEnvironment(noiseCheck: boolean | undefined) {
  const environment = noiseCheck === false ? undefined : captureEnvironment()
  return {
    environment,
    noiseWarning: environment && noisyMachineWarning(environment),
  }
}

/** Noise warning on the first measurement, `aborted` message on the last. */
export function stampRunWarnings(
  measurements: Measurement[],
  noiseWarning: Warning | undefined,
  abortedMessage: string | undefined,
): void {
  const first = measurements[0]
  const last = measurements[measurements.length - 1]
  if (!first || !last) return
  if (noiseWarning) first.warnings.push(noiseWarning)
  if (abortedMessage) {
    last.warnings.push({ code: "aborted", message: abortedMessage })
  }
}

export interface RunnerProcessOptions {
  /** Prefix for error messages, e.g. "Bench suite". */
  label: string
  /** What the error messages name: the suite file. */
  name: string
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /** Children to SIGKILL if a sibling fails. */
  inFlight?: Set<Bun.Subprocess>
}

/** Runs one runner subprocess to completion. Resolves `false` when the
 * caller's signal cancelled it (not a failure), `true` on a clean exit. */
export async function runRunnerProcess(
  argv: string[],
  opts: RunnerProcessOptions,
): Promise<boolean> {
  const kill = killSwitch(opts.timeoutMs, opts.signal)
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    ...(opts.env && { env: { ...process.env, ...opts.env } }),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    ...kill.spawn,
  })
  opts.inFlight?.add(proc)
  let exitCode: number
  try {
    exitCode = await proc.exited
  } finally {
    opts.inFlight?.delete(proc)
  }
  if (opts.signal?.aborted) return false
  if (kill.timedOut()) {
    throw new Error(
      `${opts.label} timed out after ${opts.timeoutMs}ms: ${opts.name}`,
    )
  }
  if (exitCode !== 0) {
    throw new Error(
      `${opts.label} failed: ${opts.name} (runner exited ${exitCode})`,
    )
  }
  return true
}
