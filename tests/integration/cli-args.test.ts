import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDocument, saveDocument } from "../../src/ir/document.ts"

const CLI = `${import.meta.dir}/../../src/cli/main.ts`

async function runCli(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
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

/** The machine-readable error line: the last JSON line on stderr. */
function errorEvent(stderr: string): { code: string; message: string } {
  return JSON.parse(stderr.trim().split("\n").at(-1)!)
}

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ostia-cli-args-"))
  await saveDocument(createDocument([], []), join(dir, "empty.json"))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("surplus positionals and inapplicable flags are usage errors", () => {
  test("compare rejects a third path", async () => {
    const { stderr, exitCode } = await runCli([
      "compare",
      "a.json",
      "b.json",
      "c.json",
    ])
    expect(exitCode).toBe(2)
    expect(errorEvent(stderr).code).toBe("invalid-flag")
    expect(stderr).toContain(`"ostia compare" takes two document paths, got 3`)
  })

  test("compare --baseline takes exactly one positional", async () => {
    const { stderr, exitCode } = await runCli([
      "compare",
      "a.json",
      "b.json",
      "--baseline",
      "c.json",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("takes one candidate path, got 2")
  })

  test("baseline list rejects arguments", async () => {
    const { stderr, exitCode } = await runCli(["baseline", "list", "main"], dir)
    expect(exitCode).toBe(2)
    expect(errorEvent(stderr).code).toBe("invalid-flag")
    expect(stderr).toContain(
      `"ostia baseline list" takes no arguments, got "main"`,
    )
  })

  test("baseline save rejects a second name", async () => {
    const { stderr, exitCode } = await runCli(
      ["baseline", "save", "a", "b"],
      dir,
    )
    expect(exitCode).toBe(2)
    expect(stderr).toContain("takes at most one name argument")
  })

  test("report --measurement/--out-dir are rejected for a non-visualization format", async () => {
    const doc = join(dir, "empty.json")
    const measurement = await runCli(["report", doc, "--measurement", "run_x"])
    expect(measurement.exitCode).toBe(2)
    expect(errorEvent(measurement.stderr).code).toBe("invalid-flag")
    expect(measurement.stderr).toContain(
      "--measurement only apply to the visualization formats",
    )

    const both = await runCli([
      "report",
      doc,
      "--format",
      "json",
      "--out-dir",
      "x",
      "--measurement",
      "y",
    ])
    expect(both.exitCode).toBe(2)
    expect(both.stderr).toContain("--measurement and --out-dir")
  })

  test("report still accepts --measurement/--out-dir with a visualization format", async () => {
    // The empty document has no CPU evidence, which is a later, different failure.
    const { stderr, exitCode } = await runCli([
      "report",
      join(dir, "empty.json"),
      "--format",
      "collapsed",
      "--measurement",
      "run_x",
      "--out-dir",
      join(dir, "viz"),
    ])
    expect(exitCode).toBe(2)
    expect(errorEvent(stderr).code).toBe("no-cpu-evidence")
  })

  test("baseline show rejects --out-dir without a visualization format", async () => {
    await Bun.write(
      join(dir, "ostia.config.json"),
      JSON.stringify({ workloads: [{ command: ["bun", "-e", "1"] }] }),
    )
    await saveDocument(
      createDocument([], []),
      join(dir, ".ostia/baselines/main.json"),
    )
    const { stderr, exitCode } = await runCli(
      ["baseline", "show", "main", "--out-dir", "x"],
      dir,
    )
    expect(exitCode).toBe(2)
    expect(errorEvent(stderr).code).toBe("invalid-flag")
  })

  test("time --time-unit needs --time-source", async () => {
    const { stderr, exitCode } = await runCli([
      "time",
      "--time-unit",
      "ms",
      "bun -e 1",
    ])
    expect(exitCode).toBe(2)
    expect(errorEvent(stderr).code).toBe("invalid-flag")
    expect(stderr).toContain("--time-unit only applies with --time-source")
  })

  test("time --cpu-interval needs --cpu", async () => {
    const { stderr, exitCode } = await runCli([
      "time",
      "--cpu-interval",
      "500",
      "bun -e 1",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("--cpu-interval only applies with --cpu")
  })
})

describe("config discovery and --config", () => {
  test("a missing config names both discoverable files", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ostia-cli-noconfig-"))
    try {
      const { stderr, exitCode } = await runCli(["ci"], empty)
      expect(exitCode).toBe(2)
      expect(errorEvent(stderr).code).toBe("config-missing")
      expect(stderr).toContain("No ostia.config.ts or ostia.config.json found")
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test("--config PATH loads that file instead of discovery", async () => {
    const proj = await mkdtemp(join(tmpdir(), "ostia-cli-config-flag-"))
    try {
      await Bun.write(
        join(proj, "custom.json"),
        JSON.stringify({
          baselineDir: "bl",
          workloads: [{ command: ["bun", "-e", "1"] }],
        }),
      )
      await saveDocument(createDocument([], []), join(proj, "bl/main.json"))
      // No ostia.config.* here: only --config can find the baselineDir.
      const without = await runCli(["baseline", "list"], proj)
      expect(without.exitCode).toBe(2)
      const withFlag = await runCli(
        ["baseline", "list", "--config", "custom.json"],
        proj,
      )
      expect(withFlag.exitCode).toBe(0)
      expect(withFlag.stdout).toContain("main")
      const shown = await runCli(
        [
          "baseline",
          "show",
          "main",
          "--config=custom.json",
          "--format",
          "json",
        ],
        proj,
      )
      expect(shown.exitCode).toBe(0)
    } finally {
      await rm(proj, { recursive: true, force: true })
    }
  })

  test("--config naming a missing file is config-missing", async () => {
    const { stderr, exitCode } = await runCli(
      ["ci", "--config", "nope.json"],
      dir,
    )
    expect(exitCode).toBe(2)
    const event = errorEvent(stderr)
    expect(event.code).toBe("config-missing")
    expect(event.message).toContain("nope.json")
  })

  test("--config applies to compare's thresholds and its printed source", async () => {
    const proj = await mkdtemp(join(tmpdir(), "ostia-cli-config-compare-"))
    try {
      await Bun.write(
        join(proj, "t.json"),
        JSON.stringify({ thresholds: { timingPct: 7 } }),
      )
      await saveDocument(createDocument([], []), join(proj, "a.json"))
      const { stdout } = await runCli(
        ["compare", "a.json", "a.json", "--config", "t.json"],
        proj,
      )
      expect(stdout).toContain("thresholds: t.json")
    } finally {
      await rm(proj, { recursive: true, force: true })
    }
  })

  test("an invalid config value is config-invalid and names the key", async () => {
    const proj = await mkdtemp(join(tmpdir(), "ostia-cli-config-invalid-"))
    try {
      await Bun.write(
        join(proj, "ostia.config.json"),
        JSON.stringify({ bench: { jobs: "lots" }, workloads: [] }),
      )
      const { stderr, exitCode } = await runCli(["bench", "x.ts"], proj)
      expect(exitCode).toBe(2)
      const event = errorEvent(stderr)
      expect(event.code).toBe("config-invalid")
      expect(event.message).toContain(`"bench.jobs"`)
    } finally {
      await rm(proj, { recursive: true, force: true })
    }
  })
})

describe("baseline and ci error codes", () => {
  test("baseline show of a missing baseline is baseline-missing, like ci", async () => {
    const proj = await mkdtemp(join(tmpdir(), "ostia-cli-show-missing-"))
    try {
      await Bun.write(
        join(proj, "ostia.config.json"),
        JSON.stringify({ workloads: [{ command: ["bun", "-e", "1"] }] }),
      )
      const show = await runCli(["baseline", "show", "nope"], proj)
      expect(show.exitCode).toBe(2)
      expect(errorEvent(show.stderr).code).toBe("baseline-missing")
      const ci = await runCli(["ci", "--baseline", "nope"], proj)
      expect(ci.exitCode).toBe(2)
      expect(errorEvent(ci.stderr).code).toBe("baseline-missing")
    } finally {
      await rm(proj, { recursive: true, force: true })
    }
  })

  test("a missing suite file inside ci is a usage error (invalid-flag), as in bench", async () => {
    const proj = await mkdtemp(join(tmpdir(), "ostia-cli-ci-suite-"))
    try {
      await Bun.write(
        join(proj, "ostia.config.json"),
        JSON.stringify({ workloads: [{ suites: ["missing.bench.ts"] }] }),
      )
      await saveDocument(
        createDocument([], []),
        join(proj, ".ostia/baselines/main.json"),
      )
      const { stderr, exitCode } = await runCli(
        ["ci", "--no-noise-check"],
        proj,
      )
      expect(exitCode).toBe(2)
      const event = errorEvent(stderr)
      expect(event.code).toBe("invalid-flag")
      expect(event.message).toContain("matched no files")
    } finally {
      await rm(proj, { recursive: true, force: true })
    }
  })

  test("ci --save-baseline measures fresh instead of reusing the cache, and saves what it measured", async () => {
    const proj = await mkdtemp(join(tmpdir(), "ostia-cli-ci-save-"))
    try {
      await Bun.write(
        join(proj, "ostia.config.json"),
        JSON.stringify({
          samples: 3,
          warmup: 0,
          thresholds: { timingPct: 10_000 },
          // `inputs: []` is cacheable.
          workloads: [
            { label: "spawn", command: ["bun", "-e", "1"], inputs: [] },
          ],
        }),
      )
      expect((await runCli(["baseline", "save"], proj)).exitCode).toBe(0)
      // `baseline save` fills the cache, so a plain `ci` now reuses that run.
      const cached = await runCli(["ci", "--no-noise-check"], proj)
      expect(cached.stdout).toContain("1 cached")

      const saved = await runCli(
        ["ci", "--no-noise-check", "--save-baseline"],
        proj,
      )
      expect(saved.exitCode).toBe(0)
      expect(saved.stdout).toContain("0 cached")
      expect(saved.stdout).toContain("1 executed")
    } finally {
      await rm(proj, { recursive: true, force: true })
    }
  }, 30_000)
})
