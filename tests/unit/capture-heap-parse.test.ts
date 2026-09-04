import { describe, expect, test } from "bun:test"
import {
  parseHeapSnapshot,
  type RawHeapSnapshot,
} from "../../src/capture/heap/parse.ts"

const fixtureUrl = new URL(
  "../fixtures/capture/sample.heapsnapshot.json",
  import.meta.url,
)
const rawFixture = (await Bun.file(fixtureUrl).json()) as RawHeapSnapshot

describe("parseHeapSnapshot", () => {
  test("parses real fixture with correct metadata and aggregates correctly", () => {
    const result = parseHeapSnapshot(rawFixture)

    expect(result.origin).toBe("heap-prof")
    expect(result.objectCount!).toBe(rawFixture.snapshot.node_count)
    expect(result.objectCount!).toBe(200)

    expect(result.typeCounts.length).toBeGreaterThan(0)

    for (const tc of result.typeCounts) {
      expect(typeof tc.type).toBe("string")
      expect(typeof tc.count).toBe("number")
      expect(tc.count).toBeGreaterThan(0)
      expect(typeof tc.retainedBytes).toBe("number")
      expect(tc.retainedBytes).toBeGreaterThanOrEqual(0)
    }
  })

  test("sum of all typeCounts equals objectCount", () => {
    const result = parseHeapSnapshot(rawFixture)

    const totalCount = result.typeCounts.reduce((sum, tc) => sum + tc.count, 0)
    expect(totalCount).toBe(result.objectCount!)
  })

  test("'other' bucket, if present, is always last", () => {
    const result = parseHeapSnapshot(rawFixture)

    const otherIndex = result.typeCounts.findIndex((tc) => tc.type === "other")
    if (otherIndex !== -1) {
      expect(otherIndex).toBe(result.typeCounts.length - 1)
    }
  })

  test("heapSizeBytes equals sum of all self_size values in nodes", () => {
    const result = parseHeapSnapshot(rawFixture)

    const { node_fields } = rawFixture.snapshot.meta
    const selfSizeIx = node_fields.indexOf("self_size")
    const fieldCount = node_fields.length

    let expectedHeapSize = 0
    for (
      let offset = 0;
      offset < rawFixture.nodes.length;
      offset += fieldCount
    ) {
      const selfSize = rawFixture.nodes[offset + selfSizeIx] ?? 0
      expectedHeapSize += selfSize
    }

    expect(result.heapSizeBytes).toBe(expectedHeapSize)
  })

  test("contains common JS heap node types", () => {
    const result = parseHeapSnapshot(rawFixture)

    const commonTypes = [
      "code",
      "string",
      "closure",
      "object shape",
      "hidden",
      "object",
    ]
    const foundCommon = result.typeCounts.some((tc) =>
      commonTypes.includes(tc.type),
    )
    expect(foundCommon).toBe(true)
  })

  test("parses synthetic minimal case with multiple types", () => {
    const raw: RawHeapSnapshot = {
      snapshot: {
        meta: {
          node_fields: [
            "type",
            "name",
            "id",
            "self_size",
            "edge_count",
            "trace_node_id",
            "detachedness",
          ],
          node_types: [
            ["hidden", "string", "object"],
            "string",
            "number",
            "number",
            "number",
            "number",
            "number",
          ],
        },
        node_count: 3,
      },
      nodes: [1, 0, 1, 10, 0, 0, 0, 1, 0, 2, 20, 0, 0, 0, 2, 0, 3, 5, 0, 0, 0],
      strings: ["", "(test)"],
    }

    const result = parseHeapSnapshot(raw)

    expect(result.objectCount).toBe(3)
    expect(result.heapSizeBytes).toBe(35)

    const stringEntry = result.typeCounts.find((tc) => tc.type === "string")
    const objectEntry = result.typeCounts.find((tc) => tc.type === "object")

    expect(stringEntry).toBeDefined()
    expect(stringEntry!.count).toBe(2)
    expect(stringEntry!.retainedBytes).toBe(30)

    expect(objectEntry).toBeDefined()
    expect(objectEntry!.count).toBe(1)
    expect(objectEntry!.retainedBytes).toBe(5)
  })

  test("handles missing type or self_size fields gracefully", () => {
    const raw: RawHeapSnapshot = {
      snapshot: {
        meta: {
          node_fields: ["id", "name"],
          node_types: [["hidden", "array"], "string", "number"],
        },
        node_count: 5,
      },
      nodes: [1, 0, 2, 0, 3, 0, 4, 0, 5, 0],
      strings: ["", "(test)"],
    }

    const result = parseHeapSnapshot(raw)

    expect(result.origin).toBe("heap-prof")
    expect(result.objectCount).toBe(5)
    expect(result.typeCounts.length).toBe(0)
  })

  test("accepts custom origin parameter", () => {
    const result = parseHeapSnapshot(rawFixture, "generateHeapSnapshot")

    expect(result.origin).toBe("generateHeapSnapshot")
  })
})
