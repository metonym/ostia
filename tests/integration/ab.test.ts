import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, utimesSync } from "node:fs"
import {
  AbBaseError,
  type AbOptions,
  type AbProgress,
  AbSetupError,
  ab,
} from "../../src/ab/index.ts"
import { bench } from "../../src/index.ts"
import type { MinimalEvent } from "../../src/renderers/minimal/index.ts"

const SRC = `${import.meta.dir}/../../src`
const CLI = `${SRC}/cli/main.ts`
const REPO = `${import.meta.dir}/../../.ostia-test-ab`

const LIB = `export function spin(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}
export function work(n: number): number {
  return spin(n)
}
`
// Four times the work, same result: a pure slowdown.
const SLOW_LIB = LIB.replace(
  "  return spin(n)",
  "  for (let k = 0; k < 3; k++) spin(n)\n  return spin(n)",
)

const SUITE = `import { group, task } from "${SRC}/index.ts"
import { spin, work } from "../src/lib.ts"

group("g", () => {
  task("work", () => work(20_000))
  task("stable", () => spin(20_000))
})
`

async function sh(cmd: string[], cwd = REPO): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${stderr}`)
  return stdout.trim()
}

/** A fresh repo whose HEAD holds `LIB` and `SUITE`. */
async function initRepo(): Promise<void> {
  await Bun.spawn(["rm", "-rf", REPO]).exited
  await Bun.write(`${REPO}/src/lib.ts`, LIB)
  await Bun.write(`${REPO}/bench/s.bench.ts`, SUITE)
  await Bun.write(`${REPO}/.gitignore`, "node_modules\n")
  await sh(["git", "init", "-q"])
  await sh(["git", "add", "-A"])
  await sh([
    "git",
    "-c",
    "user.name=ostia",
    "-c",
    "user.email=ostia@example.com",
    "commit",
    "-qm",
    "base",
  ])
}

async function commit(message: string): Promise<void> {
  await sh(["git", "add", "-A"])
  await sh([
    "git",
    "-c",
    "user.name=ostia",
    "-c",
    "user.email=ostia@example.com",
    "commit",
    "-qm",
    message,
  ])
}

const QUICK = { noiseCheck: false, rounds: 7, cwd: REPO }

describe("ab() - paired A/B against a git ref", () => {
  beforeEach(initRepo)
  afterAll(async () => {
    await Bun.spawn(["rm", "-rf", REPO]).exited
  })

  test("flags an injected slowdown, confirms it in fresh processes, and fails the run", async () => {
    await Bun.write(`${REPO}/src/lib.ts`, SLOW_LIB)
    const doc = await ab({ ...QUICK, suites: ["bench/s.bench.ts"] })

    const byTask = new Map(
      doc.measurements.map((m) => [
        doc.workloads.find((w) => w.id === m.workloadId)!.entry!.task,
        m,
      ]),
    )
    const work = byTask.get("g/work")!
    expect(work.phase).toBe("paired")
    expect(work.paired!.medianRatio).toBeGreaterThan(2)
    expect(work.paired!.flagged).toBe("regressed")
    expect(work.paired!.repeats).toHaveLength(2)
    expect(work.paired!.confirmed).toBe(true)
    expect(work.paired!.verdict).toBe("regressed")
    expect(work.paired!.sameOutput).toBe(true)
    expect(work.timing!.samples).toHaveLength(7)

    expect(byTask.get("g/stable")!.paired!.verdict).toBe("unchanged")

    expect(doc.ab!.base.ref).toBe("HEAD")
    expect(doc.ab!.base.sha).toBe(await sh(["git", "rev-parse", "HEAD"]))
    expect(doc.ab!.matched).toBe(2)
    expect(doc.ab!.regressed).toBe(1)
    expect(doc.ab!.verdict).toBe("fail")
    expect(doc.unmatched).toEqual({ baseOnly: [], candOnly: [] })
  }, 60_000)

  test("an unchanged working tree passes", async () => {
    const doc = await ab({
      ...QUICK,
      suites: ["bench/s.bench.ts"],
      // Wide enough that a loaded machine can't fail a two-task A/A run.
      thresholdPct: 25,
      geomeanThresholdPct: 25,
    })
    expect(doc.ab!.matched).toBe(2)
    expect(doc.ab!.regressed).toBe(0)
    expect(doc.ab!.verdict).toBe("pass")
  }, 60_000)

  test("reports differing output without failing on it", async () => {
    await Bun.write(
      `${REPO}/src/lib.ts`,
      LIB.replace("return spin(n)", "return spin(n) + 1"),
    )
    const doc = await ab({
      ...QUICK,
      suites: ["bench/s.bench.ts"],
      thresholdPct: 25,
      geomeanThresholdPct: 25,
    })
    const differs = doc.measurements.filter((m) => !m.paired!.sameOutput)
    expect(differs).toHaveLength(1)
    expect(doc.ab!.outputDiffers).toBe(1)
    expect(doc.ab!.verdict).toBe("pass")
  }, 60_000)

  test("tasks on only one side are unmatched, keyed by the working tree's suite path", async () => {
    await Bun.write(
      `${REPO}/bench/s.bench.ts`,
      SUITE.replace('task("stable"', 'task("renamed"'),
    )
    const doc = await ab({ ...QUICK, suites: ["bench/s.bench.ts"] })
    const label = (id: string) =>
      doc.workloads.find((w) => w.id === id)!.entry!.task
    expect(doc.unmatched!.baseOnly.map(label)).toEqual(["g/stable"])
    expect(doc.unmatched!.candOnly.map(label)).toEqual(["g/renamed"])
    expect(doc.ab!.matched).toBe(1)
  }, 60_000)

  test("a suite file that doesn't exist at the base ref pairs nothing", async () => {
    await Bun.write(`${REPO}/bench/new.bench.ts`, SUITE)
    const doc = await ab({ ...QUICK, suites: ["bench/new.bench.ts"] })
    expect(doc.ab!.matched).toBe(0)
    expect(doc.unmatched!.candOnly).toHaveLength(2)
    expect(doc.ab!.newSuites).toEqual(["bench/new.bench.ts"])
  }, 60_000)

  test("a new suite next to existing ones is listed and doesn't fail the run", async () => {
    await Bun.write(`${REPO}/bench/new.bench.ts`, SUITE)
    const doc = await ab({
      ...QUICK,
      suites: ["bench/s.bench.ts", "bench/new.bench.ts"],
      thresholdPct: 25,
      geomeanThresholdPct: 25,
      confirm: 0,
    })
    expect(doc.ab!.matched).toBe(2)
    expect(doc.ab!.newSuites).toEqual(["bench/new.bench.ts"])
    expect(doc.unmatched!.candOnly).toHaveLength(2)
    expect(doc.ab!.verdict).toBe("pass")
  }, 60_000)

  test("a changed suite with changed output is not comparable and stays out of the verdict", async () => {
    // A "fixed fixture": four times the input, so a different result and a
    // ~4x slower task, from the suite alone.
    await Bun.write(
      `${REPO}/bench/s.bench.ts`,
      SUITE.replace("work(20_000)", "work(80_000)"),
    )
    const doc = await ab({ ...QUICK, suites: ["bench/s.bench.ts"] })
    const byTask = new Map(
      doc.measurements.map((m) => [
        doc.workloads.find((w) => w.id === m.workloadId)!.entry!.task,
        m,
      ]),
    )
    const work = byTask.get("g/work")!
    expect(work.paired!.suiteChanged).toBe(true)
    expect(work.paired!.sameOutput).toBe(false)
    expect(work.paired!.verdict).toBe("unchanged")
    expect(work.paired!.repeats).toBeUndefined()
    expect(work.warnings.map((w) => w.code)).toContain("suite-changed")

    // Same output: still judged, but marked.
    const stable = byTask.get("g/stable")!
    expect(stable.paired!.suiteChanged).toBe(true)
    expect(stable.paired!.sameOutput).toBe(true)

    expect(doc.ab!.notComparable).toBe(1)
    expect(doc.ab!.regressed).toBe(0)
    // The geomean is the stable task's alone.
    expect(Math.abs(doc.ab!.geomeanPct!)).toBeLessThan(50)
  }, 60_000)

  test("an unchanged suite file isn't marked", async () => {
    const doc = await ab({ ...QUICK, suites: ["bench/s.bench.ts"], confirm: 0 })
    for (const m of doc.measurements) {
      expect(m.paired!.suiteChanged).toBeUndefined()
    }
    expect(doc.ab!.notComparable).toBe(0)
  }, 60_000)

  test("a task that throws on one side is reported, not timed, and doesn't stop the suite", async () => {
    const throwing = (
      cond: string,
    ) => `import { group, task } from "${SRC}/index.ts"
