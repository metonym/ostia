import { fp, sortKeysDeep } from "./fp.ts"
import type {
  ArtifactRef,
  CpuEvidence,
  HeapEvidence,
  JitTierBreakdown,
  MemoryEvidence,
  Phase,
  ProfileDocument,
  Run,
  TimingStats,
  Trial,
  Warning,
  Workload,
} from "./types.ts"

export const TOOL_VERSION = "0.1.0"

export function newDocument(
  workloads: Workload[],
  runs: Run[],
): ProfileDocument {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    bunVersion: Bun.version,
    platform: { os: process.platform, arch: process.arch },
    createdAt: new Date().toISOString(),
    workloads,
    runs,
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
}

/** `taskName` is the registry's "group/name" id and is all the workload id
 * hashes over: descriptions, the explicit group field and the baseline flag are
 * annotations, so adding or editing them never orphans a saved baseline. */
export function makeEntryWorkload(
  file: string,
  taskName: string,
  opts: EntryWorkloadOptions = {},
): Workload {
  const id = fp("wl", "inprocess-entry", file, taskName)
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
  }
}

export interface TimingRunInput {
  workload: Workload
  configFingerprint: string
  trials: Trial[]
  timing: TimingStats
  warnings: Warning[]
}

export function makeTimingRun(input: TimingRunInput): Run {
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

export interface InstrumentedRunInput {
  workload: Workload
  phase: Extract<Phase, "cpu" | "heap">
  configFingerprint: string
  diagnosticWallNs: number
  exitCode?: number
  cpu?: CpuEvidence
  heap?: HeapEvidence
  jit?: JitTierBreakdown
  warnings: Warning[]
  artifacts: ArtifactRef[]
}

export function makeInstrumentedRun(input: InstrumentedRunInput): Run {
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
    jit: input.jit,
    warnings: input.warnings,
    artifacts: input.artifacts,
  }
}

export async function makeArtifactRef(
  runId: string,
  kind: ArtifactRef["kind"],
  path: string,
): Promise<ArtifactRef> {
  const file = Bun.file(path)
  const buf = await file.arrayBuffer()
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(buf)
  return {
    id: fp("art", runId, kind, path),
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

export async function loadDocument(path: string): Promise<ProfileDocument> {
  const text = await Bun.file(path).text()
  return JSON.parse(text) as ProfileDocument
}
