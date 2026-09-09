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
  /** Set when `timeSource` was configured but its pattern didn't match this
   * trial's output. A trial with this set has no `reportedNs` and
   * contributes no sample - it isn't a fallback to `wallNs`, which would
   * silently mix wall-clock time into a reported-time series. */
  timeSourceNoMatch?: true
  /** A 2 KiB-max excerpt of this trial's output, only set alongside
   * `timeSourceNoMatch`. Not part of the persisted `Trial` (it would bloat
   * the document once per miss); the timing phase folds one excerpt into
   * the aggregate `time-source-no-match` warning instead. */
  timeSourceMissOutput?: string
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
 * trial whose output doesn't match contributes no sample (a
 * `time-source-no-match` warning records it) rather than aborting the
 * whole run; if every trial of a workload misses, that workload has no
 * timing stats. `pattern` as a `RegExp` must not carry the `g`, `y`, or `d`
 * flag - `exec` is called on it once per trial, and a `g`/`y` flag makes a
 * reused `RegExp` alternate match/no-match via `lastIndex` across those
 * calls. A plain (flagless) pattern, string or `RegExp`, is always safe to
 * reuse. */
export interface TimeSource {
  pattern: string | RegExp
  group?: number
  unit?: TimeUnit
}

/** Thrown by `parseReportedTime` specifically when the pattern didn't match
 * at all (as opposed to matching but the capture group being missing or
 * non-numeric, which are configuration errors, not a per-trial miss).
 * `runTrial` catches this one specifically to record a per-trial miss
 * instead of failing the whole run. */
class TimeSourceNoMatchError extends Error {}

/** `TimeSource.pattern` is compiled once per workload and `exec`'d once per
 * trial for the life of the run, so a `g`/`y` flag - which advances
 * `lastIndex` on every match - would make it alternate match/no-match across
 * trials instead of testing the same thing each time. `d` (hasIndices) is
 * rejected too since it's never useful here (nothing reads match indices)
 * and its presence usually signals the same copy-pasted-flags mistake.
 * Called once per workload (not per trial) so a bad pattern fails fast
 * before any trial runs. */
