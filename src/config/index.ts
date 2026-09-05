import { DEFAULT_THRESHOLDS, type Thresholds } from "../compare/index.ts"
import type { PrepareHook, TimeSource } from "../spawn/index.ts"

/** Exactly one of `command` (a subprocess to time) / `suites` (in-process
 * `group()`/`task()` suite file globs, run via `bench()`) must be given. A
 * `suites` entry gates every task in those files individually - one
 * candidate-vs-baseline comparison per task, matched by workload id the same
 * way `command` workloads already are. */
export interface WorkloadConfig {
  label?: string
  command?: string[]
  suites?: string[]
  inputs?: string[]
  /** `command` only. Runs before every trial (warmup included), unmeasured:
   * a command string / argv array in both `.ts` and JSON config, or a
   * function in `ostia.config.ts`. A function-form hook makes the workload
   * uncacheable for `ostia ci` (its effect can't be fingerprinted), so it
   * always executes. */
  prepare?: PrepareHook
  /** `command` only. Take timing from a number in the command's own output
   * instead of its wall clock; see `TimeSource`. */
  timeSource?: TimeSource
}

export interface BenchConfig {
  /** Suite file globs, resolved with Bun.Glob against the config's directory
   * (e.g. "bench/**\/*.bench.ts"). Ignored when suite files are also given
   * on the command line - CLI args replace this list rather than merging
   * with it. */
  suites?: string[]
  preload?: string[]
  jobs?: number | "auto"
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
export const DEFAULT_OUT_DIR = "node_modules/.cache/ostia"

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

function resolveConfig(raw: Partial<OstiaConfig>): OstiaConfig {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
  }
}

async function loadJsonConfig(path: string): Promise<OstiaConfig | undefined> {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  return resolveConfig((await file.json()) as Partial<OstiaConfig>)
}

async function loadTsConfig(path: string): Promise<OstiaConfig | undefined> {
  const absPath = path.startsWith("/") ? path : `${process.cwd()}/${path}`
  if (!(await Bun.file(absPath).exists())) return undefined
  const mod = (await import(absPath)) as { default?: Partial<OstiaConfig> }
  return resolveConfig(mod.default ?? {})
}

/** With no `path`, looks for `ostia.config.ts` (Bun imports TypeScript
 * natively - the default export is the config, typically built with
 * `defineConfig`), then `ostia.config.json`, in the current directory. An
 * explicit `path` loads exactly that file instead, as `.ts` or JSON going by
 * its extension. */
export async function loadConfig(
  path?: string,
): Promise<OstiaConfig | undefined> {
  if (path !== undefined) {
    return path.endsWith(".ts") ? loadTsConfig(path) : loadJsonConfig(path)
  }
  return (
    (await loadTsConfig("ostia.config.ts")) ??
    loadJsonConfig("ostia.config.json")
  )
}

export function baselinePath(config: OstiaConfig, name?: string): string {
  return `${config.baselineDir}/${name ?? config.baseline}.json`
}
