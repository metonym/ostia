/** Every path matching any of `patterns` under `cwd`, relative to `cwd`,
 * deduped and sorted so callers get a deterministic order. */
export async function scanGlobs(
  patterns: string[],
  cwd: string,
): Promise<string[]> {
  const paths = new Set<string>()
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({
      cwd,
      absolute: false,
    })) {
      paths.add(path)
    }
  }
  return [...paths].sort()
}
