import { fp } from "../ir/fp.ts"
import type {
  Comparison,
  ComparisonSummary,
  Measurement,
  ProfileDocument,
  Warning,
  Workload,
} from "../ir/types.ts"
import { bootstrapMedianDiffCi } from "../stats/bootstrap.ts"
import { mannWhitneyU } from "../stats/mannwhitney.ts"

export interface Thresholds {
  timingPct: number
  frameSelfPct: number
  heapTypePct: number
  minFrameSelfUs: number
  /** Significance level for the Mann-Whitney p-value: a `regressed` /
   * `improved` verdict also requires `pValue < alpha`. */
  alpha: number
  /** Bootstrap resample rounds for the timing CI. Capped work regardless:
   * see `bootstrapMedianDiffCi`. */
  bootstrapIterations: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  timingPct: 5,
  frameSelfPct: 10,
  heapTypePct: 10,
  minFrameSelfUs: 1000,
  alpha: 0.01,
  bootstrapIterations: 2000,
}

/** Below this many samples on either side, a bootstrap CI and Mann-Whitney
 * p-value are too noisy to trust; fall back to the point-estimate rule and
 * say so with a `thin-comparison` warning. */
const MIN_SAMPLES_FOR_TEST = 5

function pctDelta(base: number, cand: number): number {
  if (base === 0) return cand === 0 ? 0 : Infinity
  return ((cand - base) / base) * 100
}

function measurementsFor(
  doc: ProfileDocument,
  workloadId: string,
  phase: Measurement["phase"],
): Measurement | undefined {
  return doc.measurements.find(
    (r) => r.workloadId === workloadId && r.phase === phase,
  )
}

interface EnvironmentMismatchField {
  field: "platform.os" | "platform.arch" | "bunVersion" | "cpuModel" | "cores"
  base: string | number
  cand: string | number
}

/** Same warning for every comparison in a `base`/`cand` pair - the two
 * documents were measured on machines/Bun versions different enough that a
 * timing delta might reflect that instead of the code change under test.
 * Only compares `cpuModel`/`cores` when both sides have `environment` (e.g.
 * `noiseCheck: false` skipped it): missing data isn't a mismatch, it's just
 * unknown. */
function environmentMismatchWarning(
  base: ProfileDocument,
  cand: ProfileDocument,
): Warning | undefined {
  const fields: EnvironmentMismatchField[] = []
  if (base.platform.os !== cand.platform.os) {
    fields.push({
      field: "platform.os",
      base: base.platform.os,
      cand: cand.platform.os,
    })
  }
  if (base.platform.arch !== cand.platform.arch) {
    fields.push({
      field: "platform.arch",
      base: base.platform.arch,
      cand: cand.platform.arch,
    })
  }
  if (base.bunVersion !== cand.bunVersion) {
    fields.push({
      field: "bunVersion",
      base: base.bunVersion,
      cand: cand.bunVersion,
    })
  }
  if (base.environment && cand.environment) {
    if (base.environment.cpuModel !== cand.environment.cpuModel) {
      fields.push({
        field: "cpuModel",
        base: base.environment.cpuModel,
        cand: cand.environment.cpuModel,
      })
    }
    if (base.environment.cores !== cand.environment.cores) {
      fields.push({
        field: "cores",
        base: base.environment.cores,
        cand: cand.environment.cores,
      })
    }
  }
  if (fields.length === 0) return undefined

  return {
    code: "environment-mismatch",
    message: `Base and candidate were measured on different environments (${fields.map((f) => f.field).join(", ")}); a timing delta may reflect that instead of the code change.`,
    data: { fields },
  }
}

export interface CompareResult {
  comparisons: Comparison[]
  unmatched: { baseOnly: Workload[]; candOnly: Workload[] }
  summary: ComparisonSummary
}

/** Geometric mean of `cand/base` median ratios over `comparisons` with a
 * timing verdict, as a signed percent (e.g. `-4.2` means candidate ran
 * ~4.2% faster on average). `null` when no comparison has a finite ratio -
 * an all-frames-only/all-heap-only document, or every timing delta was
 * `Infinity` (a zero baseline median). */
export function geomeanTimingPct(comparisons: Comparison[]): number | null {
  const logRatios: number[] = []
  for (const c of comparisons) {
    if (!c.timing) continue
    const ratio = 1 + c.timing.medianDeltaPct / 100
    if (Number.isFinite(ratio) && ratio > 0) logRatios.push(Math.log(ratio))
  }
  if (logRatios.length === 0) return null
  const meanLog = logRatios.reduce((a, b) => a + b, 0) / logRatios.length
  return (Math.exp(meanLog) - 1) * 100
}

