import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const GIT_MODULE = `${import.meta.dir}/../../src/ir/git.ts`

async function runInProcess(cwd: string): Promise<string> {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import { captureGitMetadata } from "${GIT_MODULE}"; console.log(JSON.stringify({ a: captureGitMetadata(), b: captureGitMetadata() }))`,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  expect(exitCode).toBe(0)
  return stdout.trim()
}

describe("captureGitMetadata", () => {
  test("returns sha/branch/dirty inside a real repo, memoized across calls in one process", async () => {
    const repoRoot = `${import.meta.dir}/../..`
    const expectedSha = (
      await new Response(
        Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
          cwd: repoRoot,
          stdout: "pipe",
        }).stdout,
      ).text()
    ).trim()

    const { a, b } = JSON.parse(await runInProcess(repoRoot))
    expect(a).toEqual(b)
    expect(a.sha).toBe(expectedSha)
    expect(typeof a.branch).toBe("string")
    expect(typeof a.dirty).toBe("boolean")
  }, 10_000)

  test("returns undefined outside a git repo", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ostia-git-test-"))
    try {
      const { a, b } = JSON.parse(await runInProcess(outside))
      expect(a).toBeUndefined()
      expect(b).toBeUndefined()
    } finally {
      await Bun.spawn(["rm", "-rf", outside]).exited
    }
  }, 10_000)
})