import { spin, work } from "../src/lib.ts"

group("g", () => {
  task("boom", () => {
    if (${cond}) throw new TypeError("no such thing")
    return work(20_000)
  })
  task("stable", () => spin(20_000))
})
`
    // `globalThis.__ostia_ab_base__` is only ever read, never set, so the
    // candidate side tells itself apart by its path instead.
    const isBase = 'import.meta.path.includes("/node_modules/")'
    const run = async (cond: string) => {
      await Bun.write(`${REPO}/bench/t.bench.ts`, throwing(cond))
      await commit("throwing suite")
      const doc = await ab({
        ...QUICK,
        suites: ["bench/t.bench.ts"],
        thresholdPct: 25,
        geomeanThresholdPct: 25,
      })
      const boom = doc.measurements.find(
        (m) =>
          doc.workloads.find((w) => w.id === m.workloadId)!.entry!.task ===
          "g/boom",
      )!
      return { doc, boom }
    }

    const cand = await run(`!${isBase}`)
    expect(cand.boom.threw).toEqual({ side: "cand", message: "no such thing" })
    expect(cand.boom.timing).toBeUndefined()
    expect(cand.doc.ab!.threw).toBe(1)
    expect(cand.doc.ab!.matched).toBe(1)
    expect(cand.doc.ab!.verdict).toBe("fail")

    const base = await run(isBase)
    expect(base.boom.threw!.side).toBe("base")
    expect(base.doc.ab!.verdict).toBe("pass")

    const both = await run("true")
    expect(both.boom.threw!.side).toBe("both")
  }, 60_000)

  test("reports progress for setup, each task and each confirmation repeat", async () => {
    await Bun.write(`${REPO}/src/lib.ts`, SLOW_LIB)
    const events: AbProgress[] = []
    await ab({
      ...QUICK,
      suites: ["bench/s.bench.ts"],
      baseSetup: "true",
      onProgress: (p) => events.push(p),
    })
    expect(events[0]).toEqual({ phase: "setup", command: "true" })
    expect(events.filter((e) => e.phase === "measure")).toEqual([
      {
        phase: "measure",
        suite: 1,
        suites: 1,
        file: "bench/s.bench.ts",
        task: 1,
        tasks: 2,
        label: "g/work",
      },
      {
        phase: "measure",
        suite: 1,
        suites: 1,
        file: "bench/s.bench.ts",
        task: 2,
        tasks: 2,
        label: "g/stable",
      },
    ])
    const confirms = events.filter((e) => e.phase === "confirm")
    expect(confirms.at(-1)).toMatchObject({ repeat: 2, label: "g/work" })
  }, 60_000)

  test("prunes base trees past keepTrees, least recently used first, but not ones used in the last hour", async () => {
    const abDir = `${REPO}/node_modules/.cache/ostia/ab`
    const fake = (name: string, ageMs: number) => {
      mkdirSync(`${abDir}/${name}`, { recursive: true })
      const t = new Date(Date.now() - ageMs)
      utimesSync(`${abDir}/${name}`, t, t)
    }
    const hour = 60 * 60 * 1000
    fake("old-1", 3 * hour)
    fake("old-2", 2 * hour)
    fake("recent", hour / 6)
    // A temp directory left by a process that's gone.
    fake("dead.tmp-99999999", 0)

    await ab({
      ...QUICK,
      suites: ["bench/s.bench.ts"],
      confirm: 0,
      keepTrees: 1,
    })
    const sha = await sh(["git", "rev-parse", "HEAD"])
    expect(readdirSync(abDir).sort()).toEqual([sha, "recent"].sort())
  }, 60_000)

  test("workload ids match bench()'s for the same suite, and the base tree is cached per commit", async () => {
    const paired = await ab({ ...QUICK, suites: ["bench/s.bench.ts"] })
    const timed = await bench({
      suites: ["bench/s.bench.ts"],
      cwd: REPO,
      budgetMs: 20,
      noiseCheck: false,
    })
    expect(paired.workloads.map((w) => w.id).sort()).toEqual(
      timed.workloads.map((w) => w.id).sort(),
    )
    const sha = await sh(["git", "rev-parse", "HEAD"])
    expect(
      existsSync(`${REPO}/node_modules/.cache/ostia/ab/${sha}/src/lib.ts`),
    ).toBe(true)
  }, 60_000)

  test("salts every script in the base tree, but not declarations or symlinks", async () => {
    const outside = `${REPO}-outside.ts`
    await Bun.write(outside, "export const x = 1\n")
    await Bun.write(`${REPO}/src/types.d.ts`, "export type T = number\n")
    await Bun.write(`${REPO}/src/data.json`, "{}\n")
    await sh(["ln", "-s", outside, `${REPO}/src/link.ts`])
    await sh(["git", "add", "-A"])
    await sh([
      "git",
      "-c",
      "user.name=ostia",
      "-c",
      "user.email=ostia@example.com",
      "commit",
      "-qm",
      "more files",
    ])
    await ab({ ...QUICK, suites: ["bench/s.bench.ts"], confirm: 0 })

    const sha = await sh(["git", "rev-parse", "HEAD"])
    const tree = `${REPO}/node_modules/.cache/ostia/ab/${sha}`
    const salt = "\n;globalThis.__ostia_ab_base__;\n"
    expect(await Bun.file(`${tree}/src/lib.ts`).text()).toBe(LIB + salt)
    expect(await Bun.file(`${tree}/bench/s.bench.ts`).text()).toBe(SUITE + salt)
    expect(await Bun.file(`${tree}/src/types.d.ts`).text()).toBe(
      "export type T = number\n",
    )
    expect(await Bun.file(`${tree}/src/data.json`).text()).toBe("{}\n")
    expect(await Bun.file(outside).text()).toBe("export const x = 1\n")
    await Bun.spawn(["rm", "-f", outside]).exited
  }, 60_000)

  test("builds gitignored files in the base tree with baseSetup, cached per command", async () => {
    await Bun.write(`${REPO}/.gitignore`, "node_modules\nsrc/gen.ts\n")
    await Bun.write(
      `${REPO}/bench/gen.bench.ts`,
      `import { task } from "${SRC}/index.ts"
