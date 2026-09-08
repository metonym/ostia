import { describe, expect, test } from "bun:test"
import { runTimingPhase } from "../../src/measure/timing"
import {
  assertReusableTimeSource,
  type PrepareRun,
  parseReportedTime,
  prepareArgv,
  timeSourceSpec,
} from "../../src/spawn/index"

const REPORT = `${import.meta.dir}/../fixtures/report-time.ts`
const tmpPath = () =>
  `${import.meta.dir}/../../.ostia-test-prepare-${crypto.randomUUID()}.txt`
const rm = (path: string) => Bun.spawn(["rm", "-f", path]).exited

describe("measure/timing - prepare", () => {
  test("a function hook runs before every trial (warmup first) and each trial sees its own hook's effect", async () => {
    const path = tmpPath()
    const seen: PrepareRun[] = []
    let n = 0
    const result = await runTimingPhase({
      argv: ["bun", REPORT, path],
      samples: 3,
      warmup: 2,
      prepare: async (run) => {
        seen.push(run)
        await Bun.write(path, String(n++))
      },
      timeSource: { pattern: /in (\d+)ms/ },
    })
    expect(seen).toEqual([
      { phase: "warmup", index: 0 },
      { phase: "warmup", index: 1 },
      { phase: "timing", index: 0 },
      { phase: "timing", index: 1 },
      { phase: "timing", index: 2 },
    ])
    // Warmup consumed 0 and 1. Each timed trial reports exactly the value its
    // own prepare wrote, so hooks landed before their trial - not batched up
    // front or reordered.
    expect(result.trials.map((t) => t.reportedNs)).toEqual([2e6, 3e6, 4e6])
    expect(result.timing!.samples).toEqual([2e6, 3e6, 4e6])
    for (const t of result.trials) expect(t.wallNs).toBeGreaterThan(0)
    await rm(path)
  }, 20_000)

  test("an argv-form hook is spawned and awaited before the trial", async () => {
    const path = tmpPath()
    const result = await runTimingPhase({
      argv: ["bun", REPORT, path],
      samples: 1,
      warmup: 0,
      prepare: ["bun", "-e", `await Bun.write(${JSON.stringify(path)}, "5")`],
      timeSource: { pattern: "in (\\d+)ms" },
    })
    expect(result.trials[0]!.reportedNs).toBe(5e6)
    await rm(path)
  }, 20_000)

  test("a non-zero exit from a command-form hook aborts the run", async () => {
    await expect(
      runTimingPhase({
        argv: ["bun", REPORT],
        samples: 1,
        warmup: 0,
        prepare: ["bun", "-e", "process.exit(3)"],
      }),
    ).rejects.toThrow(
      /prepare command .* exited with code 3 before timing trial 0/,
    )
  }, 20_000)

  test("a failing hook's captured stderr (bounded, not streamed live) is folded into the thrown error", async () => {
    await expect(
      runTimingPhase({
        argv: ["bun", REPORT],
        samples: 1,
        warmup: 0,
        prepare: [
          "bun",
          "-e",
          "console.error('setup went wrong'); process.exit(1)",
        ],
      }),
    ).rejects.toThrow(/exited with code 1.*setup went wrong/s)
  }, 20_000)

  test("prepareArgv: string form is whitespace-split, argv passes through, functions serialize to nothing", () => {
    expect(prepareArgv("rm  -rf dist")).toEqual(["rm", "-rf", "dist"])
    expect(prepareArgv(["rm", "-rf", "my dir"])).toEqual([
      "rm",
      "-rf",
      "my dir",
    ])
    expect(prepareArgv(() => {})).toBeUndefined()
    expect(prepareArgv(undefined)).toBeUndefined()
  })
})

