import { afterAll, describe, expect, test } from "bun:test"
import {
  BaselineNotFoundError,
  renderCiReport,
  runCi,
} from "../../src/ci/index.ts"
import {
  baselinePath,
  DEFAULT_CONFIG,
  type OstiaConfig,
} from "../../src/config/index.ts"
import { time } from "../../src/index.ts"
import { saveDocument } from "../../src/ir/document.ts"

const FIXTURE = `${import.meta.dir}/../fixtures/work.ts`
const OUT_DIR = `${import.meta.dir}/../../.ostia-test-ci`

function config(overrides: Partial<OstiaConfig> = {}): OstiaConfig {
  const outDir = overrides.outDir ?? OUT_DIR
  return {
    ...DEFAULT_CONFIG,
    outDir,
    baselineDir: `${outDir}/baselines`,
    baseline: "main",
    runs: 3,
    warmup: 1,
    workloads: [{ label: "work", command: ["bun", FIXTURE] }],
    ...overrides,
  }
}

describe("runCi", () => {
  afterAll(async () => {
    await Bun.spawn(["rm", "-rf", OUT_DIR]).exited
  })

  test("throws BaselineNotFoundError with a clear message when no baseline exists", async () => {
    const cfg = config({ outDir: `${OUT_DIR}-missing-baseline` })
    await expect(runCi({ config: cfg, full: false })).rejects.toThrow(
      BaselineNotFoundError,
    )
  }, 10_000)

  test("first pass executes (cache miss); second pass with no source change hits cache", async () => {
    const cfg = config()
    const baseline = await time({
      commands: [["bun", FIXTURE]],
      runs: 3,
      warmup: 1,
      noiseCheck: false,
    })
    await saveDocument(baseline, baselinePath(cfg))

    const first = await runCi({ config: cfg, full: false })
    expect(first.summary.total).toBe(1)
    expect(first.summary.affected).toBe(1)
    expect(first.summary.cached).toBe(0)
    expect(first.summary.executed).toBe(1)
    expect(first.summary.results[0]!.status).toBe("executed")

    const second = await runCi({ config: cfg, full: false })
    expect(second.summary.affected).toBe(0)
    expect(second.summary.cached).toBe(1)
    expect(second.summary.executed).toBe(0)
    expect(second.summary.results[0]!.status).toBe("cached")
    expect(second.summary.results[0]!.run.id).toBe(
      first.summary.results[0]!.run.id,
    )
  }, 30_000)

  test("--full ignores the cache and always executes", async () => {
    const cfg = config({ outDir: `${OUT_DIR}-full` })
    const baseline = await time({
      commands: [["bun", FIXTURE]],
      runs: 3,
      warmup: 1,
      noiseCheck: false,
    })
    await saveDocument(baseline, baselinePath(cfg))

    await runCi({ config: cfg, full: false })
    const forced = await runCi({ config: cfg, full: true })
    expect(forced.summary.executed).toBe(1)
    expect(forced.summary.cached).toBe(0)

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-full`]).exited
  }, 30_000)

  test("declared inputs invalidate the cache when the tracked file changes", async () => {
    const trackedDir = ".ostia-test-ci-inputs-src"
    await Bun.spawn(["mkdir", "-p", trackedDir]).exited
    const trackedFile = `${trackedDir}/tracked.ts`
    await Bun.write(trackedFile, "export const x = 1\n")

    const cfg = config({
      outDir: `${OUT_DIR}-inputs-out`,
      workloads: [
        { label: "work", command: ["bun", FIXTURE], inputs: [trackedFile] },
      ],
    })
    const baseline = await time({
      commands: [["bun", FIXTURE]],
      runs: 3,
      warmup: 1,
      noiseCheck: false,
    })
    await saveDocument(baseline, baselinePath(cfg))

    const first = await runCi({ config: cfg, full: false })
    expect(first.summary.executed).toBe(1)

    const second = await runCi({ config: cfg, full: false })
    expect(second.summary.cached).toBe(1)

    await Bun.write(trackedFile, "export const x = 2\n")
    const third = await runCi({ config: cfg, full: false })
    expect(third.summary.executed).toBe(1)
    expect(third.summary.cached).toBe(0)

    await Bun.spawn(["rm", "-rf", trackedDir, `${OUT_DIR}-inputs-out`]).exited
  }, 30_000)

  test("renderCiReport prints the required fields and gate line", async () => {
    const cfg = config({ outDir: `${OUT_DIR}-report` })
    const baseline = await time({
      commands: [["bun", FIXTURE]],
      runs: 3,
      warmup: 1,
      noiseCheck: false,
    })
    await saveDocument(baseline, baselinePath(cfg))
    const outcome = await runCi({ config: cfg, full: false })

    const text = renderCiReport(outcome.summary)
    expect(text).toContain("1 workloads")
    expect(text).toContain("affected by this change")
    expect(text).toMatch(/Profile CI: [✓✗]/)

    await Bun.spawn(["rm", "-rf", `${OUT_DIR}-report`]).exited
  }, 20_000)
})
