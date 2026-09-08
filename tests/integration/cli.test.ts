import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { profile, time } from "../../src/index.ts"
import {
  makeSubprocessWorkload,
  makeTimingMeasurement,
  newDocument,
  saveDocument,
} from "../../src/ir/document.ts"
import { computeTimingStats } from "../../src/stats/index.ts"

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

describe("ostia report --format", () => {
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

  test("ostia viz is not a recognized subcommand", async () => {
    const { stderr, exitCode } = await runCli([
      "viz",
      DOC_PATH,
      "--format",
      "collapsed",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("Unknown subcommand")
  }, 10_000)

  test("ostia --help does not list viz as a command", async () => {
    const { stdout } = await runCli(["--help"])
    expect(stdout).not.toMatch(/\bviz\b/)
    expect(stdout).toContain("report")
  }, 10_000)
})

describe("ostia numeric flag validation", () => {
  test("time --samples abc exits 2 quickly instead of hanging", async () => {
    const { stderr, exitCode } = await runCli([
      "time",
      "--samples",
      "abc",
      "--no-noise-check",
      "bun -e 1",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain(`Invalid --samples "abc"`)
  }, 5_000)

  test("time --samples 0 is rejected", async () => {
    const { stderr, exitCode } = await runCli([
      "time",
      "--samples",
      "0",
      "--no-noise-check",
      "bun -e 1",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain(`Invalid --samples "0"`)
  }, 5_000)

  test("bench --jobs x is rejected", async () => {
    const { stderr, exitCode } = await runCli([
      "bench",
      "--jobs",
      "x",
      `${import.meta.dir}/../fixtures/bench-suite-skip.ts`,
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain(`Invalid --jobs "x"`)
  }, 5_000)
})

describe("ostia unknown flags and single-positional validation", () => {
  test("ci --bogus exits 2", async () => {
    const { stderr, exitCode } = await runCli(["ci", "--bogus"])
    expect(exitCode).toBe(2)
    expect(stderr).toContain(`Unknown flag "--bogus"`)
  }, 5_000)

  test("baseline save --verbose exits 2 and writes no file", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const cwd = await mkdtemp(
      join(tmpdir(), "ostia-cli-baseline-verbose-test-"),
    )
    try {
      await Bun.write(
        join(cwd, "ostia.config.json"),
        JSON.stringify({
          workloads: [{ label: "spawn", command: ["bun", "-e", "1"] }],
        }),
      )
      const { stderr, exitCode } = await runCli(
        ["baseline", "save", "--verbose"],
        { cwd },
      )
      expect(exitCode).toBe(2)
      expect(stderr).toContain("Invalid baseline name")
      const exists = await Bun.file(
        join(cwd, ".ostia/baselines/--verbose.json"),
      ).exists()
      expect(exists).toBe(false)
    } finally {
      await Bun.spawn(["rm", "-rf", cwd]).exited
    }
  }, 10_000)

  test("report a.json b.json exits 2 instead of silently using the last path", async () => {
    const { stderr, exitCode } = await runCli(["report", "a.json", "b.json"])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("takes exactly one document path")
  }, 5_000)
})

describe("ostia per-command format lists", () => {
  test("time --format collapsed is rejected (a viz format, not a document format)", async () => {
    const { stderr, exitCode } = await runCli([
      "time",
      "--samples",
      "1",
      "--warmup",
      "0",
      "--no-noise-check",
      "--format",
      "collapsed",
      "bun -e 1",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain(`Unknown --format "collapsed"`)
    expect(stderr).not.toContain("cpuprofile")
  }, 10_000)

  test("report --format collapsed on a document with no CPU evidence exits 2", async () => {
    const path = `${import.meta.dir}/../../.ostia-test-cli-no-cpu-doc.json`
    try {
      const doc = await time({
        commands: [["bun", "-e", "1"]],
        samples: 1,
        warmup: 0,
        noiseCheck: false,
      })
      await saveDocument(doc, path)

      const { stderr, exitCode } = await runCli([
        "report",
        path,
        "--format",
        "collapsed",
      ])
      expect(exitCode).toBe(2)
      expect(stderr).toContain("No CPU evidence in this document")
    } finally {
      await Bun.spawn(["rm", "-f", path]).exited
    }
  }, 10_000)
})

describe("ostia requireConfig wording", () => {
  test(`"no workloads" error names the actual config file, not a hardcoded ostia.config.json`, async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const cwd = await mkdtemp(join(tmpdir(), "ostia-cli-config-wording-test-"))
    try {
      await Bun.write(
        join(cwd, "ostia.config.ts"),
        `import { defineConfig } from "${import.meta.dir}/../../src/index.ts"\n` +
          `export default defineConfig({ workloads: [] })\n`,
      )
      const { stderr, exitCode } = await runCli(["ci"], { cwd })
      expect(exitCode).toBe(2)
      expect(stderr).toContain(`ostia.config.ts has no "workloads" configured`)
    } finally {
      await Bun.spawn(["rm", "-rf", cwd]).exited
    }
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
      "--budget",
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
      "--budget",
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
        samples: 3,
        warmup: 0,
        noiseCheck: false,
      })
      const cand = await time({
        commands: [["bun", "-e", "1"]],
        samples: 3,
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

describe("ostia compare - pure stdout for machine formats (task 05.1)", () => {
  test("--format minimal/jsonl/json write nothing but parseable JSON to stdout, even with git metadata", async () => {
    const basePath = `${import.meta.dir}/../../.ostia-test-cli-compare-pure-base.json`
    const candPath = `${import.meta.dir}/../../.ostia-test-cli-compare-pure-cand.json`
    try {
      const base = await time({
        commands: [["bun", "-e", "1"]],
        samples: 3,
        warmup: 0,
        noiseCheck: false,
      })
      const cand = await time({
        commands: [["bun", "-e", "1"]],
        samples: 3,
        warmup: 0,
        noiseCheck: false,
      })
      // Both real documents carry git - exactly the payload the old prose
      // banner used to print unconditionally, ahead of any format check.
      expect(base.git).toBeDefined()
      expect(cand.git).toBeDefined()
      await saveDocument(base, basePath)
      await saveDocument(cand, candPath)

      const minimal = await runCli([
        "compare",
        basePath,
        candPath,
        "--format",
        "minimal",
      ])
      expect(minimal.exitCode).toBeLessThan(2)
      const minimalLines = minimal.stdout.trim().split("\n").filter(Boolean)
      expect(minimalLines.length).toBeGreaterThan(0)
      for (const line of minimalLines)
        expect(() => JSON.parse(line)).not.toThrow()

      const jsonl = await runCli([
        "compare",
        basePath,
        candPath,
        "--format",
        "jsonl",
      ])
      expect(jsonl.exitCode).toBeLessThan(2)
      const jsonlLines = jsonl.stdout.trim().split("\n").filter(Boolean)
      expect(jsonlLines.length).toBeGreaterThan(0)
      for (const line of jsonlLines)
        expect(() => JSON.parse(line)).not.toThrow()

      const json = await runCli([
        "compare",
        basePath,
        candPath,
        "--format",
        "json",
      ])
      expect(json.exitCode).toBeLessThan(2)
      expect(() => JSON.parse(json.stdout)).not.toThrow()
    } finally {
      await Bun.spawn(["rm", "-f", basePath, candPath]).exited
    }
  }, 20_000)
})

describe("ostia compare - config thresholds (task 04.3)", () => {
  test("a temp ostia.config.json's timingPct makes a small delta fail where DEFAULT_THRESHOLDS passes", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const cwd = await mkdtemp(join(tmpdir(), "ostia-cli-compare-config-test-"))
    const basePath = join(cwd, "base.json")
    const candPath = join(cwd, "cand.json")
    try {
      // 30 samples (past MIN_SAMPLES_FOR_TEST, so the bootstrap CI +
      // Mann-Whitney path runs, not the thin-comparison fallback), ~3%
      // slower, low noise: below DEFAULT_THRESHOLDS.timingPct (5%) but past
      // a 1% config override.
      const baseSamples = Array.from(
        { length: 30 },
        (_, i) => 10_000_000 + (i % 5) * 1_000,
      )
      const candSamples = Array.from(
        { length: 30 },
        (_, i) => 10_300_000 + (i % 5) * 1_000,
      )
      const workload = makeSubprocessWorkload(["bun", "-e", "1"])
      const baseDoc = newDocument(
        [workload],
        [
          makeTimingMeasurement({
            workload,
            configFingerprint: "cfg",
            trials: baseSamples.map((wallNs, i) => ({ i, wallNs })),
            timing: computeTimingStats(baseSamples),
            warnings: [],
          }),
        ],
      )
      const candDoc = newDocument(
        [workload],
        [
          makeTimingMeasurement({
            workload,
            configFingerprint: "cfg",
            trials: candSamples.map((wallNs, i) => ({ i, wallNs })),
            timing: computeTimingStats(candSamples),
            warnings: [],
          }),
        ],
      )
      await saveDocument(baseDoc, basePath)
      await saveDocument(candDoc, candPath)

      const withDefaults = await runCli(
        ["compare", basePath, candPath, "--no-config"],
        { cwd },
      )
      expect(withDefaults.stdout).toContain("thresholds: defaults")
      expect(withDefaults.exitCode).toBe(0)

      await Bun.write(
        join(cwd, "ostia.config.json"),
        JSON.stringify({ thresholds: { timingPct: 1 } }),
      )
      const withConfig = await runCli(["compare", basePath, candPath], {
        cwd,
      })
      expect(withConfig.stdout).toContain("thresholds: ostia.config.json")
      expect(withConfig.exitCode).toBe(1)
    } finally {
      await Bun.spawn(["rm", "-rf", cwd]).exited
    }
  }, 20_000)
})

describe("ostia compare - zero matched workloads (task 04.2)", () => {
  test("exits 2 and prints an Unmatched section when base and candidate share no workload id", async () => {
    const basePath = `${import.meta.dir}/../../.ostia-test-cli-compare-unmatched-base.json`
    const candPath = `${import.meta.dir}/../../.ostia-test-cli-compare-unmatched-cand.json`
    try {
      const base = await time({
        commands: [["bun", "-e", "1"]],
        samples: 3,
        warmup: 0,
        noiseCheck: false,
      })
      const cand = await time({
        commands: [["bun", "-e", "2"]],
        samples: 3,
        warmup: 0,
        noiseCheck: false,
      })
      await saveDocument(base, basePath)
      await saveDocument(cand, candPath)

      const { stdout, exitCode } = await runCli(["compare", basePath, candPath])
      expect(exitCode).toBe(2)
      expect(stdout).toContain("Unmatched:")
    } finally {
      await Bun.spawn(["rm", "-f", basePath, candPath]).exited
    }
  }, 20_000)
})

describe("ostia report - garbage document", () => {
  test("an unsupported schemaVersion exits 2 with the OstiaDocumentError message", async () => {
    const path = `${import.meta.dir}/../../.ostia-test-cli-garbage-doc.json`
    try {
      await Bun.write(path, JSON.stringify({ schemaVersion: 3 }))
      const { stderr, exitCode } = await runCli(["report", path])
      expect(exitCode).toBe(2)
      expect(stderr).toContain(
        "unsupported ProfileDocument schemaVersion 3 (this ostia reads 1–2)",
      )
    } finally {
      await Bun.spawn(["rm", "-f", path]).exited
    }
  }, 10_000)
})