describe("spawn - timeSource", () => {
  test("parseReportedTime: group 1 and ms by default; explicit group/unit; RegExp or string pattern", () => {
    expect(
      parseReportedTime({ pattern: "in (\\d+)ms" }, "built in 342ms", ""),
    ).toBe(342e6)
    expect(
      parseReportedTime(
        { pattern: /(\d+) pages in (\d+\.\d+)s/, group: 2, unit: "s" },
        "built 3 pages in 1.5s",
        "",
      ),
    ).toBe(1.5e9)
    expect(
      parseReportedTime({ pattern: /(\d+)us/, unit: "us" }, "12us", ""),
    ).toBe(12e3)
    expect(
      parseReportedTime({ pattern: /(\d+)ns/, unit: "ns" }, "9ns", ""),
    ).toBe(9)
  })

  test("parseReportedTime: falls back to stderr when stdout has no match", () => {
    expect(
      parseReportedTime({ pattern: /took (\d+)ms/ }, "ok\n", "took 20ms\n"),
    ).toBe(20e6)
  })

  test("parseReportedTime: no match throws and quotes the output", () => {
    expect(() =>
      parseReportedTime({ pattern: /took (\d+)ms/ }, "done in 3ms", "", [
        "bun",
        "x.ts",
      ]),
    ).toThrow(/did not match the output for "bun x.ts"[\s\S]*done in 3ms/)
  })

  test("parseReportedTime: missing group / non-numeric capture throw", () => {
    expect(() =>
      parseReportedTime({ pattern: /took \d+ms/ }, "took 3ms", ""),
    ).toThrow(/no capture group 1/)
    expect(() =>
      parseReportedTime({ pattern: /took (\w+)/ }, "took forever", ""),
    ).toThrow(/"forever".*not a number/)
  })

  test("timeSourceSpec: RegExp becomes its source string; only given fields are kept", () => {
    expect(timeSourceSpec({ pattern: /in (\d+)ms/ })).toEqual({
      pattern: "in (\\d+)ms",
    })
    expect(timeSourceSpec({ pattern: "x(\\d)", group: 1, unit: "s" })).toEqual({
      pattern: "x(\\d)",
      group: 1,
      unit: "s",
    })
    expect(timeSourceSpec(undefined)).toBeUndefined()
  })

  test("assertReusableTimeSource: rejects a RegExp with the g, y, or d flag; a plain RegExp or string is fine", () => {
    expect(() => assertReusableTimeSource({ pattern: /in (\d+)ms/g })).toThrow(
      RangeError,
    )
    expect(() => assertReusableTimeSource({ pattern: /in (\d+)ms/g })).toThrow(
      /timeSource pattern must not use the g or y flag/,
    )
    expect(() => assertReusableTimeSource({ pattern: /in (\d+)ms/y })).toThrow(
      RangeError,
    )
    expect(() => assertReusableTimeSource({ pattern: /in (\d+)ms/d })).toThrow(
      RangeError,
    )
    expect(() =>
      assertReusableTimeSource({ pattern: /in (\d+)ms/ }),
    ).not.toThrow()
    expect(() =>
      assertReusableTimeSource({ pattern: "in (\\d+)ms" }),
    ).not.toThrow()
  })

  test("parseReportedTime: accepts scientific notation in the captured number", () => {
    expect(
      parseReportedTime(
        { pattern: /in ([\d.e+-]+)ms/ },
        "built in 1.2e3ms",
        "",
      ),
    ).toBe(1200e6)
  })

  test("a workload constructed with a g/y/d-flagged timeSource throws before any trial runs", async () => {
    await expect(
      runTimingPhase({
        argv: ["bun", REPORT],
        samples: 1,
        warmup: 0,
        timeSource: { pattern: /in (\d+)ms/g },
      }),
    ).rejects.toThrow(/timeSource pattern must not use the g or y flag/)
  })

  test("a timeSource phase samples the reported number, keeps wallNs, and skips the spawn-overhead warning", async () => {
    const result = await runTimingPhase({
      argv: ["bun", REPORT],
      samples: 3,
      warmup: 0,
      timeSource: { pattern: /in (\d+)ms/ },
    })
    expect(result.timing!.samples).toEqual([7e6, 7e6, 7e6])
    expect(result.timing!.median).toBe(7e6)
    for (const t of result.trials) {
      expect(t.reportedNs).toBe(7e6)
      expect(t.wallNs).toBeGreaterThan(0)
      expect(t.exitCode).toBe(0)
    }
    // "reported" mode never attributes a self-reported number to spawn
    // overhead, whatever its size.
    expect(result.warnings.map((w) => w.code)).not.toContain("fast-command")
  }, 20_000)

  test("a trial whose output doesn't match contributes no sample instead of aborting the run", async () => {
    const result = await runTimingPhase({
      argv: ["bun", REPORT],
      samples: 1,
      warmup: 0,
      timeSource: { pattern: /compiled in (\d+)ms/ },
    })
    expect(result.timing).toBeUndefined()
    expect(result.trials).toHaveLength(1)
    expect(result.trials[0]!.timeSourceNoMatch).toBe(true)
    expect(result.trials[0]!.reportedNs).toBeUndefined()
    const warning = result.warnings.find(
      (w) => w.code === "time-source-no-match",
    )
    expect(warning).toBeDefined()
    expect(warning?.data?.trials).toBe(1)
    expect(warning?.data?.pattern).toBe("compiled in (\\d+)ms")
  }, 20_000)

  test("a mix of matching and non-matching trials samples only the matches, never falling back to wallNs", async () => {
    const path = tmpPath()
    // First trial's output doesn't match (no marker yet); every trial after
    // that does (marker now exists) - deterministic without timing.
    const result = await runTimingPhase({
      argv: [
        "bun",
        "-e",
        `if (await Bun.file(${JSON.stringify(path)}).exists()) { console.log("built in 9ms") } else { await Bun.write(${JSON.stringify(path)}, "1"); console.log("no number here") }`,
      ],
      samples: 2,
      warmup: 0,
      timeSource: { pattern: /in (\d+)ms/ },
    })
    expect(result.trials).toHaveLength(2)
    expect(result.trials[0]!.timeSourceNoMatch).toBe(true)
    expect(result.trials[1]!.reportedNs).toBe(9e6)
    expect(result.timing?.samples).toEqual([9e6])
    const warning = result.warnings.find(
      (w) => w.code === "time-source-no-match",
    )
    expect(warning?.data).toMatchObject({ trials: 1 })
    await rm(path)
  }, 20_000)
})
