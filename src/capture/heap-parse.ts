import type { HeapEvidence } from "../ir/types.ts";

export interface RawHeapSnapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: (string[] | string)[];
    };
    node_count: number;
  };
  nodes: number[];
  strings: string[];
}

// Checks only the arrays `parseHeapSnapshot` walks and the count it
// reports.
export function isRawHeapSnapshot(value: unknown): value is RawHeapSnapshot {
  if (typeof value !== "object" || value === null) return false;
  if (!("nodes" in value) || !Array.isArray(value.nodes)) return false;
  if (!("snapshot" in value)) return false;
  const { snapshot } = value;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  if (!("node_count" in snapshot) || typeof snapshot.node_count !== "number") {
    return false;
  }
  if (!("meta" in snapshot)) return false;
  const { meta } = snapshot;
  return (
    typeof meta === "object" &&
    meta !== null &&
    "node_fields" in meta &&
    Array.isArray(meta.node_fields) &&
    "node_types" in meta &&
    Array.isArray(meta.node_types)
  );
}

const TOP_N = 20;

interface TypeBucket {
  type: string;
  count: number;
  bytes: number;
}

export function parseHeapSnapshot(raw: RawHeapSnapshot): HeapEvidence {
  const origin = "heap-prof";
  const { node_fields, node_types } = raw.snapshot.meta;
  const typeIx = node_fields.indexOf("type");
  const selfSizeIx = node_fields.indexOf("self_size");
  const fieldCount = node_fields.length;
  const typeNames = node_types[0];
  if (typeIx === -1 || selfSizeIx === -1 || !Array.isArray(typeNames)) {
    return { origin, typeCounts: [], objectCount: raw.snapshot.node_count };
  }

  const typeCount = typeNames.length;
  const buckets = new Array<TypeBucket | undefined>(typeCount);
  // Keyed by `number | undefined` because a truncated `nodes` reads
  // `undefined` for its last type.
  const unknownBuckets = new Map<number | undefined, TypeBucket>();
  const seen: TypeBucket[] = [];
  const newBucket = (type: string): TypeBucket => {
    const bucket = { type, count: 0, bytes: 0 };
    seen.push(bucket);
    return bucket;
  };
  let heapSizeBytes = 0;

  const nodes = raw.nodes;
  const len = nodes.length;
  for (let offset = 0; offset < len; offset += fieldCount) {
    const typeIdx = nodes[offset + typeIx];
    const selfSize = nodes[offset + selfSizeIx] ?? 0;
    heapSizeBytes += selfSize;
    let bucket: TypeBucket | undefined;
    if (typeIdx !== undefined && typeIdx >= 0 && typeIdx < typeCount) {
      bucket = buckets[typeIdx] ??= newBucket(typeNames[typeIdx] ?? "");
    } else {
      bucket = unknownBuckets.get(typeIdx);
      if (bucket === undefined) {
        bucket = newBucket(`unknown(${typeIdx})`);
        unknownBuckets.set(typeIdx, bucket);
      }
    }
    bucket.count++;
    bucket.bytes += selfSize;
  }

  seen.sort((a, b) => b.count - a.count);
  const typeCounts = seen.slice(0, TOP_N).map(({ type, count, bytes }) => ({
    type,
    count,
    retainedBytes: bytes,
  }));
  const rest = seen.slice(TOP_N);
  if (rest.length > 0) {
    typeCounts.push({
      type: "other",
      count: rest.reduce((n, b) => n + b.count, 0),
      retainedBytes: rest.reduce((n, b) => n + b.bytes, 0),
    });
  }

  return {
    origin,
    heapSizeBytes,
    objectCount: raw.snapshot.node_count,
    typeCounts,
  };
}
