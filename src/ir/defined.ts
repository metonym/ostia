// The fields of `fields` that aren't undefined, so an optional property is
// absent rather than present and undefined (exactOptionalPropertyTypes).
export function definedFields<T extends object>(
  fields: T,
): { [K in keyof T]?: NonNullable<T[K]> | (T[K] & null) } {
  const out: { [K in keyof T]?: NonNullable<T[K]> | (T[K] & null) } = {};
  for (const key in fields) {
    const value = fields[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
