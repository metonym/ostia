import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  baselinePath,
  ConfigError,
  DEFAULT_CONFIG,
  loadConfig,
  type OstiaConfig,
} from "../../src/config/index.ts"

const INDEX_MODULE = `${import.meta.dir}/../../src/index.ts`
const CONFIG_MODULE = `${import.meta.dir}/../../src/config/index.ts`

/** `loadConfig()`'s no-arg discovery reads the CURRENT process's cwd, so
 * exercising it against a scratch directory needs a real subprocess rather
 * than `process.chdir()` (a global mutation that could race other test
 * files sharing this same `bun test` process). */
async function loadConfigIn(cwd: string): Promise<unknown> {
  const { config, stderr } = await loadConfigWithStderr(cwd)
  if (stderr) throw new Error(stderr)
  return config
}

async function loadConfigWithStderr(
  cwd: string,
): Promise<{ config: unknown; stderr: string }> {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import { loadConfig } from "${CONFIG_MODULE}"; console.log(JSON.stringify((await loadConfig()) ?? null))`,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode).toBe(0)
  return { config: JSON.parse(stdout.trim()), stderr }
}

describe("loadConfig", () => {
  test("returns undefined for non-existent config file", async () => {
    const result = await loadConfig("/some/path/that/does/not/exist.json")
    expect(result).toBeUndefined()
  })

  test("an explicit .ts path loads the file's default export", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-ts-test-"))
    try {
      const configPath = join(tmpDir, "ostia.config.ts")
      await Bun.write(
        configPath,
        `import { defineConfig } from "${INDEX_MODULE}"\n` +
          `export default defineConfig({ baseline: "from-ts", workloads: [{ command: ["bun", "x.ts"] }] })\n`,
      )

      const result = await loadConfig(configPath)
      expect(result).toBeDefined()
      expect(result!.baseline).toBe("from-ts")
      expect(result!.workloads).toEqual([{ command: ["bun", "x.ts"] }])
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  })

  test("no-arg discovery prefers ostia.config.ts over ostia.config.json in the same directory (item 18)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-discovery-ts-"))
    try {
      await Bun.write(
        join(tmpDir, "ostia.config.ts"),
        `import { defineConfig } from "${INDEX_MODULE}"\n` +
          `export default defineConfig({ baseline: "from-ts" })\n`,
      )
      await Bun.write(
        join(tmpDir, "ostia.config.json"),
        JSON.stringify({ baseline: "from-json" }),
      )

      const { config, stderr } = await loadConfigWithStderr(tmpDir)
      expect((config as { baseline: string }).baseline).toBe("from-ts")
      expect(stderr).toContain(
        "ostia.config.ts and ostia.config.json both exist",
      )
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  }, 10_000)

  test("no-arg discovery falls back to ostia.config.json when no .ts config exists", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-discovery-json-"))
    try {
      await Bun.write(
        join(tmpDir, "ostia.config.json"),
        JSON.stringify({ baseline: "from-json" }),
      )

      const result = (await loadConfigIn(tmpDir)) as { baseline: string }
      expect(result.baseline).toBe("from-json")
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  }, 10_000)

  test("no-arg discovery returns undefined when neither config file exists", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-discovery-none-"))
    try {
      const result = await loadConfigIn(tmpDir)
      expect(result).toBeNull()
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  }, 10_000)
})

/** `configFilePath()` reads the CURRENT process's cwd (mirroring
 * `loadConfig()`'s no-arg discovery), so it needs a subprocess the same way
 * `loadConfigIn` above does. */
async function configFilePathIn(cwd: string): Promise<string | null> {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import { configFilePath } from "${CONFIG_MODULE}"; console.log(JSON.stringify((await configFilePath()) ?? null))`,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode).toBe(0)
  if (stderr) throw new Error(stderr)
  return JSON.parse(stdout.trim())
}

describe("configFilePath", () => {
  test("prefers ostia.config.ts over ostia.config.json", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-file-path-ts-"))
    try {
      await Bun.write(join(tmpDir, "ostia.config.ts"), "export default {}\n")
      await Bun.write(join(tmpDir, "ostia.config.json"), "{}")
      expect(await configFilePathIn(tmpDir)).toBe("ostia.config.ts")
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  }, 10_000)

  test("falls back to ostia.config.json when no .ts config exists", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-file-path-json-"))
    try {
      await Bun.write(join(tmpDir, "ostia.config.json"), "{}")
      expect(await configFilePathIn(tmpDir)).toBe("ostia.config.json")
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  }, 10_000)

  test("returns undefined when neither config file exists", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-file-path-none-"))
    try {
      expect(await configFilePathIn(tmpDir)).toBeNull()
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  }, 10_000)

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
      expect(result!.baselineDir).toBe(DEFAULT_CONFIG.baselineDir)
      expect(result!.baseline).toBe(DEFAULT_CONFIG.baseline)
      expect(result!.samples).toBeUndefined()
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
        samples: 10,
        warmup: 5,
        outDir: ".custom-tool",
        baselineDir: ".custom-tool/baselines",
        baseline: "develop",
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
      expect(result!.samples).toBe(10)
      expect(result!.warmup).toBe(5)
      expect(result!.outDir).toBe(".custom-tool")
      expect(result!.baselineDir).toBe(".custom-tool/baselines")
      expect(result!.baseline).toBe("develop")
      expect(result!.workloads).toHaveLength(1)
      expect(result!.workloads[0]!.command).toEqual(["node", "app.js"])
      expect(result!.workloads[0]!.label).toBe("test")
      expect(result!.thresholds).toEqual({
        timingPct: 15,
        frameSelfPct: 20,
        heapTypePct: 25,
        minFrameSelfUs: 2000,
        alpha: DEFAULT_CONFIG.thresholds.alpha,
        bootstrapIterations: DEFAULT_CONFIG.thresholds.bootstrapIterations,
      })
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  })
})

