import { renameSync } from "node:fs"
import { isAbsolute, relative } from "node:path"
import {
  assertReusableTimeSource,
  type PrepareHook,
  prepareArgv,
  type TimeSource,
  timeSourceSpec,
} from "../spawn/index.ts"
import { computeTimingStats } from "../stats/index.ts"
import { TOOL_VERSION } from "../version.ts"
import { canonicalJSON, fp } from "./fp.ts"
import { captureGitMetadata } from "./git.ts"
import type {
  ArtifactRef,
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

export interface SubprocessWorkloadOptions {
  prepare?: PrepareHook
  timeSource?: TimeSource
}

/** `prepare` and `timeSource` join the id only when given, so commands
 * without them keep their pre-existing id (no orphaned baselines). A
 * function-form `prepare` hashes by its source text, like an in-process
 * workload does. The id deliberately excludes `process.cwd()`: it identifies
 * what is measured (command argv, prepare, timeSource), not where the
 * measuring process happened to run, so a baseline saved from a CI runner
 * matches a candidate measured in a developer's checkout or a different
 * worktree of the same repo. */
export function makeSubprocessWorkload(
  command: string[],
  label?: string,
  opts: SubprocessWorkloadOptions = {},
): Workload {
  // Fails fast, once per workload, before any trial runs - not once per
  // trial deep inside the sampling loop.
  if (opts.timeSource) assertReusableTimeSource(opts.timeSource)
  const prepare = prepareArgv(opts.prepare)
  const timeSource = timeSourceSpec(opts.timeSource)
  const prepareKey =
    typeof opts.prepare === "function" ? opts.prepare.toString() : prepare
  const id = fp(
    "wl",
    "subprocess",
    command,
    ...(prepareKey !== undefined || timeSource !== undefined
      ? [prepareKey ?? null, timeSource ?? null]
      : []),
  )
  return {
    id,
    kind: "subprocess",
    command,
    label,
    ...(prepare !== undefined && { prepare }),
    ...(timeSource !== undefined && { timeSource }),
  }
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
  // Hashed relative to the cwd, like a subprocess workload's id leaves out
  // its cwd: a baseline saved from one checkout (a CI runner, another
  // worktree) still matches a candidate measured from another.
  const idPath = isAbsolute(file) ? relative(process.cwd(), file) : file
  const id =
    opts.params !== undefined
      ? fp("wl", "inprocess-entry", idPath, taskName, opts.params)
      : fp("wl", "inprocess-entry", idPath, taskName)
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
  /** Absent when every trial was excluded from sampling (e.g. every trial
   * timed out or, with a `timeSource`, missed the pattern): the measurement
   * still records the attempt (trials, warnings) but has no timing stats,
   * and renderers skip it like a skipped workload. */
  timing?: TimingStats
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
  return `${canonicalJSON(doc, 2)}\n`
}

/** Writes `text` to `${path}.tmp-${pid}` then renames over `path`, so a
 * process killed mid-write (e.g. `ci --save-baseline`) never leaves a
 * truncated document at `path` - the rename is the only step that touches
 * it, and that step is atomic. Split out from `saveDocument` so a caller
 * that already has the serialized text on hand (e.g. the CLI's `--format
 * json` alongside `--export-json`) can reuse it instead of paying for
 * `serializeDocument` a second time. */
export async function saveDocumentText(
  text: string,
  path: string,
): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}`
  await Bun.write(tmpPath, text)
  renameSync(tmpPath, path)
}

export async function saveDocument(
  doc: ProfileDocument,
  path: string,
): Promise<void> {
  await saveDocumentText(serializeDocument(doc), path)
}

export class OstiaDocumentError extends Error {
  readonly code: "invalid-json" | "not-a-document" | "unsupported-schema"
  readonly path?: string
  readonly schemaVersion?: unknown

  constructor(
    code: OstiaDocumentError["code"],
    message: string,
    opts: { path?: string; schemaVersion?: unknown } = {},
  ) {
    super(message)
    this.name = "OstiaDocumentError"
    this.code = code
    this.path = opts.path
    this.schemaVersion = opts.schemaVersion
  }
}

export async function loadDocument(path: string): Promise<ProfileDocument> {
  const text = await Bun.file(path).text()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new OstiaDocumentError(
      "invalid-json",
      `${path}: invalid JSON (${cause})`,
      { path },
    )
  }
  const schemaVersion =
    raw !== null && typeof raw === "object"
      ? (raw as { schemaVersion?: unknown }).schemaVersion
      : undefined
  if (typeof schemaVersion !== "number") {
    throw new OstiaDocumentError(
      "not-a-document",
      `${path}: not a ProfileDocument (missing schemaVersion)`,
      { path },
    )
  }
  if (schemaVersion !== 2) {
    throw new OstiaDocumentError(
      "unsupported-schema",
      `${path}: unsupported ProfileDocument schemaVersion ${schemaVersion} (this ostia reads 2)`,
      { path, schemaVersion },
    )
  }
  return backfillTimingStats(raw as ProfileDocument)
}

/** Documents saved before ostia 0.2.4 lack `p25`/`p75`/`p99`/`mad`: recompute
 * them from the stored samples here, once, so every consumer can rely on the
 * full `TimingStats` shape instead of each renderer carrying fallbacks. */
function backfillTimingStats(doc: ProfileDocument): ProfileDocument {
  for (const m of doc.measurements) {
    const t = m.timing
    if (!t || t.mad !== undefined || t.samples.length === 0) continue
    m.timing = {
      ...computeTimingStats(t.samples),
      ...(t.batch !== undefined && { batch: t.batch }),
    }
  }
  return doc
}
