import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  baselinePath,
  DEFAULT_CONFIG,
  loadConfig,
} from "../../src/config/index.ts"

describe("loadConfig", () => {
  test("returns undefined for non-existent config file", async () => {
    const result = await loadConfig("/some/path/that/does/not/exist.json")
    expect(result).toBeUndefined()
  })

  test("merges minimal config with DEFAULT_CONFIG", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-test-"))
    try {
      const configPath = join(tmpDir, "ostia.config.json")
      const minimalConfig = { workloads: [{ command: ["bun", "x.ts"] }] }

      await Bun.write(configPath, JSON.stringify(minimalConfig))

      const result = await loadConfig(configPath)

      expect(result).toBeDefined()
      expect(result!.workloads).toHaveLength(1)
      expect(result!.workloads[0]!.command).toEqual(["bun", "x.ts"])

      expect(result!.warmup).toBe(DEFAULT_CONFIG.warmup)
      expect(result!.outDir).toBe(DEFAULT_CONFIG.outDir)
      expect(result!.baseline).toBe(DEFAULT_CONFIG.baseline)
      expect(result!.runs).toBe(DEFAULT_CONFIG.runs)
      expect(result!.cpuIntervalUs).toBe(DEFAULT_CONFIG.cpuIntervalUs)
      expect(result!.thresholds).toEqual(DEFAULT_CONFIG.thresholds)
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  })

  test("merges partial thresholds override without dropping other threshold fields", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-thresholds-test-"))
    try {
      const configPath = join(tmpDir, "ostia.config.json")
      const partialConfig = {
        workloads: [],
        thresholds: { timingPct: 2 },
      }

      await Bun.write(configPath, JSON.stringify(partialConfig))

      const result = await loadConfig(configPath)

      expect(result).toBeDefined()
      expect(result!.thresholds.timingPct).toBe(2)
      expect(result!.thresholds.frameSelfPct).toBe(
        DEFAULT_CONFIG.thresholds.frameSelfPct,
      )
      expect(result!.thresholds.heapTypePct).toBe(
        DEFAULT_CONFIG.thresholds.heapTypePct,
      )
      expect(result!.thresholds.minFrameSelfUs).toBe(
        DEFAULT_CONFIG.thresholds.minFrameSelfUs,
      )
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  })

  test("fully overrides all top-level fields when provided", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-full-override-test-"))
    try {
      const configPath = join(tmpDir, "ostia.config.json")
      const fullConfig = {
        runs: 10,
        warmup: 5,
        outDir: ".custom-tool",
        baseline: "develop",
        cpuIntervalUs: 2000,
        workloads: [{ command: ["node", "app.js"], label: "test" }],
        thresholds: {
          timingPct: 15,
          frameSelfPct: 20,
          heapTypePct: 25,
          minFrameSelfUs: 2000,
        },
      }

      await Bun.write(configPath, JSON.stringify(fullConfig))

      const result = await loadConfig(configPath)

      expect(result).toBeDefined()
      expect(result!.runs).toBe(10)
      expect(result!.warmup).toBe(5)
      expect(result!.outDir).toBe(".custom-tool")
      expect(result!.baseline).toBe("develop")
      expect(result!.cpuIntervalUs).toBe(2000)
      expect(result!.workloads).toHaveLength(1)
      expect(result!.workloads[0]!.command).toEqual(["node", "app.js"])
      expect(result!.workloads[0]!.label).toBe("test")
      expect(result!.thresholds).toEqual({
        timingPct: 15,
        frameSelfPct: 20,
        heapTypePct: 25,
        minFrameSelfUs: 2000,
      })
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  })
})

describe("baselinePath", () => {
  test("returns correct path using config baseline when name is undefined", () => {
    const config = { ...DEFAULT_CONFIG, outDir: ".ostia", baseline: "main" }

    const result = baselinePath(config, undefined)

    expect(result).toBe(".ostia/baselines/main.json")
  })

  test("returns correct path using explicit name argument when provided", () => {
    const config = { ...DEFAULT_CONFIG, outDir: ".ostia", baseline: "main" }

    const result = baselinePath(config, "pr-123")

    expect(result).toBe(".ostia/baselines/pr-123.json")
  })

  test("uses explicit name argument even when config.baseline is different", () => {
    const config = { ...DEFAULT_CONFIG, outDir: ".ostia", baseline: "main" }

    const result = baselinePath(config, "feature-branch")

    expect(result).toBe(".ostia/baselines/feature-branch.json")
  })
})
