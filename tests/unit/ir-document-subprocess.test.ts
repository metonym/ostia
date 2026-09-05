import { describe, expect, test } from "bun:test"
import { makeSubprocessWorkload } from "../../src/ir/document.ts"

const CMD = ["bun", "build.ts"]

describe("makeSubprocessWorkload - prepare / timeSource", () => {
  test("a command without prepare/timeSource keeps its pre-existing id (empty opts is a no-op)", () => {
    expect(makeSubprocessWorkload(CMD).id).toBe(
      makeSubprocessWorkload(CMD, undefined, {}).id,
    )
    expect(makeSubprocessWorkload(CMD)).not.toHaveProperty("prepare")
    expect(makeSubprocessWorkload(CMD)).not.toHaveProperty("timeSource")
  })

  test("prepare and timeSource each change the id, so same-command workloads don't collide", () => {
    const plain = makeSubprocessWorkload(CMD).id
    const cold = makeSubprocessWorkload(CMD, "cold", {
      prepare: "rm -rf dist",
    }).id
    const reported = makeSubprocessWorkload(CMD, "reported", {
      timeSource: { pattern: /in (\d+)ms/ },
    }).id
    const both = makeSubprocessWorkload(CMD, "both", {
      prepare: "rm -rf dist",
      timeSource: { pattern: /in (\d+)ms/ },
    }).id
    expect(new Set([plain, cold, reported, both]).size).toBe(4)
  })

  test("string and argv prepare forms that split the same way share an id and serialize as argv", () => {
    const a = makeSubprocessWorkload(CMD, undefined, { prepare: "rm -rf dist" })
    const b = makeSubprocessWorkload(CMD, undefined, {
      prepare: ["rm", "-rf", "dist"],
    })
    expect(a.id).toBe(b.id)
    expect(a.prepare).toEqual(["rm", "-rf", "dist"])
  })

  test("a function prepare hashes by source text and is not serialized onto the workload", () => {
    const a = makeSubprocessWorkload(CMD, undefined, {
      prepare: () => Bun.write("state.txt", "1"),
    })
    const b = makeSubprocessWorkload(CMD, undefined, {
      prepare: () => Bun.write("state.txt", "1"),
    })
    const c = makeSubprocessWorkload(CMD, undefined, {
      prepare: () => Bun.write("state.txt", "2"),
    })
    expect(a.id).toBe(b.id)
    expect(a.id).not.toBe(c.id)
    expect(a).not.toHaveProperty("prepare")
  })

  test("timeSource serializes a RegExp pattern to its source, keeping group/unit", () => {
    const w = makeSubprocessWorkload(CMD, undefined, {
      timeSource: { pattern: /in (\d+)ms/, group: 1, unit: "ms" },
    })
    expect(w.timeSource).toEqual({
      pattern: "in (\\d+)ms",
      group: 1,
      unit: "ms",
    })
    expect(JSON.parse(JSON.stringify(w)).timeSource).toEqual(w.timeSource)
  })
})
