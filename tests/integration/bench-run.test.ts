import { describe, expect, test } from "bun:test"

const FIXTURE = `${import.meta.dir}/../fixtures/bench-suite-run.ts`

describe("run() spawned as `bun suite.ts` directly - no ostia CLI, no bench() subprocess", () => {
  test("registers, measures, prints a report, and lets cleanup sit in try/finally", async () => {
    const proc = Bun.spawn(["bun", FIXTURE], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("solo")
  }, 20_000)
})
