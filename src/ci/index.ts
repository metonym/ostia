import { bench, resolveBenchOptions } from "../bench/index.ts"
import { captureRunEnvironment } from "../bench/support.ts"
import { computeCacheKey, computeInputsDigest } from "../cache/fingerprint.ts"
import { readCachedRun, writeCachedRun } from "../cache/store.ts"
import { createComparer, summarizeComparisons } from "../compare/index.ts"
import {
  baselinePath,
  type OstiaConfig,
  type WorkloadConfig,
} from "../config/index.ts"
import { OstiaUsageError } from "../errors.ts"
import { scanGlobs } from "../glob.ts"
import {
  configFingerprint,
  createDocument,
  loadDocument,
  makeSubprocessWorkload,
  makeTimingMeasurement,
} from "../ir/document.ts"
import type {
  Comparison,
  Environment,
  Measurement,
  ProfileDocument,
  Warning,
  Workload,
} from "../ir/types.ts"
import { isHarnessFailure, runTimingPhase } from "../measure/timing.ts"
import { formatSignedPct, workloadLabel } from "../renderers/format.ts"
import { abortedWarning } from "../time.ts"
import { TOOL_VERSION } from "../version.ts"

export interface CiOptions {
  config: OstiaConfig
  full: boolean
  baselineName?: string
  /** Abort kills in-flight trials and suite processes and stops scheduling
   * workloads. `runCi` then resolves with `aborted: true`: the document holds
   * what completed, nothing is compared, and no run is written to the cache. */
  signal?: AbortSignal
}

/** Hung workloads time out rather than block a CI job; `WorkloadConfig.timeoutMs`
 * / `BenchConfig.timeoutMs` override this. */
const DEFAULT_CI_TIMEOUT_MS = 600_000

type WorkloadStatus = "cached" | "executed"

interface MeasuredWorkload {
  workload: Workload
  status: WorkloadStatus
  run: Measurement
  /** `command` workloads only (see `isHarnessFailure`): not a regression, so
   * gated separately from a timing verdict. Always `false` for `suites`. */
  harnessFailed: boolean
}

interface CiWorkloadResult extends MeasuredWorkload {
  comparison?: Comparison
}

export interface CiSummary {
  total: number
  cached: number
  executed: number
  passed: number
  regressed: number
  missingBaseline: number
  /** Count of `results` with `harnessFailed: true`; always gates the exit to 2. */
  failed: number
  results: CiWorkloadResult[]
  /** Workloads on only one side: `candOnly` is what `missingBaseline` counts,
   * as full `Workload`s so a renderer can name them. */
  unmatched: { baseOnly: Workload[]; candOnly: Workload[] }
}

/** Base of the two baseline errors, so the CLI reports either as `baseline-missing`. */
export class BaselineError extends OstiaUsageError {}

export class BaselineNotFoundError extends BaselineError {
  constructor(public readonly path: string) {
    super(
      `No baseline document at ${path}. Create one with: ostia baseline save ${path
        .split("/")
        .pop()!
        .replace(/\.json$/, "")}`,
    )
  }
}

/** Thrown by `runCi` when the `onMissingBaseline` policy makes unmatched
 * workloads a hard error. */
export class MissingBaselineError extends BaselineError {
  constructor(
    public readonly path: string,
    public readonly missing: number,
    public readonly total: number,
  ) {
    super(
      `${missing} of ${total} configured workload(s) have no matching row in baseline ${path} (by workload id). Re-seed with: ostia baseline save`,
    )
  }
}

export interface MeasureConfigWorkloadsResult {
  results: MeasuredWorkload[]
  /** One reference measurement taken before any workload runs, unless
   * `config.noiseCheck` is false. */
  environment?: Environment
  /** The signal fired: `results` holds only what completed. */
  aborted: boolean
}

