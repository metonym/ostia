import { bench, expandSuiteGlobs } from "../bench/index.ts"
import { computeCacheKey, computeInputsDigest } from "../cache/fingerprint.ts"
import { readCachedRun, writeCachedRun } from "../cache/store.ts"
import { compareWorkload } from "../compare/index.ts"
import { baselinePath, type OstiaConfig } from "../config/index.ts"
import {
  configFingerprint,
  loadDocument,
  makeSubprocessWorkload,
  makeTimingMeasurement,
  newDocument,
  TOOL_VERSION,
} from "../ir/document.ts"
import type {
  Comparison,
  Measurement,
  ProfileDocument,
  Workload,
} from "../ir/types.ts"
import { runTimingPhase } from "../measure/timing.ts"

export interface CiOptions {
  config: OstiaConfig
  full: boolean
  baselineName?: string
}

type WorkloadStatus = "cached" | "executed"

export interface MeasuredWorkload {
  workload: Workload
  status: WorkloadStatus
  run: Measurement
}

interface CiWorkloadResult extends MeasuredWorkload {
  comparison?: Comparison
}

export interface CiSummary {
  total: number
  affected: number
  cached: number
  executed: number
  passed: number
  regressed: number
  missingBaseline: number
  results: CiWorkloadResult[]
}

export class BaselineNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(
      `No baseline document at ${path}. Create one with: ostia time --export-json ${path} <command...>`,
    )
  }
}

/** Runs every configured workload for real (or from cache, for `command`
 * workloads whose fingerprint/inputs are unchanged), with no comparison
 * against any baseline. Shared by `runCi` and `ostia baseline save`, so a
 * saved baseline always reflects the same measurement code path `ci` gates
 * against. */
export async function measureConfigWorkloads(
  config: OstiaConfig,
  full: boolean,
): Promise<MeasuredWorkload[]> {
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
      })
      for (const workload of doc.workloads) {
        const run = doc.measurements.find(
          (m) => m.workloadId === workload.id && m.phase === "timing",
        )
        // A task.skip()'d task has a workload but no timing measurement:
        // nothing to gate, so it contributes nothing here.
        if (!run) continue
        results.push({ workload, status: "executed", run })
      }
      continue
    }

    const workload = makeSubprocessWorkload(wc.command!, wc.label)
    const inputsDigest = await computeInputsDigest(wc.inputs ?? [])
    const cfgFp = configFingerprint({
      runs: config.runs,
      warmup: config.warmup,
    })
    const cacheKey = computeCacheKey({
      workloadId: workload.id,
      phase: "timing",
      configFingerprint: cfgFp,
      bunVersion: Bun.version,
      toolVersion: TOOL_VERSION,
      instrumented: false,
      inputsDigest,
    })

    const cachedRun = full
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
      })
      run = makeTimingMeasurement({
        workload,
        configFingerprint: cfgFp,
        trials: phaseResult.trials,
        timing: phaseResult.timing,
        warnings: phaseResult.warnings,
      })
      await writeCachedRun(config.outDir, cacheKey, run)
      status = "executed"
    }

    results.push({ workload, status, run })
  }

  return results
}

export async function runCi(
  opts: CiOptions,
): Promise<{ document: ProfileDocument; summary: CiSummary }> {
  const { config } = opts
  const path = baselinePath(config, opts.baselineName)
  const baselineFile = Bun.file(path)
  if (!(await baselineFile.exists())) {
    throw new BaselineNotFoundError(path)
  }
  const baseline = await loadDocument(path)

  const measured = await measureConfigWorkloads(config, opts.full)
  const results: CiWorkloadResult[] = measured.map((m) => ({ ...m }))
  const affected = results.filter((r) => r.status === "executed").length
  const cached = results.filter((r) => r.status === "cached").length
  const executed = affected

  const candidateDoc = newDocument(
    results.map((r) => r.workload),
    results.map((r) => r.run),
  )

  let passed = 0
  let regressed = 0
  let missingBaseline = 0

  for (const result of results) {
    const comparison = compareWorkload(
      baseline,
      candidateDoc,
      result.workload.id,
      config.thresholds,
    )
    if (!comparison) {
      missingBaseline++
      continue
    }
    result.comparison = comparison
    if (comparison.verdict === "pass") passed++
    else regressed++
  }

  candidateDoc.comparisons = results
    .map((r) => r.comparison)
    .filter((c): c is Comparison => c !== undefined)

  return {
    document: candidateDoc,
    summary: {
      total: results.length,
      affected,
      cached,
      executed,
      passed,
      regressed,
      missingBaseline,
      results,
    },
  }
}

export function renderCiReport(summary: CiSummary): string {
  const lines: string[] = []
  lines.push(`${summary.total} workloads`)
  lines.push(`${summary.affected} affected by this change`)
  lines.push(`${summary.cached} cached`)
  lines.push(`${summary.executed} executed`)
  if (summary.missingBaseline > 0)
    lines.push(
      `${summary.missingBaseline} skipped (no matching baseline workload)`,
    )

  const regressionDetails = summary.results
    .filter((r) => r.comparison?.verdict === "fail")
    .map((r) => {
      const t = r.comparison!.timing
      const label =
        r.workload.label ?? r.workload.command?.join(" ") ?? r.workload.id
      const detail = t
        ? `${t.medianDeltaPct > 0 ? "+" : ""}${t.medianDeltaPct.toFixed(1)}% median on ${label}`
        : label
      return detail
    })

  lines.push(
    `${summary.passed} passed  ${summary.regressed} regressed${regressionDetails.length > 0 ? ` (${regressionDetails.join(", ")})` : ""}`,
  )
  lines.push("")
  lines.push(`Profile CI: ${summary.regressed > 0 ? "✗" : "✓"}`)

  return `${lines.join("\n")}\n`
}
