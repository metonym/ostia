/** Key-order-independent JSON: the same logical value always produces the
 * same text, which is what makes `fp()` ids and saved documents stable. */
export function canonicalJSON(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeysDeep(value), null, indent)
}

/** Deep copy with every plain object's keys in sorted order. Arrays whose
 * elements are all primitives (a 10k-entry `samples` array) are returned as
 * is: nothing in them has keys to sort, and skipping the copy keeps
 * `JSON.stringify` on its fast path. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    let hasObjects = false
    for (let i = 0; i < value.length; i++) {
      const v = value[i]
      if (v !== null && typeof v === "object") {
        hasObjects = true
        break
      }
    }
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
