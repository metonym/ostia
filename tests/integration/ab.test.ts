import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, utimesSync } from "node:fs"
import { AbBaseError, ab } from "../../src/ab/index.ts"
import { OstiaUsageError } from "../../src/errors.ts"
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
    expect(work.paired!.ratioP25).toBeGreaterThan(1)
    expect(work.paired!.ratioP75).toBeGreaterThanOrEqual(work.paired!.ratioP25)
    expect(work.paired!.repeats![0]!.ratioP25).toBeGreaterThan(1)
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

  test("a suite file that doesn't exist is a usage error", async () => {
    const err = await ab({ ...QUICK, suites: ["bench/nope.bench.ts"] }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(OstiaUsageError)
    expect(err.message).toBe("Suite not found: bench/nope.bench.ts")
  }, 20_000)

  test("a .only in the candidate leaves base-only tasks out, like --filter does", async () => {
    await Bun.write(
      `${REPO}/bench/s.bench.ts`,
      SUITE.replace('  task("stable", () => spin(20_000))\n', "").replace(
        'task("work"',
        'task.only("work"',
      ),
    )
    const doc = await ab({ ...QUICK, suites: ["bench/s.bench.ts"], confirm: 0 })
    expect(doc.ab!.matched).toBe(1)
    expect(doc.unmatched!.baseOnly).toEqual([])
  }, 60_000)

  test("concurrent runs sharing an outDir don't delete each other's scratch files", async () => {
    const run = () => ab({ ...QUICK, suites: ["bench/s.bench.ts"], confirm: 0 })
    const [a, b] = await Promise.all([run(), run()])
    expect(a.ab!.matched).toBe(2)
    expect(b.ab!.matched).toBe(2)
  }, 60_000)

  test("prunes old base trees past the five most recent, sparing recently used ones", async () => {
    const root = `${REPO}/node_modules/.cache/ostia/ab`
    const age = (name: string, ageMs: number) => {
      mkdirSync(`${root}/${name}`, { recursive: true })
      const when = new Date(Date.now() - ageMs)
      utimesSync(`${root}/${name}`, when, when)
    }
    const DAY = 24 * 60 * 60 * 1000
    for (let i = 1; i <= 6; i++) age(`old-${i}`, i * DAY)
    age("recent-1", 60_000)
    age("recent-2", 120_000)
    age("abandoned.tmp-1-abc", 2 * DAY)

    await ab({ ...QUICK, suites: ["bench/s.bench.ts"], confirm: 0 })

    const sha = await sh(["git", "rev-parse", "HEAD"])
    const left = (
      await Array.fromAsync(
        new Bun.Glob("*").scan({ cwd: root, onlyFiles: false }),
      )
    ).sort()
    // This run's tree, the two recent ones, and the two newest of the old.
    expect(left).toEqual(["old-1", "old-2", "recent-1", "recent-2", sha].sort())
  }, 60_000)

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
    expect(work?.event === "run" && work.paired?.ratioP25).toBeGreaterThan(1)
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
    expect(stdout).toMatch(/g\/work .* regressed/)
    expect(stdout).toContain("Geomean +")
  }, 60_000)

  test("exits 2 when nothing pairs, and on an unknown ref", async () => {
    await Bun.write(`${REPO}/bench/new.bench.ts`, SUITE)
    const none = await runCli(["bench/new.bench.ts", "--no-noise-check"])
    expect(none.exitCode).toBe(2)
    expect(none.stderr).toContain('"code":"no-matches"')

    const badRef = await runCli(["bench/s.bench.ts", "--base", "nope"])
    expect(badRef.exitCode).toBe(2)
    expect(badRef.stderr).toContain('"code":"invalid-flag"')
  }, 60_000)

  test("rejects fewer than 3 rounds and a non-numeric threshold", async () => {
    const rounds = await runCli(["bench/s.bench.ts", "--rounds", "2"])
    expect(rounds.exitCode).toBe(2)
    const threshold = await runCli(["bench/s.bench.ts", "--threshold", "x"])
    expect(threshold.exitCode).toBe(2)
    expect(threshold.stderr).toContain("expected a number")
  }, 20_000)
})
