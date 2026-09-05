import { describe, expect, test } from "bun:test"
import { listBaselines, saveBaseline } from "../../src/baseline/index.ts"
import { DEFAULT_CONFIG, type OstiaConfig } from "../../src/config/index.ts"
import { loadDocument } from "../../src/ir/document.ts"

const FIXTURE = `${import.meta.dir}/../fixtures/work.ts`
const OUT_DIR = `${import.meta.dir}/../../.ostia-test-baseline`

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

describe("saveBaseline", () => {
  test("measures configured workloads and writes a loadable ProfileDocument", async () => {
    const outDir = `${OUT_DIR}-save`
    const cfg = config({ outDir })

    const path = await saveBaseline(cfg)
    expect(path).toBe(`${outDir}/baselines/main.json`)

    const doc = await loadDocument(path)
    expect(doc.workloads).toHaveLength(1)
    expect(doc.measurements).toHaveLength(1)
    expect(doc.measurements[0]!.phase).toBe("timing")

    await Bun.spawn(["rm", "-rf", outDir]).exited
  }, 20_000)

  test("an explicit name writes to <baselineDir>/<name>.json instead of the config default", async () => {
    const outDir = `${OUT_DIR}-save-named`
    const cfg = config({ outDir })

    const path = await saveBaseline(cfg, "my-feature")
    expect(path).toBe(`${outDir}/baselines/my-feature.json`)
    expect(await Bun.file(path).exists()).toBe(true)

    await Bun.spawn(["rm", "-rf", outDir]).exited
  }, 20_000)

  test("a suites workload contributes one measurement per task, same as ci", async () => {
    const outDir = `${OUT_DIR}-save-suites`
    const cfg = config({
      outDir,
      workloads: [
        { label: "dogfood", suites: ["tests/fixtures/bench-suite.ts"] },
      ],
    })

    const path = await saveBaseline(cfg)
    const doc = await loadDocument(path)
    expect(doc.workloads).toHaveLength(3)
    expect(doc.workloads.map((w) => w.label).sort()).toEqual(
      ["math/hotInner-large", "math/hotInner-small", "noop"].sort(),
    )

    await Bun.spawn(["rm", "-rf", outDir]).exited
  }, 20_000)
})

describe("listBaselines", () => {
  test("an empty (or missing) baselineDir yields an empty list, not an error", async () => {
    const outDir = `${OUT_DIR}-list-empty`
    const cfg = config({ outDir })
    expect(await listBaselines(cfg)).toEqual([])
  })

  test("lists every saved baseline by name, sorted, with workload counts", async () => {
    const outDir = `${OUT_DIR}-list`
    const cfg = config({ outDir })

    await saveBaseline(cfg, "zeta")
    await saveBaseline(cfg, "alpha")

    const infos = await listBaselines(cfg)
    expect(infos.map((i) => i.name)).toEqual(["alpha", "zeta"])
    for (const info of infos) {
      expect(info.workloads).toBe(1)
      expect(info.toolVersion).toBeTruthy()
      expect(info.createdAt).toBeTruthy()
    }

    await Bun.spawn(["rm", "-rf", outDir]).exited
  }, 20_000)
})

describe("saveBaseline / measureConfigWorkloads share ci's bench()-defaults wiring", () => {
  test("suites workloads use config.bench's budgetMs/samples, not bench()'s own defaults", async () => {
    const outDir = `${OUT_DIR}-bench-defaults`
    const cfg = config({
      outDir,
      bench: { samples: 2 },
      workloads: [
        { label: "dogfood", suites: ["tests/fixtures/bench-suite.ts"] },
      ],
    })

    const path = await saveBaseline(cfg)
    const doc = await loadDocument(path)
    for (const m of doc.measurements) {
      expect(m.trials).toHaveLength(2)
    }

    await Bun.spawn(["rm", "-rf", outDir]).exited
  }, 20_000)
})
