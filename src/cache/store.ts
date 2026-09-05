import type { Measurement } from "../ir/types.ts"

function cachePath(outDir: string, key: string): string {
  return `${outDir}/cache/${key}.json`
}

export async function readCachedRun(
  outDir: string,
  key: string,
): Promise<Measurement | undefined> {
  const file = Bun.file(cachePath(outDir, key))
  if (!(await file.exists())) return undefined
  return (await file.json()) as Measurement
}

export async function writeCachedRun(
  outDir: string,
  key: string,
  run: Measurement,
): Promise<void> {
  await Bun.write(cachePath(outDir, key), `${JSON.stringify(run, null, 2)}\n`)
}
