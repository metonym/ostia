import type { CpuEvidence, Warning } from "../../ir/types.ts"
import { parseCpuProfile, type RawCpuProfile } from "./parse.ts"

// BUN_OPTIONS is the fallback when argv[0] isn't literally `bun`; BUN_CPU_PROFILE does not work on Bun 1.4.0 despite being documented.

export interface CpuCaptureOptions {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  artifactDir: string
  fileName: string
  intervalUs: number
}

export interface CpuCaptureResult {
  diagnosticWallNs: number
  exitCode: number
  artifactPath?: string
  cpu?: CpuEvidence
  warnings: Warning[]
}

function withCpuProfFlags(
  argv: string[],
  artifactDir: string,
  fileName: string,
  intervalUs: number,
): string[] {
  const flags = [
    "--cpu-prof",
    "--cpu-prof-dir",
    artifactDir,
    "--cpu-prof-name",
    fileName,
    "--cpu-prof-interval",
    String(intervalUs),
  ]
  const bin = argv[0]
  if (bin === "bun" || bin?.endsWith("/bun")) {
    return [bin, ...flags, ...argv.slice(1)]
  }
  return argv
}

export async function runCpuCapture(
  opts: CpuCaptureOptions,
): Promise<CpuCaptureResult> {
  const artifactPath = `${opts.artifactDir}/${opts.fileName}`
  const bin = opts.argv[0]
  const usesInlineFlags = bin === "bun" || bin?.endsWith("/bun")
  const argv = withCpuProfFlags(
    opts.argv,
    opts.artifactDir,
    opts.fileName,
    opts.intervalUs,
  )
  const env = usesInlineFlags
    ? opts.env
    : {
        ...process.env,
        ...opts.env,
        BUN_OPTIONS: `--cpu-prof --cpu-prof-dir ${opts.artifactDir} --cpu-prof-name ${opts.fileName} --cpu-prof-interval ${opts.intervalUs}`,
      }

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
          message: `Expected a .cpuprofile at ${artifactPath} after exit ${exitCode}, found nothing. The workload's argv[0] must be a \`bun\` binary for CPU capture.`,
          data: { artifactPath, argv: opts.argv },
        },
      ],
    }
  }

  const raw = (await file.json()) as RawCpuProfile
  const cpu = parseCpuProfile(raw, "cpu-prof", opts.intervalUs)
  const warnings: Warning[] =
    raw.samples.length === 0
      ? [
          {
            code: "empty-profile",
            message: "CPU capture produced zero samples.",
          },
        ]
      : []

  return { diagnosticWallNs, exitCode, artifactPath, cpu, warnings }
}
