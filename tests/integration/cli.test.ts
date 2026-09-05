import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { profile, time } from "../../src/index.ts"
import { saveDocument } from "../../src/ir/document.ts"

const CLI = `${import.meta.dir}/../../src/cli/main.ts`
const DOC_PATH = `${import.meta.dir}/../../.ostia-test-cli-doc.json`

async function runCli(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: opts.cwd,
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

describe("ostia bench - task.skip/.only (item 10)", () => {
  const OUT_DIR = `${import.meta.dir}/../../.ostia-test-cli-bench`

  afterAll(async () => {
    await Bun.spawn(["rm", "-rf", OUT_DIR]).exited
  })

  test("task.skip() carries the workload with no measurement; table prints '- skipped'", async () => {
    const docPath = `${OUT_DIR}-skip-doc.json`
    const { stdout, exitCode } = await runCli([
      "bench",
      `${import.meta.dir}/../fixtures/bench-suite-skip.ts`,
      "--time-budget",
      "5",
      "--min-samples",
      "3",
      "--no-noise-check",
      "--out-dir",
      OUT_DIR,
      "--export-json",
      docPath,
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("- skipped")

    const doc = JSON.parse(await Bun.file(docPath).text())
    const labels = doc.workloads.map((w: { label: string }) => w.label)
    expect(labels).toEqual(
      expect.arrayContaining(["skip/measured", "skip/skipped"]),
    )
    const skippedWorkload = doc.workloads.find(
      (w: { label: string }) => w.label === "skip/skipped",
    )
    expect(skippedWorkload.skipped).toBe(true)
    expect(
      doc.measurements.some(
        (m: { workloadId: string }) => m.workloadId === skippedWorkload.id,
      ),
    ).toBe(false)

    await Bun.spawn(["rm", "-f", docPath]).exited
  }, 20_000)

  test(".only restricts the suite to selected tasks and prints a stderr notice", async () => {
    const docPath = `${OUT_DIR}-only-doc.json`
    const { stderr, exitCode } = await runCli([
      "bench",
      `${import.meta.dir}/../fixtures/bench-suite-only.ts`,
      "--time-budget",
      "5",
      "--min-samples",
      "3",
      "--no-noise-check",
      "--out-dir",
      OUT_DIR,
      "--export-json",
      docPath,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toContain("1 task(s) selected by .only")

    const doc = JSON.parse(await Bun.file(docPath).text())
    expect(doc.workloads).toHaveLength(1)
    expect(doc.workloads[0].label).toBe("only/selected")

    await Bun.spawn(["rm", "-f", docPath]).exited
  }, 20_000)
})

describe("ostia baseline save | list | show (item 16)", () => {
  test("save writes a baseline, list shows it, show renders it, and ci --save-baseline promotes a pass", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const cwd = await mkdtemp(join(tmpdir(), "ostia-cli-baseline-test-"))

    try {
      await Bun.write(
        join(cwd, "ostia.config.json"),
        JSON.stringify({
          baseline: "main",
          runs: 3,
          warmup: 0,
          workloads: [{ label: "spawn", command: ["bun", "-e", "1"] }],
        }),
      )

      const noConfig = await runCli(["baseline", "list"], { cwd })
      expect(noConfig.stdout).toContain("No baselines found")

      const save = await runCli(["baseline", "save"], { cwd })
      expect(save.exitCode).toBe(0)
      expect(save.stdout).toContain(".ostia/baselines/main.json")

      const list = await runCli(["baseline", "list"], { cwd })
      expect(list.exitCode).toBe(0)
      expect(list.stdout).toContain("main")
      expect(list.stdout).toContain("1 workloads")

      const show = await runCli(["baseline", "show", "main"], { cwd })
      expect(show.exitCode).toBe(0)
      expect(show.stdout).toContain("spawn")

      const showMissing = await runCli(["baseline", "show", "nope"], { cwd })
      expect(showMissing.exitCode).toBe(2)

      const ci = await runCli(["ci", "--save-baseline"], { cwd })
      expect(ci.exitCode).toBe(0)
      expect(ci.stdout).toContain("Profile CI: ✓")

      const listAfterCi = await runCli(["baseline", "list"], { cwd })
      expect(listAfterCi.stdout).toContain("main")
    } finally {
      await Bun.spawn(["rm", "-rf", cwd]).exited
    }
  }, 30_000)
})

describe("ostia compare - git metadata line (item 17)", () => {
  test("prints base sha (branch) -> cand sha (branch) above the verdicts when both documents carry git", async () => {
    const basePath = `${import.meta.dir}/../../.ostia-test-cli-compare-base.json`
    const candPath = `${import.meta.dir}/../../.ostia-test-cli-compare-cand.json`
    try {
      const base = await time({
        commands: [["bun", "-e", "1"]],
        runs: 3,
        warmup: 0,
        noiseCheck: false,
      })
      const cand = await time({
        commands: [["bun", "-e", "1"]],
        runs: 3,
        warmup: 0,
        noiseCheck: false,
      })
      // This repo is a git checkout, so both real documents carry git.
      expect(base.git).toBeDefined()
      expect(cand.git).toBeDefined()
      await saveDocument(base, basePath)
      await saveDocument(cand, candPath)

      const { stdout, exitCode } = await runCli(["compare", basePath, candPath])
      expect(exitCode).toBeLessThan(2)
      expect(stdout).toContain(`base ${base.git!.sha} (${base.git!.branch}`)
      expect(stdout).toContain(`cand ${cand.git!.sha} (${cand.git!.branch}`)
    } finally {
      await Bun.spawn(["rm", "-f", basePath, candPath]).exited
    }
  }, 20_000)
})
