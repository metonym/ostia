import { fp } from "../ir/fp.ts"
import type {
  Comparison,
  Measurement,
  ProfileDocument,
  Warning,
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

export function compareDocuments(
  base: ProfileDocument,
  cand: ProfileDocument,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Comparison[] {
  const candWorkloadIds = new Set(cand.workloads.map((w) => w.id))
  const comparisons: Comparison[] = []
  for (const workload of base.workloads) {
    if (!candWorkloadIds.has(workload.id)) continue
    const comparison = compareWorkload(base, cand, workload.id, thresholds)
    if (comparison) comparisons.push(comparison)
  }
  return comparisons
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

  const baselineMeasurementId = baseTiming?.id ?? baseCpu?.id ?? baseHeap?.id
  const candidateMeasurementId = candTiming?.id ?? candCpu?.id ?? candHeap?.id
  if (!baselineMeasurementId || !candidateMeasurementId) return undefined

  let failed = false
  const warnings: Warning[] = []
  const effectiveTimingPct = Math.max(
    thresholds.timingPct,
    base.environment?.noise.floorPct ?? 0,
    cand.environment?.noise.floorPct ?? 0,
  )

  let timing: Comparison["timing"]
  if (baseTiming?.timing && candTiming?.timing) {
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

    if (
      baseSamples.length < MIN_SAMPLES_FOR_TEST ||
      candSamples.length < MIN_SAMPLES_FOR_TEST
    ) {
      const verdict =
        medianDeltaPct > effectiveTimingPct
          ? "regressed"
          : medianDeltaPct < -effectiveTimingPct
            ? "improved"
            : "unchanged"
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
        bootstrap.ci95[0] > effectiveTimingPct && mw.pValue < thresholds.alpha
          ? "regressed"
          : bootstrap.ci95[1] < -effectiveTimingPct &&
              mw.pValue < thresholds.alpha
            ? "improved"
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
