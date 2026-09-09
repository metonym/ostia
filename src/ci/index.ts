import { bench, expandSuiteGlobs } from "../bench/index.ts"
import { computeCacheKey, computeInputsDigest } from "../cache/fingerprint.ts"
import { readCachedRun, writeCachedRun } from "../cache/store.ts"
import { createComparer, summarizeComparisons } from "../compare/index.ts"
import { baselinePath, type OstiaConfig } from "../config/index.ts"
import {
  configFingerprint,
  loadDocument,
  makeSubprocessWorkload,
  makeTimingMeasurement,
  newDocument,
} from "../ir/document.ts"
import type {
  Comparison,
  Environment,
  Measurement,
  ProfileDocument,
  Trial,
  Workload,
} from "../ir/types.ts"
import {
  captureEnvironment,
  noisyMachineWarning,
} from "../measure/environment.ts"
import { runTimingPhase } from "../measure/timing.ts"
import { workloadLabel } from "../renderers/format.ts"
import { TOOL_VERSION } from "../version.ts"

export interface CiOptions {
  config: OstiaConfig
  full: boolean
  baselineName?: string
}

/** `ostia ci` (and `ostia baseline save`, which shares this code path) time
 * out a hung workload rather than block a CI job indefinitely; a per-workload
 * `WorkloadConfig.timeoutMs` / `BenchConfig.timeoutMs` overrides this. */
const DEFAULT_CI_TIMEOUT_MS = 600_000

type WorkloadStatus = "cached" | "executed"

interface MeasuredWorkload {
  workload: Workload
  status: WorkloadStatus
  run: Measurement
  /** `command` workloads only: every sampled trial (after `ignoreExitCodes`)
   * exited non-zero - not a regression, a harness failure (the command
   * itself is broken), so `ci` reports and gates on it separately from a
   * timing verdict. Always `false` for `suites` workloads: there's no
   * subprocess exit code to check at this granularity. */
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
  /** Count of `results` with `harnessFailed: true`. Always gates the exit
   * code to 2, regardless of `regressed`. */
  failed: number
  results: CiWorkloadResult[]
  /** Workload present on only one side of the baseline/candidate pair - a
   * baseline row with no configured workload behind it anymore, or a
   * configured workload with no matching baseline row (the same condition
   * `missingBaseline` counts, exposed here as full `Workload`s instead of a
   * count so a renderer can name them). */
  unmatched: { baseOnly: Workload[]; candOnly: Workload[] }
}

export class BaselineNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(
      `No baseline document at ${path}. Create one with: ostia time --export-json ${path} <command...>`,
    )
  }
}

/** Thrown by `runCi` when `onMissingBaseline` (explicit or the "fail when
 * every workload is missing" default) decides a mismatch between the
 * configured workloads and the baseline file's rows is a hard error rather
 * than something to list and continue past. */
