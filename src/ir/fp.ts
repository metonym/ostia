export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function fp(tag: string, ...parts: unknown[]): string {
  const hex = Bun.CryptoHasher.hash("sha256", canonicalJSON(parts), "hex")
  return `${tag}_${hex.slice(0, 16)}`
}
