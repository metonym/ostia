import { loadDocument, newDocument } from "../ir/document.ts"
import { fp } from "../ir/fp.ts"
import type { ProfileDocument, Run, Workload } from "../ir/types.ts"

export interface BenchOptions {
  suites: string[]
  timeBudgetMs?: number
  minSamples?: number
  gc?: boolean
  outDir?: string
  cwd?: string
}

const RUNNER_PATH = new URL("./runner.ts", import.meta.url).pathname
const DEFAULT_OUT_DIR = ".ostia"

export async function bench(opts: BenchOptions): Promise<ProfileDocument> {
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  const tmpDir = `${outDir}/bench-tmp`
  const cwd = opts.cwd ?? process.cwd()

  const taskOpts = {
    timeBudgetMs: opts.timeBudgetMs,
    minSamples: opts.minSamples,
    gc: opts.gc,
  }
  const workloads: Workload[] = []
  const runs: Run[] = []

  try {
    for (const suiteFile of opts.suites) {
      const resolvedSuite = suiteFile.startsWith("/")
        ? suiteFile
        : `${cwd}/${suiteFile}`
      const outputPath = `${tmpDir}/${fp("bench-out", resolvedSuite)}.json`

      const proc = Bun.spawn(
        [
          "bun",
          RUNNER_PATH,
          resolvedSuite,
          outputPath,
          JSON.stringify(taskOpts),
        ],
        {
          cwd,
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
        },
      )
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        throw new Error(
          `Bench suite failed: ${suiteFile} (runner exited ${exitCode})`,
        )
      }

      const suiteDoc = await loadDocument(outputPath)
      workloads.push(...suiteDoc.workloads)
      runs.push(...suiteDoc.runs)
    }
  } finally {
    await Bun.spawn(["rm", "-rf", tmpDir]).exited
  }

  return newDocument(workloads, runs)
}
