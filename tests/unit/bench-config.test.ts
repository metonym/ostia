import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BenchCliOverrides,
  expandSuiteGlobs,
  resolveBenchOptions,
} from "../../src/bench/index.ts"
import type { BenchConfig } from "../../src/config/index.ts"

function cli(overrides: Partial<BenchCliOverrides> = {}): BenchCliOverrides {
  return {
    suites: [],
    gc: false,
    isolate: false,
    preload: [],
    ...overrides,
  }
}

describe("expandSuiteGlobs", () => {
  test("expands a glob against cwd, deduped and sorted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-glob-test-"))
    try {
      await Bun.write(join(dir, "bench/b.bench.ts"), "export {}\n")
      await Bun.write(join(dir, "bench/a.bench.ts"), "export {}\n")
      await Bun.write(join(dir, "bench/nested/c.bench.ts"), "export {}\n")
      await Bun.write(join(dir, "bench/skip.ts"), "export {}\n")

      const result = await expandSuiteGlobs(["bench/**/*.bench.ts"], dir)

      expect(result).toEqual([
        "bench/a.bench.ts",
        "bench/b.bench.ts",
        "bench/nested/c.bench.ts",
      ])
    } finally {
      await Bun.$`rm -rf ${dir}`
    }
  })

  test("merges multiple patterns without duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-glob-multi-test-"))
    try {
      await Bun.write(join(dir, "a.bench.ts"), "export {}\n")
      await Bun.write(join(dir, "b.bench.ts"), "export {}\n")

      const result = await expandSuiteGlobs(["*.bench.ts", "a.bench.ts"], dir)

      expect(result).toEqual(["a.bench.ts", "b.bench.ts"])
    } finally {
      await Bun.$`rm -rf ${dir}`
    }
  })
})

describe("resolveBenchOptions", () => {
  test("falls back to config's bench.suites, expanded, when no CLI suites given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-resolve-test-"))
    try {
      await Bun.write(join(dir, "bench/a.bench.ts"), "export {}\n")
      const config: BenchConfig = { suites: ["bench/*.bench.ts"] }

      const resolved = await resolveBenchOptions(cli(), config, dir)

      expect(resolved.suites).toEqual(["bench/a.bench.ts"])
    } finally {
      await Bun.$`rm -rf ${dir}`
    }
  })

  test("CLI suites replace rather than merge with config suites", async () => {
    const config: BenchConfig = { suites: ["bench/*.bench.ts"] }
    const resolved = await resolveBenchOptions(
      cli({ suites: ["explicit.ts"] }),
      config,
      "/tmp",
    )
    expect(resolved.suites).toEqual(["explicit.ts"])
  })

  test("no config and no CLI suites resolves to an empty list", async () => {
    const resolved = await resolveBenchOptions(cli(), undefined, "/tmp")
    expect(resolved.suites).toEqual([])
  })

  test("CLI scalar flags override config, config overrides built-in undefined default", async () => {
    const config: BenchConfig = {
      timeBudgetMs: 1000,
      minSamples: 20,
      jobs: "auto",
      filter: "parse",
      outDir: ".config-out",
    }
    const resolved = await resolveBenchOptions(
      cli({ timeBudgetMs: 5000 }),
      config,
      "/tmp",
    )
    expect(resolved.timeBudgetMs).toBe(5000)
    expect(resolved.minSamples).toBe(20)
    expect(resolved.filter).toBe("parse")
    expect(resolved.outDir).toBe(".config-out")

    const unset = await resolveBenchOptions(cli(), undefined, "/tmp")
    expect(unset.timeBudgetMs).toBeUndefined()
    expect(unset.minSamples).toBeUndefined()
    expect(unset.outDir).toBeUndefined()
  })

  test(`config jobs: "auto" resolves to the machine's available job count`, async () => {
    const resolved = await resolveBenchOptions(cli(), { jobs: "auto" }, "/tmp")
    expect(resolved.jobs).toBeGreaterThanOrEqual(1)
  })

  test("config jobs: number passes through untouched", async () => {
    const resolved = await resolveBenchOptions(cli(), { jobs: 4 }, "/tmp")
    expect(resolved.jobs).toBe(4)
  })

  test("CLI --jobs overrides config jobs", async () => {
    const resolved = await resolveBenchOptions(
      cli({ jobs: 2 }),
      { jobs: 8 },
      "/tmp",
    )
    expect(resolved.jobs).toBe(2)
  })

  test("gc/isolate: CLI flag true wins even when config says false", async () => {
    const resolved = await resolveBenchOptions(
      cli({ gc: true, isolate: true }),
      { gc: false, isolate: false },
      "/tmp",
    )
    expect(resolved.gc).toBe(true)
    expect(resolved.isolate).toBe(true)
  })

  test("gc/isolate: config value used when CLI flag absent", async () => {
    const resolved = await resolveBenchOptions(
      cli(),
      { gc: true, isolate: true },
      "/tmp",
    )
    expect(resolved.gc).toBe(true)
    expect(resolved.isolate).toBe(true)
  })

  test("preload: CLI list replaces config list entirely", async () => {
    const resolved = await resolveBenchOptions(
      cli({ preload: ["./cli-preload.ts"] }),
      { preload: ["./config-preload.ts"] },
      "/tmp",
    )
    expect(resolved.preload).toEqual(["./cli-preload.ts"])
  })

  test("preload: falls back to config list when CLI gives none", async () => {
    const resolved = await resolveBenchOptions(
      cli(),
      { preload: ["./config-preload.ts"] },
      "/tmp",
    )
    expect(resolved.preload).toEqual(["./config-preload.ts"])
  })
})
