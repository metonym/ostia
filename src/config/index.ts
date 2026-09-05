import { DEFAULT_THRESHOLDS, type Thresholds } from "../compare/index.ts"

interface WorkloadConfig {
  label?: string
  command: string[]
  inputs?: string[]
}

export interface BenchConfig {
  /** Suite file globs, resolved with Bun.Glob against the config's directory
   * (e.g. "bench/**\/*.bench.ts"). Ignored when suite files are also given
   * on the command line - CLI args replace this list rather than merging
   * with it. */
  suites?: string[]
  preload?: string[]
  jobs?: number | "auto"
  /** @deprecated Use `budgetMs`. */
  timeBudgetMs?: number
  budgetMs?: number
  samples?: number
  minSamples?: number
  gc?: boolean
  cpu?: boolean
  alloc?: boolean
  filter?: string
  isolate?: boolean
  outDir?: string
}

export interface OstiaConfig {
  runs: number | null
  warmup: number
  outDir: string
  baselineDir: string
  baseline: string
  cpuIntervalUs: number
  thresholds: Thresholds
  workloads: WorkloadConfig[]
  bench?: BenchConfig
}

// Scratch/artifact output: node_modules is already gitignored everywhere,
// so consumers get that for free (matches node_modules/.cache/<tool> as
// used by Babel, ESLint, Jest, etc).
const DEFAULT_OUT_DIR = "node_modules/.cache/ostia"

// Baselines are the one output that must survive node_modules churn (bun
// install, CI job boundaries, branch switches) - they stay at the repo
// root by default, independent of outDir.
const DEFAULT_BASELINE_DIR = ".ostia/baselines"

export const DEFAULT_CONFIG: OstiaConfig = {
  runs: null,
  warmup: 3,
  outDir: DEFAULT_OUT_DIR,
  baselineDir: DEFAULT_BASELINE_DIR,
  baseline: "main",
  cpuIntervalUs: 1000,
  thresholds: DEFAULT_THRESHOLDS,
  workloads: [],
}

export async function loadConfig(
  path = "ostia.config.json",
): Promise<OstiaConfig | undefined> {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  const raw = (await file.json()) as Partial<OstiaConfig>
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
  }
}

export function baselinePath(config: OstiaConfig, name?: string): string {
  return `${config.baselineDir}/${name ?? config.baseline}.json`
}
