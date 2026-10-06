import { DEFAULT_THRESHOLDS, type Thresholds } from "../compare/index.ts"
import { errorMessage } from "../errors.ts"
import type { PrepareHook, TimeSource } from "../spawn/index.ts"
import { ConfigError, validateConfig } from "./validate.ts"

export { ConfigError }

/** Exactly one of `command` (a subprocess to time) / `suites` (in-process
 * `group()`/`task()` suite file globs, run via `bench()`, each task gated
 * individually) must be given. */
export interface WorkloadConfig {
  label?: string
  command?: string[]
  suites?: string[]
  /** `command` only. Globs of the files the timing depends on: `ostia ci`
   * reuses a cached run while their contents are unchanged. Omitted, the
   * workload always reruns; `[]` caches until the command or config changes. */
  inputs?: string[]
  /** `command` only. Runs before every trial (warmup included), unmeasured:
   * a command string / argv array, or in `ostia.config.ts` a function. A
   * function makes the workload uncacheable for `ostia ci`. */
  prepare?: PrepareHook
  /** `command` only. Take timing from a number in the command's own output
   * instead of its wall clock; see `TimeSource`. */
  timeSource?: TimeSource
  /** `command`: kills a trial (or prepare hook) after this many ms.
   * `suites`: kills a suite file's (or isolated task's) process after this
   * many ms, overriding `bench.timeoutMs`. Overrides `ostia ci`'s 10-minute
   * default. */
  timeoutMs?: number
  /** `command` only. Exit codes to treat as success; see
   * `TimeOptions.ignoreExitCodes`. */
  ignoreExitCodes?: number[]
}

export interface BenchConfig {
  /** Suite file globs, resolved against the config's directory (e.g.
   * "bench/**\/*.bench.ts"). Suite files given on the command line replace
   * this list. */
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
  /** Kills a suite file's (or isolated task's) subprocess after this many
   * ms; overrides `ostia ci`'s 10-minute default. */
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
  /** Compare retained heap per call; see `AbOptions.alloc`. `--alloc` /
   * `--no-alloc` override. `bench.alloc` doesn't apply to `ab`. */
  alloc?: boolean
  /** Compare peak RSS of the first call; see `AbOptions.peakMem`.
   * `--peak-mem` / `--no-peak-mem` override. `bench.peakMem` doesn't apply
   * to `ab`. */
  peakMem?: boolean
  /** Memory verdict threshold, percent; see `AbOptions.memThresholdPct`.
   * `--mem-threshold` overrides. Default: 10. */
  memThresholdPct?: number
}

export interface OstiaConfig {
  /** `command` workloads: exact trial count; see `time()`. */
  samples?: number
  /** `command` workloads: sampling budget in ms; see `time()`. */
  budgetMs?: number
  /** `command` workloads: floor on trials; see `time()`. */
  minSamples?: number
  warmup: number
  outDir: string
  baselineDir: string
  baseline: string
  thresholds: Thresholds
  workloads: WorkloadConfig[]
  bench?: BenchConfig
  ab?: AbConfig
  /** `ostia ci`'s policy for a workload with no matching baseline row (by
   * workload id): `"fail"` exits 2 naming the baseline file, `"warn"` lists
   * it in the report. Unset: `"fail"` when every workload is missing (a
   * stale or wrong baseline), `"warn"` otherwise. */
  onMissingBaseline?: "warn" | "fail"
  /** Measure the machine's noise floor once per `ostia ci` run (default
   * true) and stamp it on the candidate document, so `compare` widens its
   * thresholds accordingly. `--no-noise-check` overrides this per run. */
  noiseCheck?: boolean
}

// Partial is shallow, so `thresholds` needs its own Partial to merge field-by-field.
export type OstiaConfigInput = Omit<Partial<OstiaConfig>, "thresholds"> & {
  thresholds?: Partial<Thresholds>
}

// node_modules/.cache is gitignored everywhere already.
export const DEFAULT_OUT_DIR = "node_modules/.cache/ostia"

// Baselines must survive node_modules churn, so they live outside outDir.
const DEFAULT_BASELINE_DIR = ".ostia/baselines"

export const DEFAULT_CONFIG: OstiaConfig = {
  warmup: 3,
  outDir: DEFAULT_OUT_DIR,
  baselineDir: DEFAULT_BASELINE_DIR,
  baseline: "main",
  thresholds: DEFAULT_THRESHOLDS,
  workloads: [],
}

// Renamed fields fail loudly instead of being silently ignored.
const RENAMED_FIELDS: Record<string, string> = { runs: "samples" }

/** In discovery order: `.ts` wins over JSON. */
export const CONFIG_FILES = ["ostia.config.ts", "ostia.config.json"]

const warnConfig = (message: string) => console.warn(`ostia: ${message}`)

/** An explicit `undefined` (`warmup: undefined`) means "unset", not "overwrite the default". */
function withoutUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T
}

function resolveConfig(raw: unknown, path: string): OstiaConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path}: expected an object.`)
  }
  for (const [old, current] of Object.entries(RENAMED_FIELDS)) {
    if (old in raw) {
      throw new ConfigError(`${path}: "${old}" was renamed to "${current}".`)
    }
  }
  validateConfig(raw as Record<string, unknown>, path, warnConfig)
  const input = withoutUndefined(raw as OstiaConfigInput)
  return {
    ...DEFAULT_CONFIG,
    ...input,
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(input.thresholds && withoutUndefined(input.thresholds)),
    },
  }
}

async function readConfigFile(path: string): Promise<unknown> {
  const absPath = path.startsWith("/") ? path : `${process.cwd()}/${path}`
  const file = Bun.file(absPath)
  if (!(await file.exists())) return undefined
  try {
    if (!path.endsWith(".ts")) return await file.json()
    const exported = (await import(absPath)).default
    if (exported === undefined) {
      throw new Error(
        `no default export; use "export default defineConfig({ ... })"`,
      )
    }
    return exported
  } catch (err) {
    throw new ConfigError(`${path}: ${errorMessage(err)}`)
  }
}

async function existingConfigFiles(): Promise<string[]> {
  const found: string[] = []
  for (const file of CONFIG_FILES) {
    if (await Bun.file(file).exists()) found.push(file)
  }
  return found
}

/** Loads `path` (`.ts` or JSON by extension), or with no `path` the file
 * `configFilePath()` finds. `undefined` when there is no such file. Throws
 * `ConfigError` for a file that exists but is unusable, naming the bad key. */
export async function loadConfig(
  path?: string,
): Promise<OstiaConfig | undefined> {
  let file = path
  if (file === undefined) {
    const found = await existingConfigFiles()
    if (found.length > 1) {
      warnConfig(
        `${found.join(" and ")} both exist; using ${found[0]} and ignoring the rest.`,
      )
    }
    file = found[0]
  }
  if (file === undefined) return undefined
  const raw = await readConfigFile(file)
  return raw === undefined ? undefined : resolveConfig(raw, file)
}

export function baselinePath(config: OstiaConfig, name?: string): string {
  return `${config.baselineDir}/${name ?? config.baseline}.json`
}

/** The config file discovery would load from the current directory, `.ts` before JSON. */
export async function configFilePath(): Promise<string | undefined> {
  return (await existingConfigFiles())[0]
}
