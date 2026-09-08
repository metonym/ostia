import { describe, expect, test } from "bun:test"

const CLI = `${import.meta.dir}/../../src/cli/main.ts`

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("ostia time -- <argv...>", () => {
  test("runs once with a space-containing argument preserved, unsplit", async () => {
    const { stdout, exitCode } = await runCli([
      "time",
      "--samples",
      "1",
      "--warmup",
      "0",
      "--format",
      "json",
      "--",
      "bun",
      "-e",
      "console.log('a b')",
    ])
    expect(exitCode).toBe(0)
    const doc = JSON.parse(stdout)
    expect(doc.workloads).toHaveLength(1)
    expect(doc.workloads[0].command).toEqual([
      "bun",
      "-e",
      "console.log('a b')",
    ])
    expect(doc.measurements[0].trials).toHaveLength(1)
  }, 20_000)

  test("combines with a regular string command given before --", async () => {
    const { stdout, exitCode } = await runCli([
      "time",
      "--samples",
      "1",
      "--warmup",
      "0",
      "--format",
      "json",
      "bun -e 1",
      "--",
      "bun",
      "-e",
      "console.log('two words')",
    ])
    expect(exitCode).toBe(0)
    const doc = JSON.parse(stdout)
    expect(doc.workloads).toHaveLength(2)
    expect(doc.workloads[1].command).toEqual([
      "bun",
      "-e",
      "console.log('two words')",
    ])
  }, 20_000)

  test("a flag-shaped token after -- belongs to the command, not the CLI parser", async () => {
    const { stdout, exitCode } = await runCli([
      "time",
      "--samples",
      "1",
      "--warmup",
      "0",
      "--format",
      "json",
      "--",
      "bun",
      "-e",
      "console.log(process.argv.includes('--quiet'))",
      "--quiet",
    ])
    expect(exitCode).toBe(0)
    // If --quiet had been consumed by the CLI parser instead of passed
    // through to the command, this document (and its rendered report)
    // wouldn't have been suppressed - but it also wouldn't see --quiet in
    // its own argv. The report being present at all proves --quiet wasn't
    // swallowed by the time command's own flag parsing.
    expect(stdout.length).toBeGreaterThan(0)
    const doc = JSON.parse(stdout)
    expect(doc.workloads[0].command).toContain("--quiet")
  }, 20_000)
})
