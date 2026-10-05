import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDocument,
  loadDocument,
  makeEntryWorkload,
  makeSubprocessWorkload,
  OstiaDocumentError,
  saveDocument,
} from "../../src/ir/document.ts"
import type { ProfileDocument } from "../../src/ir/types.ts"

const FIXTURE_PATH = `${import.meta.dir}/../../.ostia-test-load-fixture.json`

describe("loadDocument - schema handling", () => {
  test("rejects a schemaVersion 1 document as unsupported", async () => {
    await Bun.write(
      FIXTURE_PATH,
      JSON.stringify({ schemaVersion: 1, workloads: [], runs: [] }),
    )
    try {
      const err = await loadDocument(FIXTURE_PATH).catch((e) => e)
      expect(err).toBeInstanceOf(OstiaDocumentError)
      expect(err.code).toBe("unsupported-schema")
    } finally {
      await Bun.spawn(["rm", "-f", FIXTURE_PATH]).exited
    }
  })

  test("backfills p25/p75/p99/mad on a document saved before they existed", async () => {
    const samples = [10, 20, 30, 40, 50]
    const old = {
      schemaVersion: 2,
      toolVersion: "0.2.0",
      bunVersion: "1.4.0",
      platform: { os: "darwin", arch: "arm64" },
      createdAt: "2026-01-01T00:00:00.000Z",
      workloads: [{ id: "wl_a", kind: "subprocess", command: ["x"] }],
      measurements: [
        {
          id: "run_a",
          workloadId: "wl_a",
          phase: "timing",
          instrumented: false,
          configFingerprint: "cfg",
          trials: [],
          timing: {
            unit: "ns",
            samples,
            mean: 30,
            median: 30,
            stddev: 14,
            min: 10,
            max: 50,
            outliers: { mild: 0, severe: 0 },
          },
          warnings: [],
          artifacts: [],
        },
      ],
    }
    await Bun.write(FIXTURE_PATH, JSON.stringify(old))
    try {
      const t = (await loadDocument(FIXTURE_PATH)).measurements[0]!.timing!
      expect(t.p25).toBe(20)
      expect(t.p75).toBe(40)
      expect(t.mad).toBe(10)
      expect(t.p99).toBeGreaterThan(49)
    } finally {
      await Bun.spawn(["rm", "-f", FIXTURE_PATH]).exited
    }
  })

  test("reads the old p25/p75 ratio quartiles of a saved ab document as ratioP25/ratioP75", async () => {
    const paired = {
      rounds: 15,
      batch: 1,
      baseSamples: [],
      baseMedianNs: 1,
      ratios: [],
      medianRatio: 1.2,
      p25: 1.1,
      p75: 1.3,
      flagged: "regressed",
      repeats: [{ medianRatio: 1.2, p25: 1.15, p75: 1.25 }],
      verdict: "unchanged",
      sameOutput: true,
    }
    const old = {
      schemaVersion: 2,
      toolVersion: "0.2.9",
      bunVersion: "1.4.0",
      platform: { os: "darwin", arch: "arm64" },
      createdAt: "2026-01-01T00:00:00.000Z",
      workloads: [],
      measurements: [
        {
          id: "run_a",
          workloadId: "wl_a",
          phase: "paired",
          instrumented: false,
          configFingerprint: "cfg",
          trials: [],
          paired,
          warnings: [],
          artifacts: [],
        },
      ],
    }
    await Bun.write(FIXTURE_PATH, JSON.stringify(old))
    try {
      const p = (await loadDocument(FIXTURE_PATH)).measurements[0]!.paired!
      expect(p.ratioP25).toBe(1.1)
      expect(p.ratioP75).toBe(1.3)
      expect(p.repeats![0]!.ratioP25).toBe(1.15)
      expect(p.repeats![0]!.ratioP75).toBe(1.25)
      expect("p25" in p).toBe(false)
    } finally {
      await Bun.spawn(["rm", "-f", FIXTURE_PATH]).exited
    }
  })

  test("passes a v2 document through unchanged", async () => {
    const path = `${import.meta.dir}/../../.ostia-test-v2-fixture.json`
    const v2: ProfileDocument = {
      schemaVersion: 2,
      toolVersion: "0.1.0",
      bunVersion: "1.4.0",
      platform: { os: "darwin", arch: "arm64" },
      createdAt: "2026-01-01T00:00:00.000Z",
      workloads: [],
      measurements: [],
    }
    await Bun.write(path, JSON.stringify(v2))
    try {
      const doc = await loadDocument(path)
      expect(doc).toEqual(v2)
    } finally {
      await Bun.spawn(["rm", "-f", path]).exited
    }
  })
})

