import type { GitMetadata } from "./types.ts"

const GIT_TIMEOUT_MS = 200

let memo: { git: GitMetadata | undefined } | undefined

function runGit(args: string[]): string | undefined {
  const proc = Bun.spawnSync(["git", ...args], {
    timeout: GIT_TIMEOUT_MS,
    stdout: "pipe",
    stderr: "ignore",
  })
  return proc.success ? proc.stdout.toString().trim() : undefined
}

function readGitMetadata(): GitMetadata | undefined {
  try {
    const sha = runGit(["rev-parse", "--short", "HEAD"])
    if (sha === undefined) return undefined
    return {
      sha,
      branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD",
      dirty: (runGit(["status", "--porcelain"])?.length ?? 0) > 0,
    }
  } catch {
    return undefined
  }
}

/** Repo state of the process's cwd, memoized for the process lifetime.
 * Undefined outside a repo, without `git`, or past the 200ms per-call timeout:
 * metadata is never worth failing a measurement over. */
export function captureGitMetadata(): GitMetadata | undefined {
  memo ??= { git: readGitMetadata() }
  return memo.git
}
