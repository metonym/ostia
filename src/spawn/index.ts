export interface TrialResult {
  wallNs: number
  /** `null` when the trial timed out: the process was killed before it could
   * exit on its own, so its exit code carries no information. */
  exitCode: number | null
  userNs?: number
  systemNs?: number
  maxRssBytes?: number
  /** The command's own reported time, parsed from its output with
   * `timeSource`, in ns. Only present when `timeSource` is set. */
  reportedNs?: number
  /** Set when `timeoutMs` elapsed before the process exited on its own; it
   * was killed with SIGKILL. A timed-out trial contributes no sample. */
  timedOut?: true
}

/** Which trial a `prepare` hook is about to run ahead of. `index` counts
 * from 0 within each phase, so a hook that needs "first run" logic checks
 * `phase === "warmup" && index === 0` (or `phase === "timing"` when warmup
 * is 0). */
export interface PrepareRun {
  phase: "warmup" | "timing" | "cpu" | "heap"
  index: number
}

/** Return value ignored (so `() => Bun.write(...)` is a valid hook);
 * a returned promise is awaited. */
export type PrepareFn = (run: PrepareRun) => unknown

/** Runs before every trial of a command, unmeasured, in the command's own
 * `cwd`/`env`: a shell-less command (string, whitespace-split like the
 * command itself, or argv array) spawned and awaited, or a function for the
 * library API. hyperfine's `--prepare`. A non-zero exit from the command
 * form aborts the run. */
export type PrepareHook = string | string[] | PrepareFn

export type TimeUnit = "ns" | "us" | "ms" | "s"

/** Take a command's timing from a number in its own stdout/stderr instead of
 * the subprocess wall clock - e.g. a build tool's `built in 342ms` summary
 * line, which excludes the runtime's startup cost. `pattern` is matched
 * against stdout, then stderr; `group` (default 1) is the capture group
 * holding the number; `unit` (default "ms") is what that number is in. A
 * trial whose output doesn't match aborts the run: the workload asked for a
 * number that isn't there. */
export interface TimeSource {
  pattern: string | RegExp
  group?: number
  unit?: TimeUnit
}

export interface SpawnTrialOptions {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  timeSource?: TimeSource
  /** Kills the trial's process with SIGKILL if it hasn't exited after this
   * many ms. The trial resolves (never rejects) with `exitCode: null,
   * timedOut: true` and contributes no sample. No default: an unset
   * `timeoutMs` never times out. */
  timeoutMs?: number
  /** Aborting kills this trial's process (if any) with SIGKILL. Distinct
   * from `timeoutMs`: an aborted trial is discarded by the caller rather
   * than recorded as `timedOut`, since cancellation isn't something the
   * command did. */
  signal?: AbortSignal
}

/** Combines any number of possibly-absent signals into one: `undefined` when
 * none are given, the signal itself when exactly one is, `AbortSignal.any`
 * otherwise. Used everywhere a per-trial timeout signal and a caller's
 * run-wide cancellation signal both need to be able to kill the same
 * process. */
export function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined)
  if (defined.length === 0) return undefined
  if (defined.length === 1) return defined[0]
  return AbortSignal.any(defined)
}

const UNIT_NS: Record<TimeUnit, number> = {
  ns: 1,
  us: 1e3,
  ms: 1e6,
  s: 1e9,
}

export async function runTrial(opts: SpawnTrialOptions): Promise<TrialResult> {
  const capture = opts.timeSource !== undefined
  const start = Bun.nanoseconds()

  // Tracked separately from `opts.signal` so a caller-driven cancellation
  // (the run stopping early) is never mistaken for the command overrunning
  // its own timeout.
  let timedOut = false
  const timeoutSignal =
    opts.timeoutMs !== undefined
      ? AbortSignal.timeout(opts.timeoutMs)
      : undefined
  timeoutSignal?.addEventListener(
    "abort",
    () => {
      timedOut = true
    },
    { once: true },
  )
  const signal = combineSignals(timeoutSignal, opts.signal)

  const proc = Bun.spawn(opts.argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: capture ? "pipe" : "ignore",
    stderr: capture ? "pipe" : "ignore",
    stdin: "ignore",
    ...(signal && { signal, killSignal: "SIGKILL" as const }),
  })
  // Drain the pipes concurrently with waiting on exit: a command writing more
  // than the pipe buffer would otherwise block on a full pipe and inflate
  // (or deadlock) the wall-clock measurement.
  const output = capture
    ? Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ])
    : undefined
  const exitCode = await proc.exited
  const end = Bun.nanoseconds()
  const usage = proc.resourceUsage?.()

  const result: TrialResult = {
    wallNs: end - start,
    exitCode: timedOut ? null : exitCode,
    userNs: usage ? Number(usage.cpuTime.user) * 1000 : undefined,
    systemNs: usage ? Number(usage.cpuTime.system) * 1000 : undefined,
    maxRssBytes: usage?.maxRSS,
    ...(timedOut ? { timedOut: true as const } : {}),
  }
  if (output) {
    const [stdout, stderr] = await output
    // A killed process's output is partial at best; there's no reported time
    // to parse out of it, so skip straight past timeSource entirely (the
    // pipes are still drained above either way, so a killed process can't
    // block on a full pipe).
    if (opts.timeSource && !timedOut) {
      result.reportedNs = parseReportedTime(
        opts.timeSource,
        stdout,
        stderr,
        opts.argv,
      )
    }
  }
  return result
}

