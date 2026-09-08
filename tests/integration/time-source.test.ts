import { describe, expect, test } from "bun:test"
import { time } from "../../src/index.ts"

const CLI = `${import.meta.dir}/../../src/cli/main.ts`
const REPORT = `${import.meta.dir}/../fixtures/report-time.ts`

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

describe("time() - time-source resilience across commands", () => {
  test("a command whose --time-source never matches doesn't discard the other command's samples", async () => {
    const doc = await time({
      commands: [
        {
          command: ["bun", REPORT],
          label: "matches",
          timeSource: { pattern: /in (\d+)ms/ },
        },
        {
          command: ["bun", REPORT],
          label: "never-matches",
          timeSource: { pattern: /compiled in (\d+)ms/ },
        },
      ],
      samples: 2,
      warmup: 0,
    })

    expect(doc.measurements).toHaveLength(2)
    const matching = doc.measurements.find((m) => m.timing !== undefined)
    const missing = doc.measurements.find((m) => m.timing === undefined)

    expect(matching).toBeDefined()
    expect(matching?.timing?.samples).toEqual([7e6, 7e6])

    expect(missing).toBeDefined()
    expect(missing?.trials).toHaveLength(2)
    expect(
      missing?.warnings.some((w) => w.code === "time-source-no-match"),
    ).toBe(true)
  }, 20_000)
})

describe("ostia time - time-source resilience (CLI)", () => {
  test("a command whose --time-source never matches exits 2 (harness error) with the warning present, rather than crashing", async () => {
    const { stdout, exitCode } = await runCli([
      "time",
      "--samples",
      "2",
      "--warmup",
      "0",
      "--format",
      "json",
      "--time-source",
      "compiled in (\\d+)ms",
      `bun ${REPORT}`,
    ])

    expect(exitCode).toBe(2)
    const doc = JSON.parse(stdout)
    expect(doc.measurements).toHaveLength(1)
    expect(doc.measurements[0].timing).toBeUndefined()
    expect(doc.measurements[0].trials).toHaveLength(2)
    expect(
      doc.measurements[0].warnings.some(
        (w: { code: string }) => w.code === "time-source-no-match",
      ),
    ).toBe(true)
  }, 20_000)
})
