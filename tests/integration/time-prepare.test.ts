import { afterAll, describe, expect, test } from "bun:test"
import { runCi } from "../../src/ci/index.ts"
import {
  baselinePath,
  DEFAULT_CONFIG,
  type OstiaConfig,
} from "../../src/config/index.ts"
import { time } from "../../src/index.ts"
import { saveDocument } from "../../src/ir/document.ts"

const CLI = `${import.meta.dir}/../../src/cli/main.ts`
const REPORT = `${import.meta.dir}/../fixtures/report-time.ts`
const OUT_DIR = `${import.meta.dir}/../../.ostia-test-time-prepare`
const tmpPath = () => `${OUT_DIR}/${crypto.randomUUID()}.txt`

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

afterAll(async () => {
  await Bun.spawn(["rm", "-rf", OUT_DIR]).exited
})

describe("time() - prepare / timeSource / CommandSpec", () => {
  test("the same command timed warm and cold (per-command prepare) is two labeled workloads", async () => {
    const path = tmpPath()
    let cold = 0
    const doc = await time({
      commands: [
        { command: ["bun", REPORT, path], label: "warm" },
        {
          command: ["bun", REPORT, path],
          label: "cold",
          prepare: async () => {
            cold++
            await Bun.write(path, "1")
          },
        },
      ],
      // Warm has no hook of its own; the top-level one applies to it.
      prepare: () => Bun.write(path, "2"),
      timeSource: { pattern: /in (\d+)ms/ },
      samples: 2,
      warmup: 1,
      noiseCheck: false,
    })
    expect(doc.workloads.map((w) => w.label)).toEqual(["warm", "cold"])
    expect(doc.workloads[0]!.id).not.toBe(doc.workloads[1]!.id)
    expect(doc.workloads[0]!.timeSource).toEqual({ pattern: "in (\\d+)ms" })
    const [warm, coldRun] = doc.measurements
    expect(warm!.timing!.samples).toEqual([2e6, 2e6])
    expect(coldRun!.timing!.samples).toEqual([1e6, 1e6])
    expect(coldRun!.interleaved).toBe(true)
    // 1 warmup + 2 samples for the cold command only.
    expect(cold).toBe(3)
  }, 30_000)

  test("prepare also runs ahead of an instrumented --cpu trial", async () => {
    const path = tmpPath()
    const phases: string[] = []
    await time({
      commands: [["bun", REPORT, path]],
      prepare: async (run) => {
        phases.push(run.phase)
        await Bun.write(path, "3")
      },
      samples: 1,
      warmup: 0,
      cpu: true,
      outDir: OUT_DIR,
      noiseCheck: false,
    })
    expect(phases).toEqual(["timing", "cpu"])
  }, 30_000)
})

describe("ostia time --prepare / --time-source", () => {
  test("--time-source samples the reported number and --format json carries wallNs alongside", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "time",
      "--samples",
      "2",
      "--warmup",
      "0",
      "--no-noise-check",
      "--time-source",
      "in (\\d+)ms",
      "--format",
      "json",
      `bun ${REPORT}`,
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const doc = JSON.parse(stdout)
    expect(doc.workloads[0].timeSource).toEqual({ pattern: "in (\\d+)ms" })
    expect(doc.measurements[0].timing.samples).toEqual([7e6, 7e6])
    // Wall time is the real spawn cost, unrelated to the fake 7ms the fixture
    // reports; both survive on the trial.
    expect(doc.measurements[0].trials[0].wallNs).toBeGreaterThan(0)
    expect(doc.measurements[0].trials[0].reportedNs).toBe(7e6)
  }, 30_000)

  test("--prepare once per command pairs in order; a mismatched count is a usage error", async () => {
    const path = tmpPath()
    const ok = await runCli([
      "time",
      "--samples",
      "1",
      "--warmup",
      "0",
      "--no-noise-check",
      "--no-interleave",
      "--prepare",
      `bun -e Bun.write("${path}","4")`,
      "--prepare",
      `bun -e Bun.write("${path}","6")`,
      "--time-source",
      "in (\\d+)ms",
      "--format",
      "json",
      `bun ${REPORT} ${path}`,
      `bun ${REPORT} ${path}`,
    ])
    expect(ok.stderr).toBe("")
    expect(ok.exitCode).toBe(0)
    const doc = JSON.parse(ok.stdout)
    expect(doc.workloads[0].prepare).toEqual([
      "bun",
      "-e",
      `Bun.write("${path}","4")`,
    ])
    expect(
      doc.measurements.map(
        (m: { timing: { samples: number[] } }) => m.timing.samples,
      ),
    ).toEqual([[4e6], [6e6]])

    const bad = await runCli([
      "time",
      "--prepare",
      "true",
      "--prepare",
      "true",
      "--prepare",
      "true",
      `bun ${REPORT}`,
      `bun ${REPORT}`,
    ])
    expect(bad.exitCode).toBe(2)
    expect(bad.stderr).toMatch(/--prepare given 3 times for 2 command/)
  }, 30_000)

  test("--time-unit rejects unknown units; --time-source rejects a bad regex", async () => {
    const unit = await runCli([
      "time",
      "--time-source",
      "(\\d+)",
      "--time-unit",
      "min",
      `bun ${REPORT}`,
    ])
    expect(unit.exitCode).toBe(2)
    expect(unit.stderr).toMatch(/Unknown --time-unit "min"/)
    const re = await runCli(["time", "--time-source", "(\\d+", `bun ${REPORT}`])
    expect(re.exitCode).toBe(2)
    expect(re.stderr).toMatch(/Invalid --time-source regex/)
  }, 30_000)
})

describe("ostia ci - prepare / timeSource workloads", () => {
  function config(
    workloads: OstiaConfig["workloads"],
    outDir: string,
  ): OstiaConfig {
    return {
      ...DEFAULT_CONFIG,
      outDir,
      baselineDir: `${outDir}/baselines`,
      baseline: "main",
      runs: 2,
      warmup: 0,
      workloads,
    }
  }

  test("a command-form prepare is part of the workload id and caches; a function-form prepare never caches", async () => {
    const outDir = `${OUT_DIR}/ci`
    const path = tmpPath()
    await Bun.write(path, "1")
    const workloads: OstiaConfig["workloads"] = [
      {
        label: "argv-prepare",
        command: ["bun", REPORT, path],
        prepare: ["bun", "-e", `Bun.write("${path}","2")`],
        timeSource: { pattern: "in (\\d+)ms" },
        inputs: [],
      },
      {
        label: "fn-prepare",
        command: ["bun", REPORT, path],
        prepare: () => Bun.write(path, "3"),
        timeSource: { pattern: "in (\\d+)ms" },
      },
    ]
    const cfg = config(workloads, outDir)
    const baseline = await time({
      commands: workloads.map((w) => ({
        command: w.command!,
        label: w.label,
        prepare: w.prepare,
        timeSource: w.timeSource,
      })),
      samples: 2,
      warmup: 0,
      noiseCheck: false,
    })
    await saveDocument(baseline, baselinePath(cfg))

    const first = await runCi({ config: cfg, full: false })
    expect(first.summary.missingBaseline).toBe(0)
    expect(first.summary.results.map((r) => r.status)).toEqual([
      "executed",
      "executed",
    ])
    expect(first.summary.results[0]!.run.timing!.samples).toEqual([2e6, 2e6])
    expect(first.summary.results[1]!.run.timing!.samples).toEqual([3e6, 3e6])

    const second = await runCi({ config: cfg, full: false })
    expect(second.summary.results.map((r) => r.status)).toEqual([
      "cached",
      "executed",
    ])
  }, 40_000)
})
