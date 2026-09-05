import { measureConfigWorkloads } from "../ci/index.ts"
import { baselinePath, type OstiaConfig } from "../config/index.ts"
import { loadDocument, newDocument, saveDocument } from "../ir/document.ts"

/** Measures every configured workload (the same code path `ostia ci` gates
 * against, no comparison) and writes it to `<baselineDir>/<name>.json`
 * (default name from `config.baseline`). Returns the path written. */
export async function saveBaseline(
  config: OstiaConfig,
  name?: string,
): Promise<string> {
  const measured = await measureConfigWorkloads(config, false)
  const doc = newDocument(
    measured.map((m) => m.workload),
    measured.map((m) => m.run),
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
}

/** Lists every `<baselineDir>/*.json` that parses as a `ProfileDocument`,
 * sorted by name. An empty (or missing) `baselineDir` yields an empty list
 * rather than throwing - "no baselines saved yet" is not an error. */
export async function listBaselines(
  config: OstiaConfig,
): Promise<BaselineInfo[]> {
  const names: string[] = []
  try {
    const glob = new Bun.Glob("*.json")
    for await (const entry of glob.scan({
      cwd: config.baselineDir,
      absolute: false,
    })) {
      names.push(entry.replace(/\.json$/, ""))
    }
  } catch {
    return []
  }
  names.sort()

  const infos: BaselineInfo[] = []
  for (const name of names) {
    const path = baselinePath(config, name)
    try {
      const doc = await loadDocument(path)
      infos.push({
        name,
        path,
        createdAt: doc.createdAt,
        toolVersion: doc.toolVersion,
        bunVersion: doc.bunVersion,
        workloads: doc.workloads.length,
      })
    } catch {
      // Not a valid ProfileDocument (or unreadable): skip it rather than
      // failing the whole listing over one bad file.
    }
  }
  return infos
}