async function measureSuiteWorkloads(
  config: OstiaConfig,
  wc: WorkloadConfig,
  noiseWarning: Warning | undefined,
  signal: AbortSignal | undefined,
): Promise<MeasuredWorkload[]> {
  // Always executes: a suite file's task ids (so its cache keys) are unknown
  // without importing it.
  const suiteFiles = await scanGlobs(wc.suites!, process.cwd())
  if (suiteFiles.length === 0) {
    // Gating zero tasks would pass silently.
    throw new OstiaUsageError(
      `Workload suites ${JSON.stringify(wc.suites)} matched no files.`,
    )
  }
  // Same CLI-over-config resolution as `ostia bench`; only the defaults differ.
  const benchOpts = await resolveBenchOptions(
    { suites: suiteFiles, preload: [], bunFlags: [], noiseCheck: false },
    config.bench,
  )
  const doc = await bench({
    ...benchOpts,
    outDir: benchOpts.outDir ?? config.outDir,
    // The workload's own limit, then `bench.timeoutMs`, as for a command.
    timeoutMs: wc.timeoutMs ?? benchOpts.timeoutMs ?? DEFAULT_CI_TIMEOUT_MS,
    signal,
  })
  const results: MeasuredWorkload[] = []
  for (const workload of doc.workloads) {
    const run = doc.measurements.find(
      (m) => m.workloadId === workload.id && m.phase === "timing",
    )
    // A task.skip()'d task has no timing measurement: nothing to gate.
    if (!run) continue
    if (noiseWarning) run.warnings.push(noiseWarning)
    results.push({ workload, status: "executed", run, harnessFailed: false })
  }
  return results
}

async function measureCommandWorkload(
  config: OstiaConfig,
  wc: WorkloadConfig,
  full: boolean,
  noiseWarning: Warning | undefined,
  signal: AbortSignal | undefined,
): Promise<MeasuredWorkload> {
  const workload = makeSubprocessWorkload(wc.command!, wc.label, {
    prepare: wc.prepare,
    timeSource: wc.timeSource,
  })
  const cfgFp = configFingerprint({
    samples: config.samples ?? null,
    budgetMs: config.budgetMs ?? null,
    minSamples: config.minSamples ?? null,
    warmup: config.warmup,
  })
  // Only declared `inputs` say what a cached run depends on (`inputs: []`
  // means "nothing"). A function-form prepare can read anything, so it never
  // comes from cache either.
  const cacheable = wc.inputs !== undefined && typeof wc.prepare !== "function"
  const cacheKey = computeCacheKey({
    workloadId: workload.id,
    phase: "timing",
    configFingerprint: cfgFp,
    bunVersion: Bun.version,
    toolVersion: TOOL_VERSION,
    instrumented: false,
    inputsDigest: await computeInputsDigest(wc.inputs ?? []),
  })

  const cachedRun =
    full || !cacheable
      ? undefined
      : await readCachedRun(config.outDir, cacheKey)
  let run: Measurement
  if (cachedRun) {
    run = cachedRun
  } else {
    const phaseResult = await runTimingPhase({
      argv: wc.command!,
      samples: config.samples,
      budgetMs: config.budgetMs,
      minSamples: config.minSamples,
      warmup: config.warmup,
      prepare: wc.prepare,
      timeSource: wc.timeSource,
      timeoutMs: wc.timeoutMs ?? DEFAULT_CI_TIMEOUT_MS,
      ignoreExitCodes: wc.ignoreExitCodes,
      signal,
    })
    run = makeTimingMeasurement({
      workload,
      configFingerprint: cfgFp,
      trials: phaseResult.trials,
      timing: phaseResult.timing,
      warnings: noiseWarning
        ? [...phaseResult.warnings, noiseWarning]
        : phaseResult.warnings,
    })
    // A cancelled run holds partial trials, which must never be served later.
    if (cacheable && !signal?.aborted) {
      await writeCachedRun(config.outDir, cacheKey, run)
    }
  }

  return {
    workload,
    status: cachedRun ? "cached" : "executed",
    run,
    harnessFailed: isHarnessFailure(run, wc.ignoreExitCodes),
  }
}

/** Runs every configured workload (or reads it from cache) with no baseline
 * comparison. Shared by `runCi` and `ostia baseline save`, so a saved
 * baseline comes from the same code path `ci` gates against. */
export async function measureConfigWorkloads(
  config: OstiaConfig,
  full: boolean,
  signal?: AbortSignal,
): Promise<MeasureConfigWorkloadsResult> {
  // Stamped on every measurement taken now, never on a cached one.
  const { environment, noiseWarning } = captureRunEnvironment(config.noiseCheck)
  const results: MeasuredWorkload[] = []
  for (const wc of config.workloads) {
    if (signal?.aborted) break
    if (wc.suites) {
      results.push(
        ...(await measureSuiteWorkloads(config, wc, noiseWarning, signal)),
      )
    } else {
      results.push(
        await measureCommandWorkload(config, wc, full, noiseWarning, signal),
      )
    }
  }
  const aborted = signal?.aborted ?? false
  const last = results.at(-1)?.run
  if (aborted && last && !last.warnings.some((w) => w.code === "aborted")) {
    last.warnings = [...last.warnings, abortedWarning()]
  }
  return { results, environment, aborted }
}

