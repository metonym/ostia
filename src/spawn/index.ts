export interface TrialResult {
  wallNs: number
  exitCode: number
  userNs?: number
  systemNs?: number
  maxRssBytes?: number
  /** The command's own reported time, parsed from its output with
   * `timeSource`, in ns. Only present when `timeSource` is set. */
  reportedNs?: number
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
  const proc = Bun.spawn(opts.argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: capture ? "pipe" : "ignore",
    stderr: capture ? "pipe" : "ignore",
    stdin: "ignore",
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
    exitCode,
    userNs: usage ? Number(usage.cpuTime.user) * 1000 : undefined,
    systemNs: usage ? Number(usage.cpuTime.system) * 1000 : undefined,
    maxRssBytes: usage?.maxRSS,
  }
  if (output && opts.timeSource) {
    const [stdout, stderr] = await output
    result.reportedNs = parseReportedTime(
      opts.timeSource,
      stdout,
      stderr,
      opts.argv,
    )
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
 * command's `cwd`/`env` with output discarded and must exit 0. */
export async function runPrepare(
  hook: PrepareHook,
  run: PrepareRun,
  opts: { cwd?: string; env?: Record<string, string> },
): Promise<void> {
  if (typeof hook === "function") {
    await hook(run)
    return
  }
  const argv = prepareArgv(hook)!
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "ignore",
    stderr: "inherit",
    stdin: "ignore",
  })
  const exitCode = await proc.exited
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