describe("loadConfig - invalid configs", () => {
  test("a renamed field fails loudly instead of being silently ignored", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-renamed-test-"))
    try {
      const configPath = join(tmpDir, "ostia.config.json")
      await Bun.write(configPath, JSON.stringify({ runs: 5, workloads: [] }))
      const load = loadConfig(configPath)
      await expect(load).rejects.toBeInstanceOf(ConfigError)
      await expect(loadConfig(configPath)).rejects.toThrow(
        '"runs" was renamed to "samples"',
      )
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  })

  test("unparseable JSON is a ConfigError naming the file", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-bad-json-test-"))
    try {
      const configPath = join(tmpDir, "ostia.config.json")
      await Bun.write(configPath, "{ not json")
      await expect(loadConfig(configPath)).rejects.toThrow(configPath)
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  })
})

describe("loadConfig - ostia.config.ts quirks", () => {
  test("a .ts config with no default export is an error, not an empty config", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-no-default-"))
    try {
      const configPath = join(tmpDir, "ostia.config.ts")
      await Bun.write(configPath, "export const config = { baseline: 'x' }\n")
      await expect(loadConfig(configPath)).rejects.toThrow("no default export")
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  })

  test("an explicit undefined keeps the default instead of overwriting it", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-undefined-"))
    try {
      const configPath = join(tmpDir, "ostia.config.ts")
      await Bun.write(
        configPath,
        "export default { warmup: undefined, baseline: undefined, thresholds: { timingPct: undefined, alpha: 0.05 } }\n",
      )
      const result = (await loadConfig(configPath))!
      expect(result.warmup).toBe(DEFAULT_CONFIG.warmup)
      expect(result.baseline).toBe(DEFAULT_CONFIG.baseline)
      expect(result.thresholds.timingPct).toBe(
        DEFAULT_CONFIG.thresholds.timingPct,
      )
      expect(result.thresholds.alpha).toBe(0.05)
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  })
})