import { N } from "../src/gen.ts"
import { spin } from "../src/lib.ts"
task("gen", () => spin(N))
`,
    )
    await commit("generated input")
    await Bun.write(`${REPO}/src/gen.ts`, "export const N = 20_000\n")

    // Without setup, the base tree has no src/gen.ts to import.
    await expect(
      ab({ ...QUICK, suites: ["bench/gen.bench.ts"], confirm: 0 }),
    ).rejects.toThrow(/the base side failed to load .*Cannot find module/)

    // Relative ./node_modules reads work while setup runs.
    const setup = [
      "test -d node_modules/.cache",
      'cp "$OSTIA_AB_CANDIDATE_DIR/src/gen.ts" src/gen.ts',
    ]
    const doc = await ab({
      ...QUICK,
      suites: ["bench/gen.bench.ts"],
      baseSetup: setup,
      confirm: 0,
    })
    expect(doc.ab!.matched).toBe(1)

    const sha = await sh(["git", "rev-parse", "HEAD"])
    const trees = (await sh(["ls", `${REPO}/node_modules/.cache/ostia/ab`]))
      .split("\n")
      .filter((d) => d.startsWith(`${sha}-`))
    expect(trees).toHaveLength(1)
    const tree = `${REPO}/node_modules/.cache/ostia/ab/${trees[0]}`
    expect(await Bun.file(`${tree}/src/gen.ts`).text()).toBe(
      "export const N = 20_000\n\n;globalThis.__ostia_ab_base__;\n",
    )
    expect(existsSync(`${tree}/node_modules`)).toBe(false)
  }, 60_000)

  test("a failed baseSetup rejects with its output and leaves no tree behind", async () => {
    const err = await ab({
      ...QUICK,
      suites: ["bench/s.bench.ts"],
      baseSetup: "echo generating; echo 'no such script' >&2; exit 3",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AbSetupError)
    expect((err as Error).message).toContain("exited 3")
    expect((err as Error).message).toContain("no such script")
    const left = await sh(["ls", `${REPO}/node_modules/.cache/ostia/ab`])
    expect(left).toBe("")
  }, 20_000)

  test("rejects a ref that isn't a commit", async () => {
    await expect(
      ab({ ...QUICK, suites: ["bench/s.bench.ts"], base: "no-such-ref" }),
    ).rejects.toThrow(AbBaseError)
  }, 20_000)
})

describe("ostia ab", () => {
  beforeEach(initRepo)
  afterAll(async () => {
    await Bun.spawn(["rm", "-rf", REPO]).exited
  })

  async function runCli(args: string[]) {
    const proc = Bun.spawn(["bun", CLI, "ab", ...args], {
      cwd: REPO,
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

  test('exits 1 on a confirmed regression, with a `command: "ab"` summary', async () => {
    await Bun.write(`${REPO}/src/lib.ts`, SLOW_LIB)
    const { stdout, exitCode } = await runCli([
      "bench/s.bench.ts",
      "--rounds",
      "7",
      "--no-noise-check",
      "--format",
      "minimal",
    ])
    expect(exitCode).toBe(1)
    const events = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as MinimalEvent)
    const work = events.find((e) => e.event === "run" && e.task === "g/work")
    expect(work?.event === "run" && work.paired?.verdict).toBe("regressed")
    expect(work?.event === "run" && work.paired?.confirmed).toBe(true)
    const summary = events.at(-1)!
    expect(summary.event).toBe("summary")
    if (summary.event !== "summary") return
    expect(summary.command).toBe("ab")
    expect(summary.regressed).toBe(1)
    expect(summary.geomeanThresholdPct).toBe(1.5)
    expect(summary.base?.ref).toBe("HEAD")
    expect(summary.exitCode).toBe(1)
  }, 60_000)

  test("prints the A/B table", async () => {
    await Bun.write(`${REPO}/src/lib.ts`, SLOW_LIB)
    const { stdout } = await runCli([
      "bench/s.bench.ts",
      "--rounds",
      "5",
      "--confirm",
      "0",
      "--no-noise-check",
    ])
    expect(stdout).toContain("A/B: working tree vs HEAD")
    expect(stdout).toMatch(/^g:\n {2}work .* regressed/m)
    expect(stdout).not.toContain("g/work")
    expect(stdout).toContain("Geomean +")
  }, 60_000)

  test("marks a changed suite in the table", async () => {
    await Bun.write(
      `${REPO}/bench/s.bench.ts`,
      SUITE.replace("work(20_000)", "work(80_000)"),
    )
    const { stdout, exitCode } = await runCli([
      "bench/s.bench.ts",
      "--rounds",
      "5",
      "--no-noise-check",
      // Wide enough that the stable task can't fail the run on a loaded
      // machine.
      "--threshold",
      "25",
      "--geomean-threshold",
      "25",
    ])
    expect(stdout).toMatch(/work .* not comparable/)
    expect(stdout).toContain("! suite-changed")
    expect(stdout).toContain("1 not comparable")
    expect(exitCode).toBe(0)
  }, 60_000)

  test("a task that throws on the candidate side fails the run and says so", async () => {
    await Bun.write(
      `${REPO}/src/lib.ts`,
      LIB.replace("  return spin(n)", '  throw new Error("work is broken")'),
    )
    const minimal = await runCli([
      "bench/s.bench.ts",
      "--rounds",
      "5",
      "--no-noise-check",
      "--geomean-threshold",
      "25",
      "--format",
      "minimal",
    ])
    expect(minimal.exitCode).toBe(1)
    const events = minimal.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as MinimalEvent)
    const work = events.find((e) => e.event === "run" && e.task === "g/work")
    expect(work?.event === "run" && work.threw).toEqual({
      side: "cand",
      message: "work is broken",
    })
    const summary = events.at(-1)!
    expect(summary.event === "summary" && summary.threw).toBe(1)

    const table = await runCli([
      "bench/s.bench.ts",
      "--rounds",
      "5",
      "--no-noise-check",
    ])
    expect(table.stdout).toMatch(/work .* candidate threw/)
    expect(table.stdout).toContain("candidate threw: work is broken")
  }, 60_000)

  test("names the side whose suite failed to load", async () => {
    await Bun.write(
      `${REPO}/bench/s.bench.ts`,
      `import "./missing.ts"\n${SUITE}`,
    )
    const { exitCode, stderr } = await runCli([
      "bench/s.bench.ts",
      "--no-noise-check",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("the candidate side failed to load")
    expect(stderr).toContain('"code":"spawn-failed"')
  }, 20_000)

  test("--progress writes progress to stderr and keeps stdout to the protocol", async () => {
    const quiet = await runCli([
      "bench/s.bench.ts",
      "--rounds",
      "3",
      "--confirm",
      "0",
      "--no-noise-check",
      "--format",
      "minimal",
    ])
    // stderr isn't a terminal here, so it's off unless asked for.
    expect(quiet.stderr).not.toContain("[ab]")

    const { stdout, stderr } = await runCli([
      "bench/s.bench.ts",
      "--rounds",
      "3",
      "--confirm",
      "0",
      "--no-noise-check",
      "--format",
      "minimal",
      "--progress",
    ])
    expect(stderr).toContain(
      "[ab] suite 1/1 bench/s.bench.ts · task 1/2 g/work\n",
    )
    expect(stderr).toContain(
      "[ab] suite 1/1 bench/s.bench.ts · task 2/2 g/stable\n",
    )
    for (const line of stdout.trim().split("\n")) JSON.parse(line)
  }, 60_000)

  test("--clean removes every cached base tree", async () => {
    await runCli([
      "bench/s.bench.ts",
      "--rounds",
      "3",
      "--confirm",
      "0",
      "--no-noise-check",
    ])
    const abDir = `${REPO}/node_modules/.cache/ostia/ab`
    expect(readdirSync(abDir)).toHaveLength(1)
    const { exitCode, stderr } = await runCli(["--clean"])
    expect(exitCode).toBe(0)
    expect(stderr).toContain("Removed 1 cached base tree(s).")
    expect(existsSync(abDir)).toBe(false)
  }, 60_000)

  test("exits 2 when nothing pairs, and on an unknown ref", async () => {
    await Bun.write(`${REPO}/bench/new.bench.ts`, SUITE)
    const none = await runCli(["bench/new.bench.ts", "--no-noise-check"])
    expect(none.exitCode).toBe(2)
    expect(none.stdout).toContain("New suite, not at HEAD: bench/new.bench.ts")
    expect(none.stderr).toContain("No suite exists at HEAD")
    expect(none.stderr).toContain('"code":"no-matches"')

    const badRef = await runCli(["bench/s.bench.ts", "--base", "nope"])
    expect(badRef.exitCode).toBe(2)
    expect(badRef.stderr).toContain('"code":"invalid-flag"')
  }, 60_000)

  test("exits 2 with the command's stderr when --base-setup fails", async () => {
    const { exitCode, stderr } = await runCli([
      "bench/s.bench.ts",
      "--no-noise-check",
      "--base-setup",
      "echo 'build broke' >&2; exit 1",
    ])
    expect(exitCode).toBe(2)
    expect(stderr).toContain("Base setup exited 1")
    expect(stderr).toContain("build broke")
    expect(stderr).toContain('"code":"command-failed"')
  }, 20_000)

  test("rejects fewer than 3 rounds and a non-numeric threshold", async () => {
    const rounds = await runCli(["bench/s.bench.ts", "--rounds", "2"])
    expect(rounds.exitCode).toBe(2)
    const threshold = await runCli(["bench/s.bench.ts", "--threshold", "x"])
    expect(threshold.exitCode).toBe(2)
    expect(threshold.stderr).toContain("expected a number")
  }, 20_000)
})

describe("ab() - exceptions and teardown", () => {
  beforeEach(initRepo)
  afterAll(async () => {
    await Bun.spawn(["rm", "-rf", REPO]).exited
  })

  // Each copy of a suite tells its side by path: the base copy lives in the
  // cached tree under node_modules.
  const SIDE = `const side = import.meta.path.includes("/node_modules/") ? "base" : "cand"`

  /** Runs `suite` (committed, so both sides have it) as the only suite. */
  async function runSuite(suite: string, opts: Partial<AbOptions> = {}) {
    await Bun.write(`${REPO}/bench/x.bench.ts`, suite)
    await commit("suite")
    const doc = await ab({
      ...QUICK,
      rounds: 3,
      confirm: 0,
      thresholdPct: 25,
      geomeanThresholdPct: 10_000,
      suites: ["bench/x.bench.ts"],
      ...opts,
    })
    const byTask = (name: string) =>
      doc.measurements.find(
        (m) =>
          doc.workloads.find((w) => w.id === m.workloadId)!.entry!.task ===
          name,
      )!
    return { doc, byTask }
  }

  for (const [throws, side, verdict] of [
    [["cand"], "cand", "fail"],
    [["base"], "base", "pass"],
    [["base", "cand"], "both", "pass"],
  ] as const) {
    test(`a throw on ${side === "both" ? "both sides" : `the ${side} side`} in a confirmation repeat is reported (${verdict})`, async () => {
      // The first process records that it ran; every later process (the
      // repeat) throws on the given sides. The candidate is ~10x slower, so
      // the first process always flags it.
      const { doc, byTask } = await runSuite(
        `import { existsSync, writeFileSync } from "node:fs"
