/** Key-order-independent JSON: equal values give equal text, which keeps `fp()`
 * ids and saved documents stable. */
export function canonicalJSON(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeysDeep(value), null, indent)
}

/** Deep copy with plain-object keys sorted. Arrays of only primitives (a
 * 10k-entry `samples`) are returned as is, keeping `JSON.stringify` on its
 * fast path. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    const hasObjects = value.some((v) => v !== null && typeof v === "object")
    return hasObjects ? value.map(sortKeysDeep) : value
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeysDeep(source[key])
    }
    return out
  }
  return value
}

export function fp(tag: string, ...parts: unknown[]): string {
  const hex = Bun.CryptoHasher.hash("sha256", canonicalJSON(parts), "hex")
  return `${tag}_${hex.slice(0, 16)}`
}
