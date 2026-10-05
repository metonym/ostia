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
  /** `command` only. Globs of the files this command's timing depends on:
   * `ostia ci` reuses a cached run while their contents are unchanged.
   * Omitted, the workload always reruns; `[]` declares it depends on
   * nothing and caches until the command or config changes. */
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
  /** `command` only. Kills a trial (or prepare hook) that hasn't finished
   * after this many ms. Overrides `ostia ci`'s 10-minute default per
   * workload. */
  timeoutMs?: number
  /** `command` only. Exit codes to treat as success; see
   * `TimeOptions.ignoreExitCodes`. */
  ignoreExitCodes?: number[]
}

export interface BenchConfig {
  /** Suite file globs, resolved with Bun.Glob against the config's directory
   * (e.g. "bench/**\/*.bench.ts"). Ignored when suite files are also given
   * on the command line - CLI args replace this list rather than merging
   * with it. */
  suites?: string[]
  preload?: string[]
  /** Extra flags for the `bun` process that runs each suite file; see
   * `BenchOptions.bunFlags`. `--bun-flags` replaces this list. */
  bunFlags?: string[]
  jobs?: number | "auto"
  budgetMs?: number
  samples?: number
  minSamples?: number
  gc?: boolean
  cpu?: boolean
  cpuIntervalUs?: number
  alloc?: boolean
  peakMem?: boolean
  filter?: string
  isolate?: boolean
  outDir?: string
  /** Kills a suite file's (or isolated task's) subprocess if it hasn't
   * finished after this many ms. Overrides `ostia ci`'s 10-minute default. */
  timeoutMs?: number
}

/** Settings for `ostia ab` only; it reads the rest (suites, filter,
 * preload, ...) from `bench`. */
export interface AbConfig {
  /** Shell command(s) run once in a freshly extracted base tree, e.g. to
   * build gitignored files the suites import; see `AbOptions.baseSetup`.
   * `--base-setup` replaces this list. */
  setup?: string | string[]
  /** Base trees to keep cached; see `AbOptions.keepTrees`. `--keep-trees`
   * overrides. Default: 5. */
  keepTrees?: number
}

export interface OstiaConfig {
  /** `command` workloads: exact trial count, same as `time()`'s `samples`.
   * Unset, the `budgetMs`/`minSamples` loop decides. */
  samples?: number
  /** `command` workloads: wall-clock sampling budget, ms; see `time()`. */
  budgetMs?: number
  /** `command` workloads: hard floor on trials; see `time()`. */
  minSamples?: number
  warmup: number
  outDir: string
  baselineDir: string
  baseline: string
  thresholds: Thresholds
  workloads: WorkloadConfig[]
  bench?: BenchConfig
  ab?: AbConfig
  /** `ostia ci`'s policy when a configured workload has no matching row in
   * the baseline (by workload id): `"fail"` exits 2 naming the baseline
   * file, `"warn"` lists it in the report without affecting the exit code.
   * Unset (the default): `"fail"` when *every* configured workload is
   * missing, `"warn"` otherwise - a totally stale/wrong baseline is a hard
   * error, a handful of new workloads next to an otherwise-matching
   * baseline is not. */
  onMissingBaseline?: "warn" | "fail"
  /** Measures this machine's noise floor once per `ostia ci` invocation
   * (default true) and stamps it on the candidate document as
   * `environment`, the same reference measurement `time()`/`bench()` run -
   * so `compare`'s noise-floor threshold widening applies to `ci` too, not
   * only to ad hoc `time`/`bench` runs. `--no-noise-check` overrides this
   * to false per invocation. */
  noiseCheck?: boolean
}

// `Partial<OstiaConfig>` alone doesn't help here: Partial is shallow, so a
// user-supplied `thresholds` would still need every Thresholds field even
// though resolveConfig merges it against DEFAULT_THRESHOLDS field-by-field.
export type OstiaConfigInput = Omit<Partial<OstiaConfig>, "thresholds"> & {
  thresholds?: Partial<Thresholds>
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
  warmup: 3,
  outDir: DEFAULT_OUT_DIR,
  baselineDir: DEFAULT_BASELINE_DIR,
  baseline: "main",
  thresholds: DEFAULT_THRESHOLDS,
  workloads: [],
}

/** A config file that exists but can't be used: unparseable, or using a
 * field that no longer exists. The CLI reports it as `config-invalid`. */
export class ConfigError extends Error {}

// Fields that were renamed, so an old config fails loudly instead of having
// the setting silently ignored.
const RENAMED_FIELDS: Record<string, string> = { runs: "samples" }

function resolveConfig(raw: OstiaConfigInput, path: string): OstiaConfig {
  for (const [old, current] of Object.entries(RENAMED_FIELDS)) {
    if (old in raw) {
      throw new ConfigError(`${path}: "${old}" was renamed to "${current}".`)
    }
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
  }
}

async function loadJsonConfig(path: string): Promise<OstiaConfig | undefined> {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  let raw: OstiaConfigInput
  try {
    raw = (await file.json()) as OstiaConfigInput
  } catch (err) {
    throw new ConfigError(
      `${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return resolveConfig(raw, path)
}

async function loadTsConfig(path: string): Promise<OstiaConfig | undefined> {
  const absPath = path.startsWith("/") ? path : `${process.cwd()}/${path}`
  if (!(await Bun.file(absPath).exists())) return undefined
  let mod: { default?: OstiaConfigInput }
  try {
    mod = await import(absPath)
  } catch (err) {
    throw new ConfigError(
      `${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return resolveConfig(mod.default ?? {}, path)
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

/** Which file `loadConfig()`'s no-arg discovery would read: `ostia.config.ts`
 * if present, else `ostia.config.json` if present, else undefined - for
 * messaging (e.g. naming the actual file a "no workloads configured" error
 * is about), not for loading. */
export async function configFilePath(): Promise<string | undefined> {
  if (await Bun.file("ostia.config.ts").exists()) return "ostia.config.ts"
  if (await Bun.file("ostia.config.json").exists()) return "ostia.config.json"
  return undefined
}
