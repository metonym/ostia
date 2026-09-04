import type { HeapEvidence } from "../../ir/types.ts"

export interface RawHeapSnapshot {
  snapshot: {
    meta: {
      node_fields: string[]
      node_types: (string[] | string)[]
    }
    node_count: number
  }
  nodes: number[]
  strings: string[]
}

const TOP_N = 20

interface TypeBucket {
  type: string
  count: number
  bytes: number
}

export function parseHeapSnapshot(
  raw: RawHeapSnapshot,
  origin: HeapEvidence["origin"] = "heap-prof",
): HeapEvidence {
  const { node_fields, node_types } = raw.snapshot.meta
  const typeIx = node_fields.indexOf("type")
  const selfSizeIx = node_fields.indexOf("self_size")
  const fieldCount = node_fields.length
  const typeNames = node_types[0]
  if (typeIx === -1 || selfSizeIx === -1 || !Array.isArray(typeNames)) {
    return { origin, typeCounts: [], objectCount: raw.snapshot.node_count }
  }

  const typeCount = typeNames.length
  const buckets: (TypeBucket | undefined)[] = new Array(typeCount)
  const unknownBuckets = new Map<string, TypeBucket>()
  const seen: TypeBucket[] = []
  let heapSizeBytes = 0

  const nodes = raw.nodes
  const len = nodes.length
  for (let offset = 0; offset < len; offset += fieldCount) {
    const typeIdx = nodes[offset + typeIx]!
    const selfSize = nodes[offset + selfSizeIx] ?? 0
    heapSizeBytes += selfSize
    let bucket: TypeBucket | undefined
    if (typeIdx >= 0 && typeIdx < typeCount) {
      bucket = buckets[typeIdx]
      if (bucket === undefined) {
        bucket = { type: typeNames[typeIdx]!, count: 0, bytes: 0 }
        buckets[typeIdx] = bucket
        seen.push(bucket)
      }
    } else {
      const typeName = `unknown(${typeIdx})`
      bucket = unknownBuckets.get(typeName)
      if (bucket === undefined) {
        bucket = { type: typeName, count: 0, bytes: 0 }
        unknownBuckets.set(typeName, bucket)
        seen.push(bucket)
      }
    }
    bucket.count++
    bucket.bytes += selfSize
  }

  const sorted = seen.sort((a, b) => b.count - a.count)
  const top = sorted.slice(0, TOP_N)
  const rest = sorted.slice(TOP_N)

  const typeCounts = top.map(({ type, count, bytes }) => ({
    type,
    count,
    retainedBytes: bytes,
  }))
  if (rest.length > 0) {
    let otherCount = 0
    let otherBytes = 0
    for (const b of rest) {
      otherCount += b.count
      otherBytes += b.bytes
    }
    typeCounts.push({
      type: "other",
      count: otherCount,
      retainedBytes: otherBytes,
    })
  }

  return {
    origin,
    heapSizeBytes,
    objectCount: raw.snapshot.node_count,
    typeCounts,
  }
}