export async function runCi(opts: CiOptions): Promise<{
  document: ProfileDocument
  summary: CiSummary
  /** The baseline `document` was compared against, so a caller can report its
   * `git` without loading it again. */
  baseline: ProfileDocument
  /** Cancelled by `signal`: `document` is partial and has no comparisons. */
  aborted: boolean
}> {
  const { config } = opts
  const path = baselinePath(config, opts.baselineName)
  if (!(await Bun.file(path).exists())) {
    throw new BaselineNotFoundError(path)
  }
  const baseline = await loadDocument(path)

  const {
    results: measured,
    environment,
    aborted,
  } = await measureConfigWorkloads(config, opts.full, opts.signal)
  const results: CiWorkloadResult[] = measured.map((m) => ({ ...m }))
  const executed = results.filter((r) => r.status === "executed").length
  const candidateDoc = createDocument(
    results.map((r) => r.workload),
    results.map((r) => r.run),
    environment,
  )

  if (aborted) {
    return {
      document: candidateDoc,
      summary: {
        total: results.length,
        cached: results.length - executed,
        executed,
        passed: 0,
        regressed: 0,
        missingBaseline: 0,
        failed: 0,
        results,
        unmatched: { baseOnly: [], candOnly: [] },
      },
      baseline,
      aborted,
    }
  }

  const comparer = createComparer(baseline, candidateDoc, config.thresholds)
  const comparisons: Comparison[] = []
  for (const result of results) {
    const comparison = comparer.compare(result.workload.id)
    if (comparison) {
      result.comparison = comparison
      comparisons.push(comparison)
    }
  }
  const missingBaseline = results.length - comparisons.length
  const passed = comparisons.filter((c) => c.verdict === "pass").length

  // Unset: fail only when every workload is missing (a stale baseline file),
  // warn when just some are (a workload added since the baseline was saved).
  const policy =
    config.onMissingBaseline ??
    (missingBaseline === results.length ? "fail" : "warn")
  if (missingBaseline > 0 && policy === "fail") {
    throw new MissingBaselineError(path, missingBaseline, results.length)
  }

  const unmatched = comparer.unmatched()
  candidateDoc.comparisons = comparisons
  candidateDoc.unmatched = {
    baseOnly: unmatched.baseOnly.map((w) => w.id),
    candOnly: unmatched.candOnly.map((w) => w.id),
  }
  candidateDoc.comparisonSummary = summarizeComparisons(
    comparisons,
    comparer.effectiveTimingPct,
  )

  return {
    document: candidateDoc,
    summary: {
      total: results.length,
      cached: results.length - executed,
      executed,
      passed,
      regressed: comparisons.length - passed,
      missingBaseline,
      failed: results.filter((r) => r.harnessFailed).length,
      results,
      unmatched,
    },
    baseline,
    aborted: false,
  }
}

export function renderCiReport(summary: CiSummary): string {
  const lines = [
    `${summary.total} workloads`,
    `${summary.cached} cached`,
    `${summary.executed} executed`,
  ]
  if (summary.missingBaseline > 0) {
    lines.push(
      `${summary.missingBaseline} skipped (no matching baseline workload)`,
    )
  }
  if (summary.failed > 0) {
    const failedLabels = summary.results
      .filter((r) => r.harnessFailed)
      .map((r) => workloadLabel(r.workload))
    lines.push(
      `${summary.failed} failed (harness error, a command exited non-zero or produced no samples: ${failedLabels.join(", ")})`,
    )
  }

  const regressionDetails = summary.results
    .filter((r) => r.comparison?.verdict === "fail")
    .map((r) => {
      const t = r.comparison!.timing
      const label = workloadLabel(r.workload)
      return t
        ? `${formatSignedPct(t.medianDeltaPct)} median on ${label}`
        : label
    })

  lines.push(
    `${summary.passed} passed  ${summary.regressed} regressed${regressionDetails.length > 0 ? ` (${regressionDetails.join(", ")})` : ""}`,
    "",
    `Profile CI: ${summary.regressed > 0 || summary.failed > 0 ? "✗" : "✓"}`,
  )
  return `${lines.join("\n")}\n`
}