export function assertReusableTimeSource(source: TimeSource): void {
  if (typeof source.pattern === "string") return
  const { flags } = source.pattern
  if (flags.includes("g") || flags.includes("y") || flags.includes("d")) {
    throw new RangeError("timeSource pattern must not use the g or y flag")
  }
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
function combineSignals(
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

/** The kill switch for one spawned process: `timeoutMs` (per process) and
 * the caller's run-wide `signal`, folded into spawn options that SIGKILL on
 * either, plus `timedOut()` to tell a timeout apart from a caller-driven
 * cancellation after the fact. */
export function killSwitch(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): {
  spawn: { signal?: AbortSignal; killSignal?: "SIGKILL" }
  timedOut: () => boolean
} {
  const timeout =
    timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined
  const combined = combineSignals(timeout, signal)
  return {
    spawn: combined ? { signal: combined, killSignal: "SIGKILL" } : {},
    timedOut: () => timeout?.aborted ?? false,
  }
}

export async function runTrial(opts: SpawnTrialOptions): Promise<TrialResult> {
  const capture = opts.timeSource !== undefined
  const start = Bun.nanoseconds()

  const kill = killSwitch(opts.timeoutMs, opts.signal)
  const proc = Bun.spawn(opts.argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: capture ? "pipe" : "ignore",
    stderr: capture ? "pipe" : "ignore",
    stdin: "ignore",
    ...kill.spawn,
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
  const timedOut = kill.timedOut()

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
      try {
        result.reportedNs = parseReportedTime(
          opts.timeSource,
          stdout,
          stderr,
          opts.argv,
        )
      } catch (err) {
        // A flat-out miss is this trial's problem, not the run's: drop the
        // sample and let the caller decide (a `time-source-no-match`
        // warning, not a thrown error). A matched-but-malformed capture
        // (missing group, non-numeric) is a configuration error instead -
        // every trial would hit it identically, so it still throws.
        if (!(err instanceof TimeSourceNoMatchError)) throw err
        result.timeSourceNoMatch = true
        result.timeSourceMissOutput = excerptForNoMatch(stdout, stderr)
      }
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
    throw new TimeSourceNoMatchError(
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

const NO_MATCH_OUTPUT_LIMIT_BYTES = 2048

/** The `output` sample folded into a `time-source-no-match` warning's
 * `data`, capped at 2 KiB total (not per-stream, unlike `excerpt`): the
 * warning is meant to show enough to see why the pattern missed, not to
 * carry the whole capture. */
function excerptForNoMatch(stdout: string, stderr: string): string {
  const full = excerpt(stdout, stderr)
  if (Buffer.byteLength(full, "utf8") <= NO_MATCH_OUTPUT_LIMIT_BYTES) {
    return full
  }
  let sliced = full.slice(0, NO_MATCH_OUTPUT_LIMIT_BYTES)
  while (Buffer.byteLength(sliced, "utf8") > NO_MATCH_OUTPUT_LIMIT_BYTES) {
    sliced = sliced.slice(0, -1)
  }
  return `${sliced}…`
}

const OUTPUT_CAP_BYTES = 1024 * 1024
const ELIDED_MARKER = (n: number) => `\n…(${n} bytes elided)…\n`

/** Reads a stream into a string capped at `capBytes` total: the first half
 * and the last half, joined by a marker, with the true memory footprint
 * bounded to roughly `capBytes` regardless of how much the stream actually
 * produces (the middle is dropped as it arrives, never buffered). Used for
 * output that's shown on failure for debugging, not measured or parsed - a
 * `--prepare` hook that misbehaves and dumps gigabytes to stderr shouldn't
 * be able to blow up the run's memory just to report why it failed.
 * Contrast `timeSource`'s own capture (`runTrial`), which deliberately
 * stays unbounded: a build tool's summary line the regex needs to match
 * could be anywhere in a large output, so truncating it there would trade
 * a memory bound for silently-wrong matches. */
export async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  capBytes: number = OUTPUT_CAP_BYTES,
): Promise<string> {
  const halfBytes = Math.floor(capBytes / 2)
  const reader = stream.getReader()
  const headChunks: Uint8Array[] = []
  let headBytes = 0
  const tailChunks: Uint8Array[] = []
  let tailBytes = 0
  let totalBytes = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      totalBytes += value.byteLength

      let chunk = value
      if (headBytes < halfBytes) {
        const room = halfBytes - headBytes
        if (chunk.byteLength <= room) {
          headChunks.push(chunk)
          headBytes += chunk.byteLength
          continue
        }
        headChunks.push(chunk.subarray(0, room))
        headBytes += room
        chunk = chunk.subarray(room)
      }
      tailChunks.push(chunk)
      tailBytes += chunk.byteLength
      // Trim the tail buffer down to its last `halfBytes` as it grows, so
      // memory never scales with the stream's total size.
      while (tailBytes > halfBytes && tailChunks.length > 0) {
        const first = tailChunks[0]!
        const excess = tailBytes - halfBytes
        if (first.byteLength <= excess) {
          tailChunks.shift()
          tailBytes -= first.byteLength
        } else {
          tailChunks[0] = first.subarray(excess)
          tailBytes -= excess
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const decoder = new TextDecoder()
  const head = decoder.decode(concatChunks(headChunks))
  if (totalBytes <= headBytes + tailBytes) return head
  const tail = decoder.decode(concatChunks(tailChunks))
  const elidedBytes = totalBytes - headBytes - tailBytes
  return `${head}${ELIDED_MARKER(elidedBytes)}${tail}`
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** Runs a `prepare` hook ahead of one trial. Command forms spawn in the
 * command's `cwd`/`env` with stdout discarded and must exit 0. `timeoutMs`
 * (no default: function hooks can't be killed this way and are never timed
 * out) kills a hung command-form hook with SIGKILL and aborts the run with a
 * clear message, the same way a non-zero exit already does. `signal` kills a
 * command-form hook the same way, but silently: a caller-driven cancellation
 * isn't a failure, so it never throws (the run is already stopping).
 * stderr is captured (bounded to 1 MiB, `readBoundedText`) rather than
 * streamed live, so a hook re-run before every trial doesn't flood the
 * terminal - it's folded into the thrown error instead, on the (timeout or
 * non-zero exit) trials where the hook actually failed. */
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
  const kill = killSwitch(opts.timeoutMs, opts.signal)
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
    ...kill.spawn,
  })
  // Drains concurrently with waiting on exit regardless of whether the
  // success path below ever awaits it, so a chatty hook can't block on a
  // full pipe; `.catch` keeps a stream error from becoming an unhandled
  // rejection when nothing reads this promise.
  const stderrText = readBoundedText(proc.stderr as ReadableStream).catch(
    () => "",
  )
  const exitCode = await proc.exited
  if (kill.timedOut()) {
    const stderr = (await stderrText).trim()
    throw new Error(
      `prepare command "${argv.join(" ")}" timed out after ${opts.timeoutMs}ms before ${run.phase} trial ${run.index}.${stderr ? `\n${stderr}` : ""}`,
    )
  }
  // Killed by the caller's signal, not a timeout or the command itself: the
  // run is already winding down, so this isn't a new failure to report.
  if (opts.signal?.aborted) return
  if (exitCode !== 0) {
    const stderr = (await stderrText).trim()
    throw new Error(
      `prepare command "${argv.join(" ")}" exited with code ${exitCode} before ${run.phase} trial ${run.index}.${stderr ? `\n${stderr}` : ""}`,
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
