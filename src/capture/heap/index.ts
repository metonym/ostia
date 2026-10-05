import type { HeapEvidence, Warning } from "../../ir/types.ts"
import { type ProfiledRunOptions, runProfiled } from "../bunflags.ts"
import { parseHeapSnapshot, type RawHeapSnapshot } from "./parse.ts"

export type HeapCaptureOptions = ProfiledRunOptions

export interface HeapCaptureResult {
  diagnosticWallNs: number
  exitCode: number
  artifactPath?: string
  heap?: HeapEvidence
  warnings: Warning[]
}

// `--heap-prof-md` must not accompany `--heap-prof`: md wins and the binary snapshot is skipped.
export async function runHeapCapture(
  opts: HeapCaptureOptions,
): Promise<HeapCaptureResult> {
  const { raw, ...run } = await runProfiled<RawHeapSnapshot>(
    opts,
    [
      "--heap-prof",
      "--heap-prof-dir",
      opts.artifactDir,
      "--heap-prof-name",
      opts.fileName,
    ],
    { what: "a heap snapshot", kind: "heap" },
  )
  return raw ? { ...run, heap: parseHeapSnapshot(raw) } : run
}
