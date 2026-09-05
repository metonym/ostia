import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { profile } from "../../src/index.ts"
import { saveDocument } from "../../src/ir/document.ts"

const CLI = `${import.meta.dir}/../../src/cli/main.ts`
const DOC_PATH = `${import.meta.dir}/../../.ostia-test-cli-doc.json`

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

describe("ostia report --format (viz formats folded in, item 4)", () => {
  afterAll(async () => {
    await Bun.spawn(["rm", "-f", DOC_PATH]).exited
  })

  beforeAll(async () => {
    function hotLoop(): number {
      let acc = 0
      for (let i = 0; i < 500_000; i++) acc = (acc + i) % 1000000007
      return acc
    }
    const { document } = await profile(hotLoop, { intervalUs: 100 })
    await saveDocument(document, DOC_PATH)
  }, 10_000)

  test("ostia report --format collapsed renders CPU evidence directly", async () => {
    const { stdout, exitCode } = await runCli([
      "report",
      DOC_PATH,
      "--format",
      "collapsed",
    ])
    expect(exitCode).toBe(0)
    expect(stdout.length).toBeGreaterThan(0)
  }, 10_000)

  test("ostia report --format mermaid renders a call tree", async () => {
    const { stdout, exitCode } = await runCli([
      "report",
      DOC_PATH,
      "--format",
      "mermaid",
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("graph TD")
  }, 10_000)

  test("ostia viz is a hidden deprecated alias that delegates to report", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "viz",
      DOC_PATH,
      "--format",
      "collapsed",
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toContain("deprecated")
    expect(stdout.length).toBeGreaterThan(0)
  }, 10_000)

  test("ostia --help no longer lists viz as a command", async () => {
    const { stdout } = await runCli(["--help"])
    expect(stdout).not.toMatch(/\bviz\b/)
    expect(stdout).toContain("report")
  }, 10_000)
})
