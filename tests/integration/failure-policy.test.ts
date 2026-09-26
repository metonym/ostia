import { describe, expect, test } from "bun:test"
import { runTimingPhase } from "../../src/measure/timing.ts"

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

describe("ostia time - failure policy / exit codes", () => {
  test("a command that exits non-zero exits 2 (not 1), stopping after the failing trial", async () => {
    const { stdout, exitCode } = await runCli([
      "time",
      "--samples",
      "3",
      "--warmup",
      "0",
      "--format",
      "json",
      "bun -e process.exit(3)",
    ])
    expect(exitCode).toBe(2)
    const doc = JSON.parse(stdout)
    const measurement = doc.measurements[0]
    expect(measurement.trials).toHaveLength(1)
    expect(measurement.trials[0].exitCode).toBe(3)
    expect(
      measurement.warnings.some(
        (w: { code: string }) => w.code === "nonzero-exit",
      ),
    ).toBe(true)
  }, 20_000)

  test("--ignore-failure=3 treats exit code 3 as success: exit 0, no nonzero-exit warning", async () => {
    const { stdout, exitCode } = await runCli([
      "time",
      "--samples",
      "3",
      "--warmup",
      "0",
      "--format",
      "json",
      "--ignore-failure=3",
      "bun -e process.exit(3)",
    ])
    expect(exitCode).toBe(0)
    const doc = JSON.parse(stdout)
    const measurement = doc.measurements[0]
    expect(measurement.trials).toHaveLength(3)
    expect(
      measurement.warnings.some(
        (w: { code: string }) => w.code === "nonzero-exit",
      ),
    ).toBe(false)
  }, 20_000)

  test("bare --ignore-failure ignores any exit code", async () => {
    const { exitCode } = await runCli([
      "time",
      "--samples",
      "1",
      "--warmup",
      "0",
      "--quiet",
      "--ignore-failure",
      "bun -e process.exit(42)",
    ])
    expect(exitCode).toBe(0)
  }, 20_000)
})

describe("fail-fast / ignoreExitCodes - measure/timing", () => {
  test("the trial loop stops after the first non-ignored non-zero exit, keeping that trial's sample", async () => {
    const result = await runTimingPhase({
      argv: ["bun", "-e", "process.exit(1)"],
      samples: 10,
      warmup: 0,
    })
    expect(result.trials).toHaveLength(1)
    expect(result.trials[0]!.exitCode).toBe(1)
  }, 20_000)

  test("an ignored exit code doesn't stop the loop early", async () => {
    const result = await runTimingPhase({
      argv: ["bun", "-e", "process.exit(1)"],
      samples: 3,
      warmup: 0,
      ignoreExitCodes: [1],
    })
    expect(result.trials).toHaveLength(3)
    expect(result.warnings.some((w) => w.code === "nonzero-exit")).toBe(false)
  }, 20_000)
})
