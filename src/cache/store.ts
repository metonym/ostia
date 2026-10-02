import type { Measurement } from "../ir/types.ts"

function cachePath(outDir: string, key: string): string {
  return `${outDir}/cache/${key}.json`
}

/** A missing or unreadable (e.g. truncated by an interrupted write) entry is a miss. */
export async function readCachedRun(
  outDir: string,
  key: string,
): Promise<Measurement | undefined> {
  try {
    return (await Bun.file(cachePath(outDir, key)).json()) as Measurement
  } catch {
    return undefined
  }
}

export async function writeCachedRun(
  outDir: string,
  key: string,
  run: Measurement,
): Promise<void> {
  await Bun.write(cachePath(outDir, key), `${JSON.stringify(run, null, 2)}\n`)
}