import { task } from "${SRC}/index.ts"
${SIDE}
const state = process.cwd() + "/first-ran"
const repeat = existsSync(state)
if (side === "cand") writeFileSync(state, "")
const throws = repeat && ${JSON.stringify(throws)}.includes(side)
task("t", () => {
  if (throws) throw new Error(side + " broke in a repeat")
  const end = Bun.nanoseconds() + (side === "cand" ? 1_000_000 : 100_000)
  while (Bun.nanoseconds() < end) {}
  return 1
})
`,
        { confirm: 1 },
      )
      const t = byTask("t")
      expect(t.threw).toMatchObject({ side, repeat: 1 })
      // The first process's timing stays, but nothing is judged on it.
      expect(t.paired!.flagged).toBe("regressed")
      expect(t.paired!.confirmed).toBe(false)
      expect(t.paired!.verdict).toBe("unchanged")
      expect(doc.ab!.threw).toBe(1)
      expect(doc.ab!.matched).toBe(0)
      expect(doc.ab!.geomeanPct).toBeNull()
      expect(doc.ab!.verdict).toBe(verdict)
    }, 60_000)
  }

  /** A suite whose task `t` logs each hook (and any call of its body after
   * teardown) to hooks.log, and throws at each `side:step` in `fails`. A
   * second task, `next`, shows whether the suite went on. */
  const hookSuite = (
    fails: string[],
  ) => `import { appendFileSync } from "node:fs"
