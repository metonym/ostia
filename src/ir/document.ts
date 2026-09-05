import { fp, sortKeysDeep } from "./fp.ts"
import { captureGitMetadata } from "./git.ts"
import type {
  ArtifactRef,
  Comparison,
  CpuEvidence,
  Environment,
  HeapEvidence,
  JitTierBreakdown,
  Measurement,
  MemoryEvidence,
  Phase,
  ProfileDocument,
  TimingStats,
  Trial,
  Warning,
  Workload,
} from "./types.ts"

export const TOOL_VERSION = "0.1.0"

export function newDocument(
  workloads: Workload[],
  measurements: Measurement[],
  environment?: Environment,
): ProfileDocument {
  const git = captureGitMetadata()
  return {
    schemaVersion: 2,
    toolVersion: TOOL_VERSION,
    bunVersion: Bun.version,
    platform: { os: process.platform, arch: process.arch },
    createdAt: new Date().toISOString(),
    workloads,
    measurements,
    ...(environment !== undefined && { environment }),
    ...(git !== undefined && { git }),
  }
}

export function makeSubprocessWorkload(
  command: string[],
  label?: string,
): Workload {
  const id = fp("wl", "subprocess", command, process.cwd())
  return { id, kind: "subprocess", command, label }
}

export function makeInprocessWorkload(
  fn: (...args: unknown[]) => unknown,
  label?: string,
): Workload {
  const id = fp("wl", "inprocess", fn.name, fn.toString())
  return { id, kind: "inprocess", label }
}

export interface EntryWorkloadOptions {
  label?: string
  baseline?: boolean
  group?: string
  description?: string
  groupDescription?: string
  isolated?: boolean
  params?: Record<string, string | number | boolean>
  skipped?: boolean
}

/** `taskName` is the registry's "group/name" id and, together with `params`
 * when present, is all the workload id hashes over: descriptions, the
 * explicit group field and the baseline flag are annotations, so adding or
 * editing them never orphans a saved baseline. `params` must be part of the
 * id (only when given, so tasks without it keep their pre-existing id) since
 * a `sweep()` point reuses one task name across every point in the sweep. */
export function makeEntryWorkload(
  file: string,
  taskName: string,
  opts: EntryWorkloadOptions = {},
): Workload {
  const id =
    opts.params !== undefined
      ? fp("wl", "inprocess-entry", file, taskName, opts.params)
      : fp("wl", "inprocess-entry", file, taskName)
  return {
    id,
    kind: "inprocess",
    entry: {
      file,
      task: taskName,
      ...(opts.group !== undefined && { group: opts.group }),
    },
    ...(opts.label !== undefined && { label: opts.label }),
    ...(opts.baseline !== undefined && { baseline: opts.baseline }),
    ...(opts.description !== undefined && { description: opts.description }),
    ...(opts.groupDescription !== undefined && {
      groupDescription: opts.groupDescription,
    }),
    ...(opts.isolated !== undefined && { isolated: opts.isolated }),
    ...(opts.params !== undefined && { params: opts.params }),
    ...(opts.skipped !== undefined && { skipped: opts.skipped }),
  }
}

export interface TimingMeasurementInput {
  workload: Workload
  configFingerprint: string
  trials: Trial[]
  timing: TimingStats
  warnings: Warning[]
  interleaved?: boolean
}

export function makeTimingMeasurement(
  input: TimingMeasurementInput,
): Measurement {
  const id = fp(
    "run",
    input.workload.id,
    "timing",
    input.configFingerprint,
    Bun.version,
    TOOL_VERSION,
  )
  return {
    id,
    workloadId: input.workload.id,
    phase: "timing",
    instrumented: false,
    configFingerprint: input.configFingerprint,
    trials: input.trials,
    timing: input.timing,
    warnings: input.warnings,
    artifacts: [],
    memory: memoryFromTrials(input.trials),
    ...(input.interleaved !== undefined && { interleaved: input.interleaved }),
  }
}

