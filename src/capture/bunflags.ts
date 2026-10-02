import type { Warning } from "../ir/types.ts"

// BUN_OPTIONS is split on whitespace; a backslash escapes a space or quote (Bun
// doesn't honour quoting, and a literal backslash can't be expressed).
function escapeBunOption(flag: string): string {
  return flag.replace(/[\s"']/g, "\\$&")
}

export function withBunFlags(
  argv: string[],
  flags: string[],
  env: Record<string, string> | undefined,
): { argv: string[]; env: Record<string, string> | undefined } {
  const bin = argv[0]
  if (bin && /(^|[\\/])bun(\.exe)?$/.test(bin)) {
    return { argv: [bin, ...flags, ...argv.slice(1)], env }
  }
  // A wrapper script that eventually execs bun still picks the flags up. Ours
  // go last so they win over any the caller already set.
  const merged = { ...process.env, ...env } as Record<string, string>
  const ours = flags.map(escapeBunOption).join(" ")
  return {
    argv,
    env: {
      ...merged,
      BUN_OPTIONS: merged.BUN_OPTIONS ? `${merged.BUN_OPTIONS} ${ours}` : ours,
    },
  }
}

export interface ProfiledRunOptions {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  artifactDir: string
  fileName: string
}

export interface ProfiledRun<T> {
  diagnosticWallNs: number
  exitCode: number
  artifactPath?: string
  raw?: T
  warnings: Warning[]
}

/** Runs the workload under bun with profiler `flags` and loads the JSON
 * artifact it wrote; `raw` is absent (with an `artifact-missing` warning) when
 * none appeared. */
export async function runProfiled<T>(
  opts: ProfiledRunOptions,
  flags: string[],
  artifact: { what: string; kind: string },
): Promise<ProfiledRun<T>> {
  const artifactPath = `${opts.artifactDir}/${opts.fileName}`
  const { argv, env } = withBunFlags(opts.argv, flags, opts.env)

  const start = Bun.nanoseconds()
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
  const exitCode = await proc.exited
  const diagnosticWallNs = Bun.nanoseconds() - start

  const file = Bun.file(artifactPath)
  if (!(await file.exists())) {
    return {
      diagnosticWallNs,
      exitCode,
      warnings: [
        {
          code: "artifact-missing",
          message: `Expected ${artifact.what} at ${artifactPath} after exit ${exitCode}, found nothing. The workload's argv[0] must be a \`bun\` binary for ${artifact.kind} capture.`,
          data: { artifactPath, argv: opts.argv },
        },
      ],
    }
  }
  return {
    diagnosticWallNs,
    exitCode,
    artifactPath,
    raw: (await file.json()) as T,
    warnings: [],
  }
}