export function parseReportedTime(
  source: TimeSource,
  stdout: string,
  stderr: string,
  argv: string[] = [],
): number {
  const re =
    typeof source.pattern === "string"
      ? new RegExp(source.pattern)
      : source.pattern
  const group = source.group ?? 1
  const match = re.exec(stdout) ?? re.exec(stderr)
  const label = argv.length > 0 ? ` for "${argv.join(" ")}"` : ""
  if (!match) {
    throw new Error(
      `timeSource pattern ${re} did not match the output${label}. Output was:\n${excerpt(stdout, stderr)}`,
    )
  }
  const raw = match[group]
  if (raw === undefined) {
    throw new Error(
      `timeSource pattern ${re} matched${label} but has no capture group ${group} (matched text: "${match[0]}").`,
    )
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(
      `timeSource pattern ${re} group ${group} captured "${raw}"${label}, which is not a number.`,
    )
  }
  return value * UNIT_NS[source.unit ?? "ms"]
}

function excerpt(stdout: string, stderr: string): string {
  const LIMIT = 800
  const clip = (s: string) =>
    s.length > LIMIT ? `${s.slice(0, LIMIT)}…(${s.length - LIMIT} more)` : s
  const parts: string[] = []
  if (stdout.trim()) parts.push(`--- stdout ---\n${clip(stdout.trimEnd())}`)
  if (stderr.trim()) parts.push(`--- stderr ---\n${clip(stderr.trimEnd())}`)
  return parts.length > 0 ? parts.join("\n") : "(empty)"
}

/** Runs a `prepare` hook ahead of one trial. Command forms spawn in the
 * command's `cwd`/`env` with output discarded and must exit 0. `timeoutMs`
 * (no default: function hooks can't be killed this way and are never timed
 * out) kills a hung command-form hook with SIGKILL and aborts the run with a
 * clear message, the same way a non-zero exit already does. `signal` kills a
 * command-form hook the same way, but silently: a caller-driven cancellation
 * isn't a failure, so it never throws (the run is already stopping). */
export async function runPrepare(
  hook: PrepareHook,
  run: PrepareRun,
  opts: {
    cwd?: string
    env?: Record<string, string>
    timeoutMs?: number
    signal?: AbortSignal
  },
): Promise<void> {
  if (typeof hook === "function") {
    await hook(run)
    return
  }
  const argv = prepareArgv(hook)!
  let timedOut = false
  const timeoutSignal =
    opts.timeoutMs !== undefined
      ? AbortSignal.timeout(opts.timeoutMs)
      : undefined
  timeoutSignal?.addEventListener(
    "abort",
    () => {
      timedOut = true
    },
    { once: true },
  )
  const signal = combineSignals(timeoutSignal, opts.signal)
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "ignore",
    stderr: "inherit",
    stdin: "ignore",
    ...(signal && { signal, killSignal: "SIGKILL" as const }),
  })
  const exitCode = await proc.exited
  if (timedOut) {
    throw new Error(
      `prepare command "${argv.join(" ")}" timed out after ${opts.timeoutMs}ms before ${run.phase} trial ${run.index}.`,
    )
  }
  // Killed by the caller's signal, not a timeout or the command itself: the
  // run is already winding down, so this isn't a new failure to report.
  if (opts.signal?.aborted) return
  if (exitCode !== 0) {
    throw new Error(
      `prepare command "${argv.join(" ")}" exited with code ${exitCode} before ${run.phase} trial ${run.index}.`,
    )
  }
}

/** The serializable shape of a `prepare` hook for the document: the argv of
 * a command form, or nothing for a function (which lives only in the
 * process that ran it). */
export function prepareArgv(
  hook: PrepareHook | undefined,
): string[] | undefined {
  if (hook === undefined || typeof hook === "function") return undefined
  return Array.isArray(hook) ? hook : splitCommand(hook)
}

/** The serializable shape of a `TimeSource`: a `RegExp` pattern becomes its
 * source string (flags dropped, since only `exec` on a single-shot match is
 * ever used). */
export function timeSourceSpec(
  source: TimeSource | undefined,
): SerializedTimeSource | undefined {
  if (source === undefined) return undefined
  return {
    pattern:
      typeof source.pattern === "string"
        ? source.pattern
        : source.pattern.source,
    ...(source.group !== undefined && { group: source.group }),
    ...(source.unit !== undefined && { unit: source.unit }),
  }
}

export interface SerializedTimeSource {
  pattern: string
  group?: number
  unit?: TimeUnit
}

export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}