import { task } from "${SRC}/index.ts"
${SIDE}
const fails = new Set(${JSON.stringify(fails)})
const log = (event) => appendFileSync(process.cwd() + "/hooks.log", side + ":" + event + "\\n")
const maybeThrow = (step) => {
  if (fails.has(side + ":" + step)) throw new Error(side + " " + step + " broke")
}
let torn = false
task("t", () => {
  if (torn) log("body-after-teardown")
  maybeThrow("body")
  return 1
}, {
  before() { log("before"); maybeThrow("before") },
  after() { log("after"); torn = true; maybeThrow("after") },
})
task("next", () => 1)
`
  const hookLog = async () =>
    (await Bun.file(`${REPO}/hooks.log`).text()).trim().split("\n")

  test("a throwing base teardown runs each teardown once and the suite goes on", async () => {
    const { byTask } = await runSuite(hookSuite(["base:after"]))
    expect(byTask("t").threw).toEqual({
      side: "base",
      message: "base after broke",
    })
    expect(await hookLog()).toEqual([
      "base:before",
      "cand:before",
      "cand:after",
      "base:after",
    ])
    expect(byTask("next").paired).toBeDefined()
  }, 60_000)

  test("a side whose setup threw isn't torn down; the other side is, once", async () => {
    const { byTask } = await runSuite(hookSuite(["cand:before"]))
    expect(byTask("t").threw).toEqual({
      side: "cand",
      message: "cand before broke",
    })
    expect(await hookLog()).toEqual([
      "base:before",
      "cand:before",
      "base:after",
    ])
    expect(byTask("next").paired).toBeDefined()
  }, 60_000)

  test("setup throwing on both sides is `both`, with no teardown", async () => {
    const { byTask } = await runSuite(hookSuite(["base:before", "cand:before"]))
    expect(byTask("t").threw!.side).toBe("both")
    expect(await hookLog()).toEqual(["base:before", "cand:before"])
  }, 60_000)

  test("a teardown error is reported alongside the other side's body error", async () => {
    const { byTask } = await runSuite(hookSuite(["base:body", "cand:after"]))
    expect(byTask("t").threw).toEqual({
      side: "both",
      message: "base: base body broke\ncandidate: cand after broke",
    })
    // The other side was probed while still set up.
    expect(await hookLog()).toEqual([
      "base:before",
      "cand:before",
      "cand:after",
      "base:after",
    ])
  }, 60_000)

  test("the other side is probed before teardown, never after", async () => {
    const { byTask } = await runSuite(hookSuite(["cand:body"]))
    expect(byTask("t").threw).toEqual({
      side: "cand",
      message: "cand body broke",
    })
    expect(await hookLog()).not.toContain("base:body-after-teardown")
    expect(byTask("next").paired).toBeDefined()
  }, 60_000)
})

describe("ab() - setup timeout and cancellation", () => {
  beforeEach(initRepo)
  afterAll(async () => {
    await Bun.spawn(["rm", "-rf", REPO]).exited
  })

  // A child of the setup shell that writes a file if it outlives the
  // shell. The odd duration makes it findable by pkill.
  const LATE = 'sleep 1.37; echo late > "$OSTIA_AB_CANDIDATE_DIR/late"'
  const killLate = () => Bun.spawn(["pkill", "-f", "sleep 1.37"]).exited

  test("a timeout kills the setup command's children and rejects promptly", async () => {
    try {
      const start = performance.now()
      const err = await ab({
        ...QUICK,
        suites: ["bench/s.bench.ts"],
        baseSetup: LATE,
        timeoutMs: 200,
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AbSetupError)
      expect((err as Error).message).toContain("timed out after 200ms")
      expect(performance.now() - start).toBeLessThan(1300)
      await Bun.sleep(1600)
      expect(existsSync(`${REPO}/late`)).toBe(false)
      expect(readdirSync(`${REPO}/node_modules/.cache/ostia/ab`)).toEqual([])
    } finally {
      await killLate()
    }
  }, 20_000)

  test("cancelling kills the setup command's children and resolves promptly", async () => {
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 200)
      const start = performance.now()
      const doc = await ab({
        ...QUICK,
        suites: ["bench/s.bench.ts"],
        baseSetup: LATE,
        signal: controller.signal,
      })
      expect(performance.now() - start).toBeLessThan(1300)
      expect(doc.ab!.matched).toBe(0)
      await Bun.sleep(1600)
      expect(existsSync(`${REPO}/late`)).toBe(false)
      expect(readdirSync(`${REPO}/node_modules/.cache/ostia/ab`)).toEqual([])
    } finally {
      await killLate()
    }
  }, 20_000)
})