describe("loadConfig - shape validation", () => {
  async function loadJson(config: unknown): Promise<OstiaConfig | undefined> {
    const tmpDir = await mkdtemp(join(tmpdir(), "config-shape-"))
    try {
      const configPath = join(tmpDir, "ostia.config.json")
      await Bun.write(configPath, JSON.stringify(config))
      return await loadConfig(configPath)
    } finally {
      await Bun.$`rm -rf ${tmpDir}`
    }
  }

  const rejects: Array<[string, unknown, string]> = [
    [
      "a string samples",
      { samples: "5" },
      `"samples" must be a positive integer, got "5"`,
    ],
    [
      "a fractional warmup",
      { warmup: 1.5 },
      `"warmup" must be a non-negative integer`,
    ],
    [
      "a non-array workloads",
      { workloads: "x" },
      `"workloads" must be an array`,
    ],
    [
      "a non-object workload",
      { workloads: [1] },
      `"workloads[0]" must be an object`,
    ],
    [
      "a workload with neither command nor suites",
      { workloads: [{ label: "x" }] },
      `"workloads[0]" needs exactly one of "command" or "suites"`,
    ],
    [
      "a workload with both",
      { workloads: [{ command: ["a"], suites: ["b"] }] },
      `"workloads[0]" needs exactly one`,
    ],
    [
      "a string command",
      { workloads: [{ command: "bun x.ts" }] },
      `"workloads[0].command" must be a non-empty array of strings`,
    ],
    [
      "a non-array inputs",
      { workloads: [{ command: ["a"], inputs: "src" }] },
      `"workloads[0].inputs" must be an array of strings`,
    ],
    [
      "an out-of-range exit code",
      { workloads: [{ command: ["a"], ignoreExitCodes: [256] }] },
      `"workloads[0].ignoreExitCodes"`,
    ],
    [
      "a bad timeSource regex",
      { workloads: [{ command: ["a"], timeSource: { pattern: "(" } }] },
      `"workloads[0].timeSource.pattern" is not a valid regex`,
    ],
    [
      "a bad timeSource unit",
      {
        workloads: [
          { command: ["a"], timeSource: { pattern: "x", unit: "min" } },
        ],
      },
      `"workloads[0].timeSource"`,
    ],
    [
      "a bad onMissingBaseline",
      { onMissingBaseline: "ignore" },
      `"onMissingBaseline" must be "warn" or "fail"`,
    ],
    [
      "a string noiseCheck",
      { noiseCheck: "no" },
      `"noiseCheck" must be a boolean`,
    ],
    [
      "a non-object thresholds",
      { thresholds: 5 },
      `"thresholds" must be an object`,
    ],
    [
      "a negative threshold",
      { thresholds: { timingPct: -1 } },
      `"thresholds.timingPct"`,
    ],
    ["a non-object bench", { bench: [] }, `"bench" must be an object`],
    [
      "a NaN-ish bench.jobs",
      { bench: { jobs: "many" } },
      `"bench.jobs" must be a positive integer or "auto", got "many"`,
    ],
    ["a zero bench.jobs", { bench: { jobs: 0 } }, `"bench.jobs"`],
    [
      "a string bench.suites",
      { bench: { suites: "bench/*.ts" } },
      `"bench.suites" must be an array of strings`,
    ],
    [
      "a non-boolean bench.isolate",
      { bench: { isolate: 1 } },
      `"bench.isolate" must be a boolean`,
    ],
  ]
  for (const [name, config, message] of rejects) {
    test(`rejects ${name}, naming the key`, async () => {
      const err = await loadJson(config).catch((e) => e)
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as Error).message).toContain(message)
    })
  }

  test("accepts every documented shape", async () => {
    const config = await loadJson({
      $schema: "https://example.com/ostia.json",
      samples: 5,
      budgetMs: 1000,
      minSamples: 3,
      warmup: 0,
      outDir: "out",
      baselineDir: "base",
      baseline: "main",
      noiseCheck: false,
      onMissingBaseline: "warn",
      thresholds: { timingPct: 3, alpha: 0.05, bootstrapIterations: 100 },
      workloads: [
        {
          label: "c",
          command: ["bun", "x.ts"],
          inputs: [],
          prepare: "rm -rf dist",
          timeSource: { pattern: "in (\\d+)ms", group: 1, unit: "ms" },
          timeoutMs: 1000,
          ignoreExitCodes: [1],
        },
        { suites: ["bench/*.ts"], timeoutMs: 5000 },
      ],
      bench: {
        jobs: "auto",
        budgetMs: 100,
        isolate: true,
        preload: [],
        bunFlags: ["--smol"],
      },
    })
    expect(config!.workloads).toHaveLength(2)
  })

  test("unknown keys warn (naming the key) and are ignored rather than failing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const config = await loadJson({
        baselineDirr: "x",
        thresholds: { timingPercent: 1 },
        bench: { job: 2 },
        workloads: [{ suites: ["a"], inputs: ["b"] }],
      })
      expect(config!.baseline).toBe("main")
      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(
        messages.some((m) => m.includes(`unknown key "baselineDirr"`)),
      ).toBe(true)
      expect(
        messages.some((m) =>
          m.includes(`unknown key "thresholds.timingPercent"`),
        ),
      ).toBe(true)
      expect(messages.some((m) => m.includes(`unknown key "bench.job"`))).toBe(
        true,
      )
      expect(
        messages.some((m) =>
          m.includes(`"workloads[0].inputs" applies to command workloads only`),
        ),
      ).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("baselinePath", () => {
  test("returns correct path using config baseline when name is undefined", () => {
    const config = {
      ...DEFAULT_CONFIG,
      baselineDir: ".ostia/baselines",
      baseline: "main",
    }

    const result = baselinePath(config, undefined)

    expect(result).toBe(".ostia/baselines/main.json")
  })

  test("returns correct path using explicit name argument when provided", () => {
    const config = {
      ...DEFAULT_CONFIG,
      baselineDir: ".ostia/baselines",
      baseline: "main",
    }

    const result = baselinePath(config, "pr-123")

    expect(result).toBe(".ostia/baselines/pr-123.json")
  })

  test("uses explicit name argument even when config.baseline is different", () => {
    const config = {
      ...DEFAULT_CONFIG,
      baselineDir: ".ostia/baselines",
      baseline: "main",
    }

    const result = baselinePath(config, "feature-branch")

    expect(result).toBe(".ostia/baselines/feature-branch.json")
  })

  test("stays independent of outDir so baselines survive node_modules churn", () => {
    const config = {
      ...DEFAULT_CONFIG,
      outDir: "node_modules/.cache/ostia",
      baselineDir: ".ostia/baselines",
      baseline: "main",
    }

    expect(baselinePath(config)).toBe(".ostia/baselines/main.json")
  })
})
