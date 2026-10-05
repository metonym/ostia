import { fp } from "../ir/fp.ts"
import type {
  Comparison,
  ComparisonSummary,
  Measurement,
  ProfileDocument,
  TimingStats,
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
  /** A `regressed` / `improved` verdict also requires Mann-Whitney `pValue < alpha`. */
  alpha: number
  /** Bootstrap resample rounds for the timing CI. */
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

/** Below this many samples on either side, fall back to the point-estimate
 * rule (with a `thin-comparison` warning): CI and p-value are too noisy. */
const MIN_SAMPLES_FOR_TEST = 5

function pctDelta(base: number, cand: number): number {
  if (base === 0) return cand === 0 ? 0 : Infinity
  return ((cand - base) / base) * 100
}

type Phase = "timing" | "cpu" | "heap"

type Lookup = (workloadId: string, phase: Phase) => Measurement | undefined

/** Built once per pair instead of re-scanning both documents per workload. */
interface CompareIndex {
  base: Lookup
  cand: Lookup
  candWorkloads: Map<string, Workload>
  environmentMismatch: Warning | undefined
  effectiveTimingPct: number
}

function indexMeasurements(doc: ProfileDocument): Lookup {
  const byPhase = new Map<string, Measurement>()
  for (const m of doc.measurements) {
    const key = `${m.workloadId}\u0000${m.phase}`
    if (!byPhase.has(key)) byPhase.set(key, m)
  }
  return (workloadId: string, phase: Phase) =>
    byPhase.get(`${workloadId}\u0000${phase}`)
}

function buildIndex(
  base: ProfileDocument,
  cand: ProfileDocument,
  thresholds: Thresholds,
): CompareIndex {
  return {
    base: indexMeasurements(base),
    cand: indexMeasurements(cand),
    candWorkloads: new Map(cand.workloads.map((w) => [w.id, w])),
    environmentMismatch: environmentMismatchWarning(base, cand),
    effectiveTimingPct: Math.max(
      thresholds.timingPct,
      base.environment?.noise.floorPct ?? 0,
      cand.environment?.noise.floorPct ?? 0,
    ),
  }
}

/** Same warning for every comparison in a pair measured on different
 * machines/Bun versions. `cpuModel`/`cores` are compared only when both sides
 * have `environment`: missing data is unknown, not a mismatch. */
function environmentMismatchWarning(
  base: ProfileDocument,
  cand: ProfileDocument,
): Warning | undefined {
  const candidates: [string, string | number, string | number][] = [
    ["platform.os", base.platform.os, cand.platform.os],
    ["platform.arch", base.platform.arch, cand.platform.arch],
    ["bunVersion", base.bunVersion, cand.bunVersion],
  ]
  if (base.environment && cand.environment) {
    candidates.push(
      ["cpuModel", base.environment.cpuModel, cand.environment.cpuModel],
      ["cores", base.environment.cores, cand.environment.cores],
    )
  }
  const fields = candidates
    .filter(([, b, c]) => b !== c)
    .map(([field, b, c]) => ({ field, base: b, cand: c }))
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

/** Geometric mean of `cand/base` median ratios over comparisons with a
 * timing verdict, as a signed percent (`-4.2` means ~4.2% faster). `null`
 * when none has a finite ratio. */
function geomeanTimingPct(comparisons: Comparison[]): number | null {
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

/** A base/candidate pair indexed once: per-workload comparison plus the
 * pair-level facts `compareDocuments` and `ostia ci` both need. */
export interface Comparer {
  effectiveTimingPct: number
  compare(workloadId: string): Comparison | undefined
  unmatched(): { baseOnly: Workload[]; candOnly: Workload[] }
}

export function createComparer(
  base: ProfileDocument,
  cand: ProfileDocument,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Comparer {
  const index = buildIndex(base, cand, thresholds)
  return {
    effectiveTimingPct: index.effectiveTimingPct,
    compare: (workloadId) => compareIndexed(index, workloadId, thresholds),
    unmatched() {
      const baseIds = new Set(base.workloads.map((w) => w.id))
      return {
        baseOnly: base.workloads.filter((w) => !index.candWorkloads.has(w.id)),
        candOnly: cand.workloads.filter((w) => !baseIds.has(w.id)),
      }
    },
  }
}

/** The `comparisonSummary` stamped on a compared document. */
export function summarizeComparisons(
  comparisons: Comparison[],
  effectiveTimingPct: number,
): ComparisonSummary {
  let regressed = 0
  let improved = 0
  let unchanged = 0
  for (const c of comparisons) {
    if (!c.timing) continue
    if (c.timing.verdict === "regressed") regressed++
    else if (c.timing.verdict === "improved") improved++
    else unchanged++
  }
  return {
    matched: comparisons.length,
    regressed,
    improved,
    unchanged,
    geomeanPct: geomeanTimingPct(comparisons),
    effectiveTimingPct,
    verdict: comparisons.some((c) => c.verdict === "fail") ? "fail" : "pass",
  }
}

/** Compares every `cand.workloads` entry that has a match in `base` (in
 * candidate order, as `ostia ci` does), and reports what matched only one side
 * in `unmatched` rather than dropping it. */
export function compareDocuments(
  base: ProfileDocument,
  cand: ProfileDocument,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): CompareResult {
  const comparer = createComparer(base, cand, thresholds)
  const comparisons: Comparison[] = []
  for (const workload of cand.workloads) {
    const comparison = comparer.compare(workload.id)
    if (comparison) comparisons.push(comparison)
  }
  return {
    comparisons,
    unmatched: comparer.unmatched(),
    summary: summarizeComparisons(comparisons, comparer.effectiveTimingPct),
  }
}

export function compareWorkload(
  base: ProfileDocument,
  cand: ProfileDocument,
  workloadId: string,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Comparison | undefined {
  return createComparer(base, cand, thresholds).compare(workloadId)
}

type TimingComparison = NonNullable<Comparison["timing"]>

function compareTiming(
  baseTiming: TimingStats,
  candTiming: TimingStats,
  effectiveTimingPct: number,
  thresholds: Thresholds,
): { timing: TimingComparison; warning?: Warning } {
  const baseSamples = baseTiming.samples
  const candSamples = candTiming.samples
  const medianDeltaPct = pctDelta(baseTiming.median, candTiming.median)
  const meanDeltaPct = pctDelta(baseTiming.mean, candTiming.mean)

  const verdictFor = (
    low: number,
    high: number,
  ): TimingComparison["verdict"] => {
    if (low > effectiveTimingPct) return "regressed"
    if (high < -effectiveTimingPct) return "improved"
    return "unchanged"
  }

  if (
    baseSamples.length < MIN_SAMPLES_FOR_TEST ||
    candSamples.length < MIN_SAMPLES_FOR_TEST
  ) {
    return {
      timing: {
        medianDeltaPct,
        meanDeltaPct,
        verdict: verdictFor(medianDeltaPct, medianDeltaPct),
      },
      warning: {
        code: "thin-comparison",
        message: `Only ${baseSamples.length} baseline / ${candSamples.length} candidate sample(s); falling back to a point-estimate threshold instead of a bootstrap CI and Mann-Whitney test (needs ${MIN_SAMPLES_FOR_TEST}+ per side).`,
        data: {
          baseSamples: baseSamples.length,
          candSamples: candSamples.length,
        },
      },
    }
  }

  const bootstrap = bootstrapMedianDiffCi(baseSamples, candSamples, {
    iterations: thresholds.bootstrapIterations,
  })
  const mw = mannWhitneyU(baseSamples, candSamples)
  return {
    timing: {
      medianDeltaPct,
      meanDeltaPct,
      ci95: bootstrap.ci95,
      pValue: mw.pValue,
      seed: bootstrap.seed,
      verdict:
        mw.pValue < thresholds.alpha
          ? verdictFor(bootstrap.ci95[0], bootstrap.ci95[1])
          : "unchanged",
    },
  }
}

function compareFrames(
  baseCpu: NonNullable<Measurement["cpu"]>,
  candCpu: NonNullable<Measurement["cpu"]>,
  thresholds: Thresholds,
): { frames: NonNullable<Comparison["frames"]>; failed: boolean } {
  const selfUsByKey = (cpu: typeof baseCpu) =>
    new Map(cpu.totals.map((t) => [cpu.frames[t.frameIx]!.key, t.selfUs]))
  const nameByKey = (cpu: typeof baseCpu) =>
    new Map(cpu.frames.map((f) => [f.key, f.name]))
  const baseSelf = selfUsByKey(baseCpu)
  const candSelf = selfUsByKey(candCpu)
  const baseNames = nameByKey(baseCpu)
  const candNames = nameByKey(candCpu)

  const frames = [...new Set([...baseSelf.keys(), ...candSelf.keys()])]
    .map((key) => {
      const baseSelfUs = baseSelf.get(key) ?? 0
      const candSelfUs = candSelf.get(key) ?? 0
      return {
        frameKey: key,
        name: candNames.get(key) ?? baseNames.get(key) ?? key,
        baseSelfUs,
        candSelfUs,
        deltaPct: pctDelta(baseSelfUs, candSelfUs),
      }
    })
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))

  const failed = frames.some(
    (f) =>
      (f.baseSelfUs >= thresholds.minFrameSelfUs ||
        f.candSelfUs >= thresholds.minFrameSelfUs) &&
      f.deltaPct > thresholds.frameSelfPct,
  )
  return { frames, failed }
}

// Gated on object count only: `retainedBytes` is carried on each row for
// display, never compared against a threshold.
function compareHeapTypes(
  baseHeap: NonNullable<Measurement["heap"]>,
  candHeap: NonNullable<Measurement["heap"]>,
  thresholds: Thresholds,
): { heapTypes: NonNullable<Comparison["heapTypes"]>; failed: boolean } {
  const baseByType = new Map(baseHeap.typeCounts.map((t) => [t.type, t]))
  const candByType = new Map(candHeap.typeCounts.map((t) => [t.type, t]))

  const heapTypes = [...new Set([...baseByType.keys(), ...candByType.keys()])]
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

  return {
    heapTypes,
    failed: heapTypes.some((h) => h.deltaPct > thresholds.heapTypePct),
  }
}

function compareIndexed(
  index: CompareIndex,
  workloadId: string,
  thresholds: Thresholds,
): Comparison | undefined {
  const { effectiveTimingPct } = index
  const baseTiming = index.base(workloadId, "timing")
  const candTiming = index.cand(workloadId, "timing")
  const baseCpu = index.base(workloadId, "cpu")
  const candCpu = index.cand(workloadId, "cpu")
  const baseHeap = index.base(workloadId, "heap")
  const candHeap = index.cand(workloadId, "heap")
  const candWorkload = index.candWorkloads.get(workloadId)

  const baselineMeasurementId = baseTiming?.id ?? baseCpu?.id ?? baseHeap?.id
  // A task.skip()'d candidate has no measurement; its workload id lets the
  // comparison say "skipped" instead of vanishing.
  const candidateMeasurementId =
    candTiming?.id ?? candCpu?.id ?? candHeap?.id ?? candWorkload?.id
  if (!baselineMeasurementId || !candidateMeasurementId) return undefined

  let failed = false
  const warnings: Warning[] = []
  if (index.environmentMismatch) warnings.push(index.environmentMismatch)

  let timing: Comparison["timing"]
  if (baseTiming?.timing && candWorkload?.skipped && !candTiming?.timing) {
    timing = { medianDeltaPct: 0, meanDeltaPct: 0, verdict: "unchanged" }
    warnings.push({
      code: "skipped",
      message:
        "Candidate has no timing measurement for this workload (task.skip()); treated as unchanged.",
      data: { workloadId },
    })
  } else if (baseTiming?.timing && candTiming?.timing) {
    const result = compareTiming(
      baseTiming.timing,
      candTiming.timing,
      effectiveTimingPct,
      thresholds,
    )
    timing = result.timing
    if (result.warning) warnings.push(result.warning)
    if (timing.verdict === "regressed") failed = true
  }

  let frames: Comparison["frames"]
  if (baseCpu?.cpu && candCpu?.cpu) {
    const result = compareFrames(baseCpu.cpu, candCpu.cpu, thresholds)
    frames = result.frames
    failed ||= result.failed
  }

  let heapTypes: Comparison["heapTypes"]
  if (baseHeap?.heap && candHeap?.heap) {
    const result = compareHeapTypes(baseHeap.heap, candHeap.heap, thresholds)
    heapTypes = result.heapTypes
    failed ||= result.failed
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
