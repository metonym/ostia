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

interface CiWorkloadResult {
  workload: Workload
  status: WorkloadStatus
  run: Measurement
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
      `No baseline document at ${path}. Create one with: ostia run --export-json ${path} <command...>`,
    )
  }
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

  const results: CiWorkloadResult[] = []
  let affected = 0
  let cached = 0
  let executed = 0

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
      })
      for (const workload of doc.workloads) {
        const run = doc.measurements.find(
          (m) => m.workloadId === workload.id && m.phase === "timing",
        )
        // A task.skip()'d task has a workload but no timing measurement:
        // nothing to gate, so it's neither affected nor executed.
        if (!run) continue
        affected++
        executed++
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

    const cachedRun = opts.full
      ? undefined
      : await readCachedRun(config.outDir, cacheKey)
    let run: Measurement
    let status: WorkloadStatus

    if (cachedRun) {
      run = cachedRun
      status = "cached"
      cached++
    } else {
      affected++
      const phaseResult = await runTimingPhase({
        argv: wc.command!,
        runs: config.runs ?? undefined,
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
      executed++
    }

    results.push({ workload, status, run })
  }

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
