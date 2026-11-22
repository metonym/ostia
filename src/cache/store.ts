import type { Measurement } from "../ir/types.ts";

function cachePath(outDir: string, key: string): string {
  return `${outDir}/cache/${key}.json`;
}

// A missing or unreadable (e.g. truncated by an interrupted write) entry
// is a miss.
export async function readCachedRun(
  outDir: string,
  key: string,
): Promise<Measurement | undefined> {
  try {
    const value: unknown = await Bun.file(cachePath(outDir, key)).json();
    return isMeasurement(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// The cache holds ostia's own output: this checks the fields readers reach
// first, not every field.
function isMeasurement(value: unknown): value is Measurement {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "warnings" in value &&
    Array.isArray(value.warnings)
  );
}

export async function writeCachedRun(
  outDir: string,
  key: string,
  run: Measurement,
): Promise<void> {
  await Bun.write(cachePath(outDir, key), `${JSON.stringify(run, null, 2)}\n`);
}
