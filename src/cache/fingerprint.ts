import { resolve } from "node:path"
import { scanGlobs } from "../glob.ts"
import { fp } from "../ir/fp.ts"
import type { Phase } from "../ir/types.ts"

export interface CacheKeyInput {
  workloadId: string
  phase: Phase
  configFingerprint: string
  bunVersion: string
  toolVersion: string
  instrumented: boolean
  inputsDigest?: string
}

export function computeCacheKey(input: CacheKeyInput): string {
  return fp(
    "cache",
    input.workloadId,
    input.phase,
    input.configFingerprint,
    input.bunVersion,
    input.toolVersion,
    input.instrumented,
    input.inputsDigest ?? null,
  )
}

// Keeps a large glob under the process's open-file limit (EMFILE).
const READ_CONCURRENCY = 32

export async function computeInputsDigest(
  globs: string[],
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  if (globs.length === 0) return undefined

  const paths = await scanGlobs(globs, cwd)
  const entries: { path: string; sha256: string }[] = new Array(paths.length)
  let next = 0
  const worker = async () => {
    while (next < paths.length) {
      const k = next++
      const path = paths[k]!
      // Absolute patterns scan to absolute paths; `resolve` handles both.
      const buf = await Bun.file(resolve(cwd, path)).arrayBuffer()
      entries[k] = { path, sha256: Bun.CryptoHasher.hash("sha256", buf, "hex") }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker),
  )

  return fp("inputs", entries)
}
