import { measureConfigWorkloads } from "../ci/index.ts"
import { baselinePath, type OstiaConfig } from "../config/index.ts"
import { createDocument, loadDocument, saveDocument } from "../ir/document.ts"
import type { GitMetadata } from "../ir/types.ts"

/** Measures every configured workload and writes it to
 * `<baselineDir>/<name>.json` (default `config.baseline`); returns the path.
 * Always measures fresh: a baseline never holds a cached `ci` run. */
export async function saveBaseline(
  config: OstiaConfig,
  name?: string,
): Promise<string> {
  const { results: measured, environment } = await measureConfigWorkloads(
    config,
    true,
  )
  const doc = createDocument(
    measured.map((m) => m.workload),
    measured.map((m) => m.run),
    environment,
  )
  const path = baselinePath(config, name)
  await saveDocument(doc, path)
  return path
}

export interface BaselineInfo {
  name: string
  path: string
  createdAt: string
  toolVersion: string
  bunVersion: string
  workloads: number
  git?: GitMetadata
}

/** Every `<baselineDir>/*.json` that parses as a `ProfileDocument`, sorted by
 * name. A missing `baselineDir` yields an empty list. */
export async function listBaselines(
  config: OstiaConfig,
): Promise<BaselineInfo[]> {
  let names: string[]
  try {
    const files = await Array.fromAsync(
      new Bun.Glob("*.json").scan({ cwd: config.baselineDir }),
    )
    names = files.map((file) => file.replace(/\.json$/, "")).sort()
  } catch {
    return []
  }

  const infos = await Promise.all(
    names.map(async (name): Promise<BaselineInfo | undefined> => {
      const path = baselinePath(config, name)
      try {
        const doc = await loadDocument(path)
        return {
          name,
          path,
          createdAt: doc.createdAt,
          toolVersion: doc.toolVersion,
          bunVersion: doc.bunVersion,
          workloads: doc.workloads.length,
          ...(doc.git !== undefined && { git: doc.git }),
        }
      } catch {
        return undefined
      }
    }),
  )
  return infos.filter((info) => info !== undefined)
}