function memoryFromTrials(trials: Trial[]): MemoryEvidence | undefined {
  const rss = trials
    .map((t) => t.maxRssBytes)
    .filter((v): v is number => v !== undefined)
  if (rss.length === 0) return undefined
  return {
    origin: "resourceUsage",
    perTrial: trials.map((t) => ({ rssBytes: t.maxRssBytes })),
    maxRssBytes: Math.max(...rss),
  }
}

export interface InstrumentedMeasurementInput {
  workload: Workload
  phase: Extract<Phase, "cpu" | "heap" | "memstats">
  configFingerprint: string
  diagnosticWallNs: number
  exitCode?: number
  cpu?: CpuEvidence
  heap?: HeapEvidence
  memory?: MemoryEvidence
  jit?: JitTierBreakdown
  warnings: Warning[]
  artifacts: ArtifactRef[]
}

export function makeInstrumentedMeasurement(
  input: InstrumentedMeasurementInput,
): Measurement {
  const id = fp(
    "run",
    input.workload.id,
    input.phase,
    input.configFingerprint,
    Bun.version,
    TOOL_VERSION,
  )
  return {
    id,
    workloadId: input.workload.id,
    phase: input.phase,
    instrumented: true,
    configFingerprint: input.configFingerprint,
    trials: [
      { i: 0, wallNs: input.diagnosticWallNs, exitCode: input.exitCode },
    ],
    diagnosticWallNs: input.diagnosticWallNs,
    cpu: input.cpu,
    heap: input.heap,
    memory: input.memory,
    jit: input.jit,
    warnings: input.warnings,
    artifacts: input.artifacts,
  }
}

export async function makeArtifactRef(
  measurementId: string,
  kind: ArtifactRef["kind"],
  path: string,
): Promise<ArtifactRef> {
  const file = Bun.file(path)
  const buf = await file.arrayBuffer()
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(buf)
  return {
    id: fp("art", measurementId, kind, path),
    kind,
    path,
    sha256: hasher.digest("hex"),
    bytes: buf.byteLength,
  }
}

export function configFingerprint(opts: Record<string, unknown>): string {
  return fp("cfg", opts)
}

export function serializeDocument(doc: ProfileDocument): string {
  return `${JSON.stringify(sortKeysDeep(doc), null, 2)}\n`
}

export async function saveDocument(
  doc: ProfileDocument,
  path: string,
): Promise<void> {
  await Bun.write(path, serializeDocument(doc))
}

interface ProfileDocumentV1 {
  schemaVersion: 1
  toolVersion: string
  bunVersion: string
  platform: { os: string; arch: string }
  createdAt: string
  workloads: Workload[]
  runs: (Omit<Measurement, "baselineMeasurementId"> & {
    baselineRunId?: string
  })[]
  comparisons?: (Omit<
    Comparison,
    "baselineMeasurementId" | "candidateMeasurementId"
  > & {
    baselineRunId: string
    candidateRunId: string
  })[]
}

/** Upgrades a v1 document (schemaVersion 1: `runs`, `Comparison.baselineRunId`
 * / `candidateRunId`) to the current v2 shape in memory, so a baseline saved
 * before the `Run` -> `Measurement` rename still loads. */
function upgradeDocument(
  raw: ProfileDocumentV1 | ProfileDocument,
): ProfileDocument {
  if (raw.schemaVersion === 2) return raw
  const { runs, comparisons, ...rest } = raw
  return {
    ...rest,
    schemaVersion: 2,
    measurements: runs.map(({ baselineRunId, ...m }) => ({
      ...m,
      ...(baselineRunId !== undefined && {
        baselineMeasurementId: baselineRunId,
      }),
    })),
    ...(comparisons !== undefined && {
      comparisons: comparisons.map(
        ({ baselineRunId, candidateRunId, ...c }) => ({
          ...c,
          baselineMeasurementId: baselineRunId,
          candidateMeasurementId: candidateRunId,
        }),
      ),
    }),
  }
}

export async function loadDocument(path: string): Promise<ProfileDocument> {
  const text = await Bun.file(path).text()
  const raw = JSON.parse(text) as ProfileDocumentV1 | ProfileDocument
  return upgradeDocument(raw)
}
