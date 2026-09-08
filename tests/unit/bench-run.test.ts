import { beforeEach, describe, expect, test } from "bun:test"
import { resetRegistry } from "../../src/bench/registry.ts"
import { group, run, task } from "../../src/index.ts"

describe("run() - in-file entrypoint, no subprocess/CLI", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("executes every registered task in this process and returns a document", async () => {
    task("solo", () => 1)
    group("g", () => {
      task("a", () => 1)
      task("b", () => 2)
    })

    const doc = await run({
      quiet: true,
      budgetMs: 20,
      minSamples: 3,
      noiseCheck: false,
    })

    expect(doc.workloads).toHaveLength(3)
    expect(doc.measurements).toHaveLength(3)
    const labels = doc.workloads.map((w) => w.label).sort()
    expect(labels).toEqual(["g/a", "g/b", "solo"])
    for (const workload of doc.workloads) {
      expect(workload.kind).toBe("inprocess")
      expect(workload.entry?.file).toBe(Bun.main)
    }
  })

  test("filter narrows to matching group/name ids, same regex semantics as bench()", async () => {
    group("g", () => {
      task("a", () => 1)
      task("b", () => 2)
    })
    task("solo", () => 3)

    const doc = await run({
      quiet: true,
      filter: "g/",
      budgetMs: 20,
      minSamples: 3,
      noiseCheck: false,
    })

    expect(doc.workloads.map((w) => w.label).sort()).toEqual(["g/a", "g/b"])
  })

  test("throws instead of silently returning nothing when no tasks were registered", async () => {
    await expect(run()).rejects.toThrow(/no tasks registered/)
  })

  test("throws when filter matches zero registered tasks", async () => {
    task("solo", () => 1)
    await expect(run({ filter: "nonexistent-xyz" })).rejects.toThrow(
      /matched zero/,
    )
  })

  test("quiet suppresses the printed report but still returns the document", async () => {
    task("solo", () => 1)
    const original = process.stdout.write.bind(process.stdout)
    let wrote = false
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      wrote = true
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real writer
      return (original as any)(chunk, ...rest)
    }) as typeof process.stdout.write
    try {
      const doc = await run({
        quiet: true,
        budgetMs: 20,
        minSamples: 3,
        noiseCheck: false,
      })
      expect(doc.workloads).toHaveLength(1)
    } finally {
      process.stdout.write = original
    }
    expect(wrote).toBe(false)
  })

  test("without quiet, prints a table report to stdout", async () => {
    task("solo", () => 1)
    const original = process.stdout.write.bind(process.stdout)
    let printed = ""
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      printed += String(chunk)
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real writer
      return (original as any)(chunk, ...rest)
    }) as typeof process.stdout.write
    try {
      await run({ budgetMs: 20, minSamples: 3, noiseCheck: false })
    } finally {
      process.stdout.write = original
    }
    expect(printed).toContain("solo")
  })
})
