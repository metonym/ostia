import type { HeapEvidence, Warning } from "../ir/types.ts";
import { type ProfiledRunOptions, runProfiled } from "./bunflags.ts";
import { isRawHeapSnapshot, parseHeapSnapshot } from "./heap-parse.ts";

type HeapCaptureOptions = ProfiledRunOptions;

interface HeapCaptureResult {
  diagnosticWallNs: number;
  exitCode: number;
  artifactPath?: string;
  heap?: HeapEvidence;
  warnings: Warning[];
}

// `--heap-prof-md` must not accompany `--heap-prof`: md wins and the
// binary snapshot is skipped.
export async function runHeapCapture(
  opts: HeapCaptureOptions,
): Promise<HeapCaptureResult> {
  const { raw, ...run } = await runProfiled(
    opts,
    [
      "--heap-prof",
      "--heap-prof-dir",
      opts.artifactDir,
      "--heap-prof-name",
      opts.fileName,
    ],
    { what: "a heap snapshot", kind: "heap" },
  );
  if (!raw) return run;
  if (!isRawHeapSnapshot(raw)) {
    throw new Error(`ostia: ${run.artifactPath} isn't a heap snapshot`);
  }
  return { ...run, heap: parseHeapSnapshot(raw) };
}