describe("makeEntryWorkload - checkout-independent ids", () => {
  test("an absolute suite path hashes the same as its cwd-relative form", () => {
    const relative = makeEntryWorkload("bench/parse.ts", "parse/small")
    const absolute = makeEntryWorkload(
      `${process.cwd()}/bench/parse.ts`,
      "parse/small",
    )
    expect(absolute.id).toBe(relative.id)
    // The entry keeps the path as given; only the id is normalized.
    expect(absolute.entry!.file).toBe(`${process.cwd()}/bench/parse.ts`)
  })
})

describe("makeEntryWorkload - params fold into the workload id (item 8)", () => {
  test("no params: id matches the pre-existing (params-less) hash exactly", () => {
    const withoutOpts = makeEntryWorkload("suite.ts", "parse/small")
    const withEmptyOpts = makeEntryWorkload("suite.ts", "parse/small", {})
    expect(withoutOpts.id).toBe(withEmptyOpts.id)
    expect(withoutOpts.params).toBeUndefined()
  })

  test("two points sharing a task name but different params get distinct ids", () => {
    const a = makeEntryWorkload("suite.ts", "current", {
      params: { size: 100 },
    })
    const b = makeEntryWorkload("suite.ts", "current", {
      params: { size: 200 },
    })
    expect(a.id).not.toBe(b.id)
    expect(a.params).toEqual({ size: 100 })
    expect(b.params).toEqual({ size: 200 })
  })

  test("the same task name and params reproduce the same id", () => {
    const a = makeEntryWorkload("suite.ts", "current", {
      params: { size: 100 },
    })
    const b = makeEntryWorkload("suite.ts", "current", {
      params: { size: 100 },
    })
    expect(a.id).toBe(b.id)
  })

  test("adding params to a previously params-less task changes its id (expected: it's a different point now)", () => {
    const before = makeEntryWorkload("suite.ts", "t")
    const after = makeEntryWorkload("suite.ts", "t", { params: { size: 100 } })
    expect(before.id).not.toBe(after.id)
  })
})

describe("makeSubprocessWorkload - id excludes cwd (task 04.1)", () => {
  test("the same command from two different cwds yields the same id", () => {
    const original = process.cwd()
    try {
      const a = makeSubprocessWorkload(["bun", "build.ts"])
      process.chdir("/tmp")
      const b = makeSubprocessWorkload(["bun", "build.ts"])
      expect(a.id).toBe(b.id)
    } finally {
      process.chdir(original)
    }
  })

  test("a label change does not change the id", () => {
    const a = makeSubprocessWorkload(["bun", "build.ts"], "label-a")
    const b = makeSubprocessWorkload(["bun", "build.ts"], "label-b")
    expect(a.id).toBe(b.id)
  })

  test("a timeSource.unit change does change the id", () => {
    const ms = makeSubprocessWorkload(["bun", "build.ts"], undefined, {
      timeSource: { pattern: /in (\d+)(m|u)s/, unit: "ms" },
    })
    const us = makeSubprocessWorkload(["bun", "build.ts"], undefined, {
      timeSource: { pattern: /in (\d+)(m|u)s/, unit: "us" },
    })
    expect(ms.id).not.toBe(us.id)
  })
})

describe("createDocument - git metadata (item 17)", () => {
  test("attaches sha/branch/dirty when run inside a git repo, additive alongside environment", () => {
    const doc = createDocument([], [])
    expect(doc.git).toBeDefined()
    expect(typeof doc.git!.sha).toBe("string")
    expect(doc.git!.sha.length).toBeGreaterThan(0)
    expect(typeof doc.git!.branch).toBe("string")
    expect(typeof doc.git!.dirty).toBe("boolean")
  })
})

describe("loadDocument - OstiaDocumentError for corrupt/unsupported documents", () => {
  const path = `${import.meta.dir}/../../.ostia-test-corrupt-fixture.json`

  async function withFixture(
    content: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    await Bun.write(path, content)
    try {
      await fn()
    } finally {
      await Bun.spawn(["rm", "-f", path]).exited
    }
  }

  test("invalid JSON throws OstiaDocumentError with code 'invalid-json'", async () => {
    await withFixture("not json {", async () => {
      const err = await loadDocument(path).catch((e) => e)
      expect(err).toBeInstanceOf(OstiaDocumentError)
      expect((err as OstiaDocumentError).code).toBe("invalid-json")
    })
  })

  test("valid JSON that isn't a document throws OstiaDocumentError with code 'not-a-document'", async () => {
    await withFixture("{}", async () => {
      const err = await loadDocument(path).catch((e) => e)
      expect(err).toBeInstanceOf(OstiaDocumentError)
      expect((err as OstiaDocumentError).code).toBe("not-a-document")
    })
  })

  test("an unsupported schemaVersion throws OstiaDocumentError with code 'unsupported-schema'", async () => {
    await withFixture(JSON.stringify({ schemaVersion: 3 }), async () => {
      const err = await loadDocument(path).catch((e) => e)
      expect(err).toBeInstanceOf(OstiaDocumentError)
      expect((err as OstiaDocumentError).code).toBe("unsupported-schema")
      expect((err as OstiaDocumentError).schemaVersion).toBe(3)
      expect((err as Error).message).toContain(
        "unsupported ProfileDocument schemaVersion 3",
      )
    })
  })
})

