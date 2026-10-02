import { rename, rm } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import { errorMessage } from "../errors.ts"
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
  PairedEvidence,
  Phase,
  ProfileDocument,
  TimingStats,
  Trial,
  Warning,
  Workload,
} from "./types.ts"

function definedFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Partial<T>
}

function measurementId(
  workloadId: string,
  phase: Phase,
  configFingerprint: string,
): string {
  return fp(
    "run",
    workloadId,
    phase,
    configFingerprint,
    Bun.version,
    TOOL_VERSION,
  )
}

export function createDocument(
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
    ...definedFields({ environment, git }),
  }
}

export interface SubprocessWorkloadOptions {
  prepare?: PrepareHook
  timeSource?: TimeSource
}

/** `prepare` and `timeSource` join the id only when given, so commands without
 * them keep their old id. A function `prepare` hashes by source text. The id
 * excludes `process.cwd()` so baselines match across checkouts. */
export function makeSubprocessWorkload(
  command: string[],
  label?: string,
  opts: SubprocessWorkloadOptions = {},
): Workload {
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
    ...definedFields({ prepare, timeSource }),
  }
}

/** Without `name` the id hashes the function's name and source, not the values
 * it closes over; `name` replaces both and is the label. */
export function makeInprocessWorkload(
  fn: (...args: unknown[]) => unknown,
  name?: string,
): Workload {
  const id =
    name === undefined
      ? fp("wl", "inprocess", fn.name, fn.toString())
      : fp("wl", "inprocess-named", name)
  return { id, kind: "inprocess", label: name }
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

/** The id hashes the file (cwd-relative, so checkouts match), `taskName` (the
 * registry's "group/name") and `params` when present; `params` joins only when
 * given so tasks without it keep their old id, and a `sweep()` reuses one task
 * name across points. Everything else is annotation and never orphans a baseline. */
export function makeEntryWorkload(
  file: string,
  taskName: string,
  opts: EntryWorkloadOptions = {},
): Workload {
  const idPath = isAbsolute(file) ? relative(process.cwd(), file) : file
  const id =
    opts.params !== undefined
      ? fp("wl", "inprocess-entry", idPath, taskName, opts.params)
      : fp("wl", "inprocess-entry", idPath, taskName)
  const { group, ...annotations } = opts
  return {
    id,
    kind: "inprocess",
    entry: { file, task: taskName, ...definedFields({ group }) },
    ...definedFields(annotations),
  }
}

export interface TimingMeasurementInput {
  workload: Workload
  configFingerprint: string
  trials: Trial[]
  /** Absent when no trial produced a sample (all timed out or missed the
   * `timeSource` pattern); renderers then skip the measurement. */
  timing?: TimingStats
  warnings: Warning[]
  interleaved?: boolean
}

export function makeTimingMeasurement(
  input: TimingMeasurementInput,
): Measurement {
  return {
    id: measurementId(input.workload.id, "timing", input.configFingerprint),
    workloadId: input.workload.id,
    phase: "timing",
    instrumented: false,
    configFingerprint: input.configFingerprint,
    trials: input.trials,
    timing: input.timing,
    warnings: input.warnings,
    artifacts: [],
    memory: memoryFromTrials(input.trials),
    ...definedFields({ interleaved: input.interleaved }),
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
  return {
    id: measurementId(input.workload.id, input.phase, input.configFingerprint),
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

export type PairedMeasurementInput = {
  workload: Workload
  configFingerprint: string
  diagnosticWallNs: number
  warnings: Warning[]
} & (
  | {
      /** The candidate side's per-call timing over the rounds. */
      timing: TimingStats
      paired: PairedEvidence
    }
  | {
      /** A task that threw, so wasn't timed. */
      threw: NonNullable<Measurement["threw"]>
    }
)

/** `timing` is the candidate side; `paired` holds the base side and the ratios. */
export function makePairedMeasurement(
  input: PairedMeasurementInput,
): Measurement {
  return {
    id: measurementId(input.workload.id, "paired", input.configFingerprint),
    workloadId: input.workload.id,
    phase: "paired",
    instrumented: false,
    configFingerprint: input.configFingerprint,
    trials: [],
    ...("threw" in input
      ? { threw: input.threw }
      : { timing: input.timing, paired: input.paired }),
    diagnosticWallNs: input.diagnosticWallNs,
    warnings: input.warnings,
    artifacts: [],
  }
}

export async function makeArtifactRef(
  ownerId: string,
  kind: ArtifactRef["kind"],
  path: string,
): Promise<ArtifactRef> {
  const buf = await Bun.file(path).arrayBuffer()
  return {
    id: fp("art", ownerId, kind, path),
    kind,
    path,
    sha256: Bun.CryptoHasher.hash("sha256", buf, "hex"),
    bytes: buf.byteLength,
  }
}

export function configFingerprint(opts: Record<string, unknown>): string {
  return fp("cfg", opts)
}

export function serializeDocument(doc: ProfileDocument): string {
  return `${canonicalJSON(doc, 2)}\n`
}

/** Writes to a unique temp file then renames, so a killed process never leaves
 * a truncated document at `path` and concurrent saves of one path don't share a
 * temp file. Takes serialized text so a caller that already has it can skip
 * `serializeDocument`. */
export async function saveDocumentText(
  text: string,
  path: string,
): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
  try {
    await Bun.write(tmpPath, text)
    await rename(tmpPath, path)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
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
    const cause = errorMessage(err)
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
  assertDocumentShape(raw as Record<string, unknown>, path)
  return renamePairedRatioFields(backfillTimingStats(raw as ProfileDocument))
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Cheap structural check, so a hand-edited or truncated document fails here
 * with a path and index instead of a TypeError deep in a renderer. */
function assertDocumentShape(doc: Record<string, unknown>, path: string): void {
  const bad = (what: string) =>
    new OstiaDocumentError(
      "not-a-document",
      `${path}: malformed document: ${what}`,
      {
        path,
      },
    )
  if (!Array.isArray(doc.workloads)) throw bad(`"workloads" must be an array`)
  if (!Array.isArray(doc.measurements)) {
    throw bad(`"measurements" must be an array`)
  }
  doc.workloads.forEach((w, i) => {
    if (!isObject(w) || typeof w.id !== "string") {
      throw bad(`workloads[${i}] must be an object with a string "id"`)
    }
  })
  doc.measurements.forEach((m, i) => {
    if (
      !isObject(m) ||
      typeof m.id !== "string" ||
      typeof m.workloadId !== "string" ||
      typeof m.phase !== "string"
    ) {
      throw bad(
        `measurements[${i}] must be an object with string "id", "workloadId" and "phase"`,
      )
    }
    for (const key of ["trials", "warnings", "artifacts"]) {
      if (!Array.isArray(m[key])) {
        throw bad(`measurements[${i}].${key} must be an array`)
      }
    }
  })
}

/** `ab` documents from ostia 0.2.8-0.2.9 name the ratio quartiles `p25`/`p75`,
 * now `ratioP25`/`ratioP75`; read the old names so saved documents still
 * render. */
function renamePairedRatioFields(doc: ProfileDocument): ProfileDocument {
  const rename = (r: Record<string, unknown>) => {
    if (r.ratioP25 !== undefined || r.p25 === undefined) return
    r.ratioP25 = r.p25
    r.ratioP75 = r.p75
    delete r.p25
    delete r.p75
  }
  for (const m of doc.measurements) {
    if (!m.paired) continue
    rename(m.paired as unknown as Record<string, unknown>)
    for (const r of m.paired.repeats ?? [])
      rename(r as unknown as Record<string, unknown>)
  }
  return doc
}

/** Documents from before ostia 0.2.4 lack `p25`/`p75`/`p99`/`mad`; recompute
 * them so every consumer sees the full `TimingStats`. */
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
