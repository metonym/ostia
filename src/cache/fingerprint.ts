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

export async function computeInputsDigest(
  globs: string[],
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  if (globs.length === 0) return undefined

  const paths = new Set<string>()
  for (const pattern of globs) {
    const glob = new Bun.Glob(pattern)
    for await (const path of glob.scan({ cwd, absolute: false })) {
      paths.add(path)
    }
  }

  const sorted = [...paths].sort()
  const entries = await Promise.all(
    sorted.map(async (path) => {
      const buf = await Bun.file(`${cwd}/${path}`).arrayBuffer()
      return { path, sha256: Bun.CryptoHasher.hash("sha256", buf, "hex") }
    }),
  )

  return fp("inputs", entries)
}
