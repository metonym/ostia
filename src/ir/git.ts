import type { GitMetadata } from "./types.ts"

const GIT_TIMEOUT_MS = 200

let cached: GitMetadata | undefined
let computed = false

function runGit(args: string[]): string | undefined {
  const proc = Bun.spawnSync(["git", ...args], {
    timeout: GIT_TIMEOUT_MS,
    stdout: "pipe",
    stderr: "ignore",
  })
  return proc.success ? proc.stdout.toString().trim() : undefined
}

/** `git rev-parse`/`git status --porcelain` in the process's cwd, memoized
 * for the process's lifetime (repo state doesn't change mid-run). Silently
 * returns `undefined` outside a repo, without `git` installed, or if any
 * call runs past its 200ms timeout - this is metadata, never worth failing
 * a measurement over. */
export function captureGitMetadata(): GitMetadata | undefined {
  if (computed) return cached
  computed = true

  try {
    const sha = runGit(["rev-parse", "--short", "HEAD"])
    if (sha === undefined) {
      cached = undefined
    } else {
      const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"])
      const status = runGit(["status", "--porcelain"])
      cached = {
        sha,
        branch: branch ?? "HEAD",
        dirty: (status?.length ?? 0) > 0,
      }
    }
  } catch {
    cached = undefined
  }

  return cached
}