/** Matches `base.workloads` against `cand.workloads` by id, comparing every
 * match and reporting whatever matched only one side instead of silently
 * dropping it - a baseline/candidate pair that share zero workloads (a stale
 * baseline, a totally rewritten config) is visible in `unmatched`, not just
 * an empty `comparisons` array. */
export function compareDocuments(
  base: ProfileDocument,
  cand: ProfileDocument,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): CompareResult {
  const baseWorkloadIds = new Set(base.workloads.map((w) => w.id))
  const candWorkloadIds = new Set(cand.workloads.map((w) => w.id))
  const comparisons: Comparison[] = []
  for (const workload of base.workloads) {
    if (!candWorkloadIds.has(workload.id)) continue
    const comparison = compareWorkload(base, cand, workload.id, thresholds)
    if (comparison) comparisons.push(comparison)
  }

  const baseOnly = base.workloads.filter((w) => !candWorkloadIds.has(w.id))
  const candOnly = cand.workloads.filter((w) => !baseWorkloadIds.has(w.id))

  let regressed = 0
  let improved = 0
  let unchanged = 0
  for (const c of comparisons) {
    if (!c.timing) continue
    if (c.timing.verdict === "regressed") regressed++
    else if (c.timing.verdict === "improved") improved++
    else unchanged++
  }

  const effectiveTimingPct = Math.max(
    thresholds.timingPct,
    base.environment?.noise.floorPct ?? 0,
    cand.environment?.noise.floorPct ?? 0,
  )

  return {
    comparisons,
    unmatched: { baseOnly, candOnly },
    summary: {
      matched: comparisons.length,
      regressed,
      improved,
      unchanged,
      geomeanPct: geomeanTimingPct(comparisons),
      effectiveTimingPct,
      verdict: comparisons.some((c) => c.verdict === "fail") ? "fail" : "pass",
    },
  }
}

