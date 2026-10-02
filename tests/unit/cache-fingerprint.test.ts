import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeCacheKey,
  computeInputsDigest,
} from "../../src/cache/fingerprint.ts"

describe("computeInputsDigest", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cache-fingerprint-test-"))
  })

  afterAll(async () => {
    await Bun.$`rm -rf ${tmpDir}`
  })

  test("returns undefined for empty globs array", async () => {
    const result = await computeInputsDigest([])
    expect(result).toBeUndefined()
  })

  test("is deterministic: calling twice with same files returns identical digest", async () => {
    await Bun.write(join(tmpDir, "a.ts"), "export const a = 1")
    await Bun.write(join(tmpDir, "b.ts"), "export const b = 2")

    const result1 = await computeInputsDigest(["*.ts"], tmpDir)
    const result2 = await computeInputsDigest(["*.ts"], tmpDir)

    expect(result1).toBeDefined()
    expect(result2).toBeDefined()
    expect(result1).toBe(result2)
  })

  test("is order-independent: different glob patterns with same files produce identical digest", async () => {
    const testDir = await mkdtemp(
      join(tmpdir(), "cache-fingerprint-order-test-"),
    )
    try {
      await Bun.write(join(testDir, "x.ts"), "export const x = 100")
      await Bun.write(join(testDir, "y.ts"), "export const y = 200")

      const result1 = await computeInputsDigest(["*.ts"], testDir)
      const result2 = await computeInputsDigest(["y.ts", "x.ts"], testDir)

      expect(result1).toBeDefined()
      expect(result2).toBeDefined()
      expect(result1).toBe(result2)
    } finally {
      await Bun.$`rm -rf ${testDir}`
    }
  })

  test("is content-sensitive: changing file content changes the digest", async () => {
    const testDir = await mkdtemp(
      join(tmpdir(), "cache-fingerprint-content-test-"),
    )
    try {
      const filePath = join(testDir, "file.ts")
      await Bun.write(filePath, "export const value = 1")

      const digest1 = await computeInputsDigest(["*.ts"], testDir)

      await Bun.write(filePath, "export const value = 999")

      const digest2 = await computeInputsDigest(["*.ts"], testDir)

      expect(digest1).toBeDefined()
      expect(digest2).toBeDefined()
      expect(digest1).not.toBe(digest2)
    } finally {
      await Bun.$`rm -rf ${testDir}`
    }
  })

  test("accepts absolute paths as well as cwd-relative globs", async () => {
    const testDir = await mkdtemp(
      join(tmpdir(), "cache-fingerprint-absolute-test-"),
    )
    try {
      const filePath = join(testDir, "file.ts")
      await Bun.write(filePath, "export const value = 1")
      const digest = await computeInputsDigest([filePath], process.cwd())
      expect(digest).toBeDefined()
      await Bun.write(filePath, "export const value = 2")
      expect(await computeInputsDigest([filePath], process.cwd())).not.toBe(
        digest,
      )
    } finally {
      await Bun.$`rm -rf ${testDir}`
    }
  })
})

describe("computeInputsDigest - scope", () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cache-fingerprint-scope-test-"))
    await Bun.write(join(dir, "src/a.ts"), "a")
    await Bun.write(join(dir, ".github/workflows/ci.yml"), "ci: 1")
    await Bun.write(join(dir, "node_modules/dep/index.ts"), "dep: 1")
  })

  afterAll(async () => {
    await Bun.$`rm -rf ${dir}`
  })

  test("a dot-directory glob sees its files", async () => {
    const before = await computeInputsDigest([".github/**"], dir)
    await Bun.write(join(dir, ".github/workflows/ci.yml"), "ci: 2")
    expect(await computeInputsDigest([".github/**"], dir)).not.toBe(before)
  })

  test("a recursive glob ignores node_modules", async () => {
    const before = await computeInputsDigest(["**/*.ts"], dir)
    await Bun.write(join(dir, "node_modules/dep/index.ts"), "dep: 2")
    expect(await computeInputsDigest(["**/*.ts"], dir)).toBe(before)
  })

  test("hashes thousands of files without exhausting file descriptors", async () => {
    const many = await mkdtemp(join(tmpdir(), "cache-fingerprint-many-test-"))
    try {
      await Promise.all(
        Array.from({ length: 3000 }, (_, i) =>
          Bun.write(join(many, `f${i}.txt`), String(i)),
        ),
      )
      expect(await computeInputsDigest(["*.txt"], many)).toBeDefined()
    } finally {
      await Bun.$`rm -rf ${many}`
    }
  }, 30_000)
})

describe("computeCacheKey", () => {
  test("returns string matching format cache_XXXXXXXXXXXXXXXX", () => {
    const result = computeCacheKey({
      workloadId: "wl1",
      phase: "timing",
      configFingerprint: "cfg_abc123",
      bunVersion: "1.0.0",
      toolVersion: "1.0.0",
      instrumented: false,
    })

    expect(result).toMatch(/^cache_[0-9a-f]{16}$/)
  })

  test("is deterministic: same input objects produce identical keys", () => {
    const input = {
      workloadId: "wl-test",
      phase: "cpu" as const,
      configFingerprint: "cfg_xyz789",
      bunVersion: "1.0.5",
      toolVersion: "2.0.0",
      instrumented: true,
    }

    const key1 = computeCacheKey(input)
    const key2 = computeCacheKey({ ...input })

    expect(key1).toBe(key2)
  })

  test("changes when inputsDigest changes (with different inputsDigest values)", () => {
    const baseInput = {
      workloadId: "wl-digest",
      phase: "heap" as const,
      configFingerprint: "cfg_digest",
      bunVersion: "1.0.0",
      toolVersion: "1.0.0",
      instrumented: false,
    }

    const key1 = computeCacheKey({ ...baseInput, inputsDigest: "abc" })
    const key2 = computeCacheKey({ ...baseInput, inputsDigest: "xyz" })

    expect(key1).not.toBe(key2)
  })

  test("does not throw when inputsDigest is undefined and produces valid key", () => {
    const input = {
      workloadId: "wl-undef",
      phase: "memstats" as const,
      configFingerprint: "cfg_undef",
      bunVersion: "1.0.0",
      toolVersion: "1.0.0",
      instrumented: false,
      inputsDigest: undefined,
    }

    const key = computeCacheKey(input)

    expect(key).toMatch(/^cache_[0-9a-f]{16}$/)
  })

  test("changes when instrumented flips from false to true", () => {
    const baseInput = {
      workloadId: "wl-instr",
      phase: "cpu" as const,
      configFingerprint: "cfg_instr",
      bunVersion: "1.0.0",
      toolVersion: "1.0.0",
    }

    const key1 = computeCacheKey({ ...baseInput, instrumented: false })
    const key2 = computeCacheKey({ ...baseInput, instrumented: true })

    expect(key1).not.toBe(key2)
  })
})