export class MissingBaselineError extends Error {
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

/** Resolves `config.onMissingBaseline` (or a CLI override) to an effective
 * policy: an explicit `"warn"`/`"fail"` always wins; left unset, `"fail"`
 * only when *every* configured workload is missing from the baseline (a
 * stale/wrong baseline file), `"warn"` when just some are (e.g. a workload
 * added since the baseline was last saved). */
function effectiveMissingBaselinePolicy(
  configured: "warn" | "fail" | undefined,
  missingBaseline: number,
  total: number,
): "warn" | "fail" {
  if (configured) return configured
  return missingBaseline === total ? "fail" : "warn"
}

function isHarnessFailure(
  trials: Trial[],
  ignoreExitCodes: number[] = [],
): boolean {
  const ignoreSet = new Set(ignoreExitCodes)
  const exitCodes = trials
    .filter((t) => !t.timedOut && !t.timeSourceNoMatch)
    .map((t) => t.exitCode)
    .filter((c): c is number => c !== undefined)
  return (
    exitCodes.length > 0 && exitCodes.every((c) => c !== 0 && !ignoreSet.has(c))
  )
}

export interface MeasureConfigWorkloadsResult {
  results: MeasuredWorkload[]
  /** Machine conditions from one ~200ms reference measurement taken before
   * any configured workload runs (default true; `config.noiseCheck: false`
   * skips it) - the same measurement `time()`/`bench()` take, so `compare`'s
   * noise-floor threshold widening applies to `ci`-produced documents too. */
  environment?: Environment
}

/** Runs every configured workload for real (or from cache, for `command`
 * workloads whose fingerprint/inputs are unchanged), with no comparison
 * against any baseline. Shared by `runCi` and `ostia baseline save`, so a
 * saved baseline always reflects the same measurement code path `ci` gates
 * against. */
export async function measureConfigWorkloads(
  config: OstiaConfig,
  full: boolean,
): Promise<MeasureConfigWorkloadsResult> {
  const environment =
    config.noiseCheck === false ? undefined : captureEnvironment()
  // Same `noisy-machine` stamp `time()`/`bench()` put on their measurements:
  // attached to every measurement taken now, never to a cached one (that
  // was measured under whatever load its own run saw).
  const noiseWarning = environment
    ? noisyMachineWarning(environment)
    : undefined
  const results: MeasuredWorkload[] = []

  for (const wc of config.workloads) {
    if (wc.suites) {
      // In-process suites gate at task granularity: every task in the
      // matched files gets compared individually, the same way a `command`
      // workload does. There's no cheap way to know a suite file's task ids
      // (and so its per-task cache keys) without importing it, so unlike
      // `command` workloads, a `suites` entry always executes - caching
      // here is future work, not a regression from what `command` already does.
      const suiteFiles = await expandSuiteGlobs(wc.suites, process.cwd())
      const doc = await bench({
        suites: suiteFiles,
        outDir: config.outDir,
        noiseCheck: false,
        budgetMs: config.bench?.budgetMs,
        samples: config.bench?.samples,
        minSamples: config.bench?.minSamples,
        gc: config.bench?.gc,
        cpu: config.bench?.cpu,
        alloc: config.bench?.alloc,
        filter: config.bench?.filter,
        isolate: config.bench?.isolate,
        preload: config.bench?.preload,
        jobs:
          typeof config.bench?.jobs === "number"
            ? config.bench.jobs
            : undefined,
        timeoutMs: config.bench?.timeoutMs ?? DEFAULT_CI_TIMEOUT_MS,
      })
      for (const workload of doc.workloads) {
        const run = doc.measurements.find(
          (m) => m.workloadId === workload.id && m.phase === "timing",
        )
        // A task.skip()'d task has a workload but no timing measurement:
        // nothing to gate, so it contributes nothing here.
        if (!run) continue
        if (noiseWarning) run.warnings.push(noiseWarning)
        results.push({
          workload,
          status: "executed",
          run,
          harnessFailed: false,
        })
      }
      continue
    }

    const workload = makeSubprocessWorkload(wc.command!, wc.label, {
      prepare: wc.prepare,
      timeSource: wc.timeSource,
    })
    const inputsDigest = await computeInputsDigest(wc.inputs ?? [])
    const cfgFp = configFingerprint({
      runs: config.runs,
      warmup: config.warmup,
    })
    // A function-form prepare hook can do anything (its source text is in
    // the workload id, but not what it reads), so its runs never come from
    // cache: the same "fail conservative" rule as a workload with no inputs.
    const cacheable = typeof wc.prepare !== "function"
    const cacheKey = computeCacheKey({
      workloadId: workload.id,
      phase: "timing",
      configFingerprint: cfgFp,
      bunVersion: Bun.version,
      toolVersion: TOOL_VERSION,
      instrumented: false,
      inputsDigest,
    })

    const cachedRun =
      full || !cacheable
        ? undefined
        : await readCachedRun(config.outDir, cacheKey)
    let run: Measurement
    let status: WorkloadStatus

    if (cachedRun) {
      run = cachedRun
      status = "cached"
    } else {
      const phaseResult = await runTimingPhase({
        argv: wc.command!,
        samples: config.runs ?? undefined,
        warmup: config.warmup,
        prepare: wc.prepare,
        timeSource: wc.timeSource,
        timeoutMs: wc.timeoutMs ?? DEFAULT_CI_TIMEOUT_MS,
        ignoreExitCodes: wc.ignoreExitCodes,
        failOnNonzero: wc.failOnNonzero,
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
      if (cacheable) await writeCachedRun(config.outDir, cacheKey, run)
      status = "executed"
    }

    results.push({
      workload,
      status,
      run,
      harnessFailed: isHarnessFailure(run.trials, wc.ignoreExitCodes),
    })
  }

  return { results, environment }
}

export async function runCi(opts: CiOptions): Promise<{
  document: ProfileDocument
  summary: CiSummary
  /** The baseline document `document` was compared against - exposed so a
   * caller can report its `git` alongside the candidate's without a second
   * `loadDocument` of the same path. */
  baseline: ProfileDocument
}> {
  const { config } = opts
  const path = baselinePath(config, opts.baselineName)
  const baselineFile = Bun.file(path)
  if (!(await baselineFile.exists())) {
    throw new BaselineNotFoundError(path)
  }
  const baseline = await loadDocument(path)

  const { results: measured, environment } = await measureConfigWorkloads(
    config,
    opts.full,
  )
  const results: CiWorkloadResult[] = measured.map((m) => ({ ...m }))
  const executed = results.filter((r) => r.status === "executed").length
  const cached = results.length - executed
  const failed = results.filter((r) => r.harnessFailed).length

  const candidateDoc = newDocument(
    results.map((r) => r.workload),
    results.map((r) => r.run),
    environment,
  )

  let passed = 0
  let regressed = 0
  let missingBaseline = 0

  const comparer = createComparer(baseline, candidateDoc, config.thresholds)
  for (const result of results) {
    const comparison = comparer.compare(result.workload.id)
    if (!comparison) {
      missingBaseline++
      continue
    }
    result.comparison = comparison
    if (comparison.verdict === "pass") passed++
    else regressed++
  }

  if (missingBaseline > 0) {
    const policy = effectiveMissingBaselinePolicy(
      config.onMissingBaseline,
      missingBaseline,
      results.length,
    )
    if (policy === "fail") {
      throw new MissingBaselineError(path, missingBaseline, results.length)
    }
  }

  const comparisons = results
    .map((r) => r.comparison)
    .filter((c): c is Comparison => c !== undefined)
  candidateDoc.comparisons = comparisons

  const unmatched = comparer.unmatched()
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
      cached,
      executed,
      passed,
      regressed,
      missingBaseline,
      failed,
      results,
      unmatched,
    },
    baseline,
  }
}

export function renderCiReport(summary: CiSummary): string {
  const lines: string[] = []
  lines.push(`${summary.total} workloads`)
  lines.push(`${summary.cached} cached`)
  lines.push(`${summary.executed} executed`)
  if (summary.missingBaseline > 0)
    lines.push(
      `${summary.missingBaseline} skipped (no matching baseline workload)`,
    )
  if (summary.failed > 0) {
    const failedLabels = summary.results
      .filter((r) => r.harnessFailed)
      .map((r) => workloadLabel(r.workload))
    lines.push(
      `${summary.failed} failed (harness error, every trial exited non-zero: ${failedLabels.join(", ")})`,
    )
  }

  const regressionDetails = summary.results
    .filter((r) => r.comparison?.verdict === "fail")
    .map((r) => {
      const t = r.comparison!.timing
      const label = workloadLabel(r.workload)
      return t
        ? `${t.medianDeltaPct > 0 ? "+" : ""}${t.medianDeltaPct.toFixed(1)}% median on ${label}`
        : label
    })

  lines.push(
    `${summary.passed} passed  ${summary.regressed} regressed${regressionDetails.length > 0 ? ` (${regressionDetails.join(", ")})` : ""}`,
  )
  lines.push("")
  lines.push(
    `Profile CI: ${summary.regressed > 0 || summary.failed > 0 ? "✗" : "✓"}`,
  )

  return `${lines.join("\n")}\n`
}
