import { resolve } from "node:path"

const SKIPPED_DIRS = ["node_modules", ".git"]
const GLOB_CHARS = /[*?[\]{}!]/

/** Segments after the pattern's literal prefix, i.e. the part the wildcards chose. */
function wildcardSegments(pattern: string, path: string): [string[], string[]] {
  const patternSegs = pattern.split("/")
  const literal = patternSegs.findIndex((s) => GLOB_CHARS.test(s))
  const from = literal < 0 ? patternSegs.length : literal
  return [patternSegs.slice(from), path.split("/").slice(from)]
}

/** Paths under `cwd` matching any of `patterns`, relative to `cwd`, deduped and
 * sorted. Dotfiles match (`.github/**`), but wildcards never descend into
 * `node_modules` or `.git` unless the pattern names that directory itself. */
export async function scanGlobs(
  patterns: string[],
  cwd: string,
): Promise<string[]> {
  const paths = new Set<string>()
  for (const pattern of patterns) {
    // Bun.Glob matches nothing for an absolute path with no wildcard.
    if (!GLOB_CHARS.test(pattern)) {
      if (await Bun.file(resolve(cwd, pattern)).exists()) paths.add(pattern)
      continue
    }
    for await (const path of new Bun.Glob(pattern).scan({ cwd, dot: true })) {
      const [named, matched] = wildcardSegments(pattern, path)
      const skipped = matched.some(
        (seg) => SKIPPED_DIRS.includes(seg) && !named.includes(seg),
      )
      if (!skipped) paths.add(path)
    }
  }
  return [...paths].sort()
}
