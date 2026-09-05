import type { HeapEvidence, Warning } from "../../ir/types.ts"
import { withBunFlags } from "../bunflags.ts"
import { parseHeapSnapshot, type RawHeapSnapshot } from "./parse.ts"

// Do not pass `--heap-prof-md` with `--heap-prof`: md wins and the binary snapshot is silently skipped.

export interface HeapCaptureOptions {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  artifactDir: string
  fileName: string
}

export interface HeapCaptureResult {
  diagnosticWallNs: number
  exitCode: number
  artifactPath?: string
  heap?: HeapEvidence
  warnings: Warning[]
}

export async function runHeapCapture(
  opts: HeapCaptureOptions,
): Promise<HeapCaptureResult> {
  const artifactPath = `${opts.artifactDir}/${opts.fileName}`
  const { argv, env } = withBunFlags(
    opts.argv,
    [
      "--heap-prof",
      "--heap-prof-dir",
      opts.artifactDir,
      "--heap-prof-name",
      opts.fileName,
    ],
    opts.env,
  )

  const start = Bun.nanoseconds()
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
  const exitCode = await proc.exited
  const diagnosticWallNs = Bun.nanoseconds() - start

  const file = Bun.file(artifactPath)
  if (!(await file.exists())) {
    return {
      diagnosticWallNs,
      exitCode,
      warnings: [
        {
          code: "artifact-missing",
          message: `Expected a heap snapshot at ${artifactPath} after exit ${exitCode}, found nothing. The workload's argv[0] must be a \`bun\` binary for heap capture.`,
          data: { artifactPath, argv: opts.argv },
        },
      ],
    }
  }

  const raw = (await file.json()) as RawHeapSnapshot
  const heap = parseHeapSnapshot(raw, "heap-prof")

  return { diagnosticWallNs, exitCode, artifactPath, heap, warnings: [] }
}