export function compareWorkload(
  base: ProfileDocument,
  cand: ProfileDocument,
  workloadId: string,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Comparison | undefined {
  const baseTiming = measurementsFor(base, workloadId, "timing")
  const candTiming = measurementsFor(cand, workloadId, "timing")
  const baseCpu = measurementsFor(base, workloadId, "cpu")
  const candCpu = measurementsFor(cand, workloadId, "cpu")
  const baseHeap = measurementsFor(base, workloadId, "heap")
  const candHeap = measurementsFor(cand, workloadId, "heap")
  const candWorkload = cand.workloads.find((w) => w.id === workloadId)

  const baselineMeasurementId = baseTiming?.id ?? baseCpu?.id ?? baseHeap?.id
  // A task.skip()'d candidate has no measurement at all; fall back to its
  // workload id so this comparison can still say "skipped" instead of
  // either vanishing (compareDocuments would otherwise drop it) or being
  // silently absent.
  const candidateMeasurementId =
    candTiming?.id ?? candCpu?.id ?? candHeap?.id ?? candWorkload?.id
  if (!baselineMeasurementId || !candidateMeasurementId) return undefined

  let failed = false
  const warnings: Warning[] = []
  const environmentMismatch = environmentMismatchWarning(base, cand)
  if (environmentMismatch) warnings.push(environmentMismatch)
  const effectiveTimingPct = Math.max(
    thresholds.timingPct,
    base.environment?.noise.floorPct ?? 0,
    cand.environment?.noise.floorPct ?? 0,
  )

  let timing: Comparison["timing"]
  if (baseTiming?.timing && candWorkload?.skipped && !candTiming?.timing) {
    timing = {
      medianDeltaPct: 0,
      meanDeltaPct: 0,
      effectPct: 0,
      verdict: "unchanged",
    }
    warnings.push({
      code: "skipped",
      message:
        "Candidate has no timing measurement for this workload (task.skip()); treated as unchanged.",
      data: { workloadId },
    })
  } else if (baseTiming?.timing && candTiming?.timing) {
    const baseSamples = baseTiming.timing.samples
    const candSamples = candTiming.timing.samples
    const medianDeltaPct = pctDelta(
      baseTiming.timing.median,
      candTiming.timing.median,
    )
    const meanDeltaPct = pctDelta(
      baseTiming.timing.mean,
      candTiming.timing.mean,
    )

    const verdictFor = (
      low: number,
      high: number,
    ): NonNullable<Comparison["timing"]>["verdict"] => {
      if (low > effectiveTimingPct) return "regressed"
      if (high < -effectiveTimingPct) return "improved"
      return "unchanged"
    }

    if (
      baseSamples.length < MIN_SAMPLES_FOR_TEST ||
      candSamples.length < MIN_SAMPLES_FOR_TEST
    ) {
      const verdict = verdictFor(medianDeltaPct, medianDeltaPct)
      if (verdict === "regressed") failed = true
      timing = {
        medianDeltaPct,
        meanDeltaPct,
        effectPct: medianDeltaPct,
        verdict,
      }
      warnings.push({
        code: "thin-comparison",
        message: `Only ${baseSamples.length} baseline / ${candSamples.length} candidate sample(s); falling back to a point-estimate threshold instead of a bootstrap CI and Mann-Whitney test (needs ${MIN_SAMPLES_FOR_TEST}+ per side).`,
        data: {
          baseSamples: baseSamples.length,
          candSamples: candSamples.length,
        },
      })
    } else {
      const bootstrap = bootstrapMedianDiffCi(baseSamples, candSamples, {
        iterations: thresholds.bootstrapIterations,
      })
      const mw = mannWhitneyU(baseSamples, candSamples)
      const verdict =
        mw.pValue < thresholds.alpha
          ? verdictFor(bootstrap.ci95[0], bootstrap.ci95[1])
          : "unchanged"
      if (verdict === "regressed") failed = true
      timing = {
        medianDeltaPct,
        meanDeltaPct,
        effectPct: medianDeltaPct,
        ci95: bootstrap.ci95,
        pValue: mw.pValue,
        seed: bootstrap.seed,
        verdict,
      }
    }
  }

  let frames: Comparison["frames"]
  if (baseCpu?.cpu && candCpu?.cpu) {
    const baseByKey = new Map(
      baseCpu.cpu.totals.map((t) => [baseCpu.cpu!.frames[t.frameIx]!.key, t]),
    )
    const candByKey = new Map(
      candCpu.cpu.totals.map((t) => [candCpu.cpu!.frames[t.frameIx]!.key, t]),
    )
    const baseNameByKey = new Map(
      baseCpu.cpu.frames.map((f) => [f.key, f.name]),
    )
    const candNameByKey = new Map(
      candCpu.cpu.frames.map((f) => [f.key, f.name]),
    )
    const allKeys = new Set([...baseByKey.keys(), ...candByKey.keys()])

    frames = [...allKeys]
      .map((key) => {
        const baseSelfUs = baseByKey.get(key)?.selfUs ?? 0
        const candSelfUs = candByKey.get(key)?.selfUs ?? 0
        return {
          frameKey: key,
          name: candNameByKey.get(key) ?? baseNameByKey.get(key) ?? key,
          baseSelfUs,
          candSelfUs,
          deltaPct: pctDelta(baseSelfUs, candSelfUs),
        }
      })
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))

    for (const f of frames) {
      const aboveFloor =
        f.baseSelfUs >= thresholds.minFrameSelfUs ||
        f.candSelfUs >= thresholds.minFrameSelfUs
      if (aboveFloor && f.deltaPct > thresholds.frameSelfPct) failed = true
    }
  }

  let heapTypes: Comparison["heapTypes"]
  if (baseHeap?.heap && candHeap?.heap) {
    const baseByType = new Map(baseHeap.heap.typeCounts.map((t) => [t.type, t]))
    const candByType = new Map(candHeap.heap.typeCounts.map((t) => [t.type, t]))
    const allTypes = new Set([...baseByType.keys(), ...candByType.keys()])

    heapTypes = [...allTypes]
      .map((type) => {
        const b = baseByType.get(type)
        const c = candByType.get(type)
        return {
          type,
          baseCount: b?.count ?? 0,
          candCount: c?.count ?? 0,
          baseBytes: b?.retainedBytes,
          candBytes: c?.retainedBytes,
          deltaPct: pctDelta(b?.count ?? 0, c?.count ?? 0),
        }
      })
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))

    for (const h of heapTypes) {
      if (h.deltaPct > thresholds.heapTypePct) failed = true
    }
  }

  return {
    id: fp("cmp", baselineMeasurementId, candidateMeasurementId),
    baselineMeasurementId,
    candidateMeasurementId,
    timing,
    ...(warnings.length > 0 && { warnings }),
    frames,
    heapTypes,
    thresholds: { ...thresholds, effectiveTimingPct },
    verdict: failed ? "fail" : "pass",
  }
}
