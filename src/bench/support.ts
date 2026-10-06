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
import type { PeakMemResult } from "../measure/peak.ts"
import { formatBytes } from "../renderers/format.ts"
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

/** Fresh processes per `--peak-mem` reading; the median is reported. */
export const PEAK_MEM_PROCESSES = 3
// Below this, slack is what any suite that loads fixtures leaves behind
// (8MB for caligula's) and too common to warn about.
const PEAK_SLACK_NOISE_BYTES = 16 * 1024 * 1024

/** A `peak-hidden` warning when memory freed before the call may have hidden
 * part of its peak in `readings` (one task's fresh processes). */
export function peakHiddenWarning(
  readings: PeakMemResult[],
): Warning | undefined {
  const peak = median(readings.map((r) => r.peakBytes))
  const slack = Math.max(...readings.map((r) => r.slackBytes))
  if (slack < PEAK_SLACK_NOISE_BYTES || slack <= peak / 4) return undefined
  return {
    code: "peak-hidden",
    message: `Before the call, earlier work in the process had freed up to ${formatBytes(slack)} the allocator still held (module-scope setup or before hooks that allocate), which the call could reuse without RSS rising: this reading can be low by up to that much. Skip that work when process.env.OSTIA_PEAK_MEM is set.`,
    data: { slackBytes: slack, processes: readings.length },
  }
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
  /** Receives the runner's IPC messages. */
  ipc?: (message: never) => void
  /** Where the runner writes why it failed; its text, when present, goes in
   * the error for a non-zero exit. */
  errorFile?: string
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
    ...(opts.ipc && { ipc: opts.ipc }),
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
    const reason = opts.errorFile && Bun.file(opts.errorFile)
    throw new Error(
      reason && (await reason.exists())
        ? `${opts.label} failed: ${opts.name}: ${await reason.text()}`
        : `${opts.label} failed: ${opts.name} (runner exited ${exitCode})`,
    )
  }
  return true
}