describe("loadDocument - structural validation", () => {
  const path = `${import.meta.dir}/../../.ostia-test-shape-fixture.json`
  const base = { schemaVersion: 2, workloads: [], measurements: [] }
  const measurement = {
    id: "run_a",
    workloadId: "wl_a",
    phase: "timing",
    trials: [],
    warnings: [],
    artifacts: [],
  }

  async function loadError(doc: unknown): Promise<OstiaDocumentError> {
    await Bun.write(path, JSON.stringify(doc))
    try {
      const err = await loadDocument(path).catch((e) => e)
      expect(err).toBeInstanceOf(OstiaDocumentError)
      return err as OstiaDocumentError
    } finally {
      await Bun.spawn(["rm", "-f", path]).exited
    }
  }

  test("a schemaVersion-2 document without workloads/measurements arrays is not-a-document", async () => {
    const err = await loadError({ schemaVersion: 2 })
    expect(err.code).toBe("not-a-document")
    expect(err.message).toContain(`"workloads" must be an array`)
    expect((await loadError({ ...base, measurements: {} })).message).toContain(
      `"measurements" must be an array`,
    )
  })

  test("names the offending workload and measurement by index", async () => {
    expect(
      (await loadError({ ...base, workloads: [{ id: "wl_a" }, { id: 7 }] }))
        .message,
    ).toContain("workloads[1]")
    expect(
      (await loadError({ ...base, measurements: [{ ...measurement, id: 1 }] }))
        .message,
    ).toContain("measurements[0]")
    expect(
      (
        await loadError({
          ...base,
          measurements: [{ ...measurement, warnings: undefined }],
        })
      ).message,
    ).toContain("measurements[0].warnings must be an array")
  })

  test("accepts a well-formed document", async () => {
    await Bun.write(
      path,
      JSON.stringify({
        ...base,
        workloads: [{ id: "wl_a", kind: "subprocess" }],
        measurements: [measurement],
      }),
    )
    try {
      expect((await loadDocument(path)).measurements).toHaveLength(1)
    } finally {
      await Bun.spawn(["rm", "-f", path]).exited
    }
  })
})

describe("saveDocument - atomic write", () => {
  const path = `${import.meta.dir}/../../.ostia-test-atomic-fixture.json`

  test("leaves no target file when serialization throws", async () => {
    await Bun.spawn(["rm", "-f", path]).exited
    try {
      const doc = { ...createDocument([], []), bogus: 1n } as ProfileDocument
      await expect(saveDocument(doc, path)).rejects.toThrow()
      expect(await Bun.file(path).exists()).toBe(false)
    } finally {
      await Bun.spawn(["rm", "-f", path]).exited
    }
  })

  test("concurrent saves of one path all succeed and leave no temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "save-concurrent-"))
    const target = join(dir, "doc.json")
    try {
      const doc = createDocument([], [])
      await Promise.all(
        Array.from({ length: 20 }, () => saveDocument(doc, target)),
      )
      expect((await loadDocument(target)).toolVersion).toBe(doc.toolVersion)
      expect(await readdir(dir)).toEqual(["doc.json"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a failed rename removes its temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "save-fail-"))
    try {
      // The target is a non-empty directory, so rename can't replace it.
      await Bun.write(join(dir, "doc.json", "keep"), "x")
      await expect(
        saveDocument(createDocument([], []), join(dir, "doc.json")),
      ).rejects.toThrow()
      expect(await readdir(dir)).toEqual(["doc.json"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("writes the target file on success", async () => {
    try {
      const doc = createDocument([], [])
      await saveDocument(doc, path)
      expect(await Bun.file(path).exists()).toBe(true)
      const loaded = await loadDocument(path)
      expect(loaded.toolVersion).toBe(doc.toolVersion)
    } finally {
      await Bun.spawn(["rm", "-f", path]).exited
    }
  })
})
