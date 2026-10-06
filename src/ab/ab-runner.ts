#!/usr/bin/env bun

import {
  filterTasks,
  getRegisteredTasks,
  groupEdges,
  type RegisteredTask,
  resetRegistry,
  runGroupHooks,
  selectTasks,
  taskAlloc,
  taskId,
  taskPeakMem,
} from "../bench/registry.ts"
import { taskWorkload } from "../bench/run-tasks.ts"
import { median } from "../bench/support.ts"
import {
  configFingerprint,
  createDocument,
  makePairedMeasurement,
  saveDocument,
} from "../ir/document.ts"
import { canonicalJSON } from "../ir/fp.ts"
import type { Measurement, Workload } from "../ir/types.ts"
import { measureAllocPerOp } from "../measure/alloc.ts"
import {
  measurePaired,
  PairedSideError,
  ratioStats,
  sideLabel,
} from "../measure/paired.ts"
import {
  measurePeakMem,
  memorySnapshot,
  type PeakMemResult,
  startRssSampler,
} from "../measure/peak.ts"
import { computeTimingStats } from "../stats/index.ts"

export interface AbRunnerOpts {
  /** Regex matched against "group/name" task ids. */
  filter?: string
  /** Measure only these workloads (a fresh-process repeat of flagged ones). */
  workloadIds?: string[]
  rounds: number
  thresholdPct: number
  /** Scripts imported, in order, before either suite. */
  preload?: string[]
  /** Send an `AbRunnerProgress` message over IPC before each task. */
  progress?: boolean
  /** Suite-wide defaults for the memory readings in `planPath` (task/group
   * options win). */
  alloc?: boolean
  peakMem?: boolean
  /** Write an `AbRunnerPlan` here. */
  planPath?: string
  /** Instead of timing: take this task's memory readings on one side and
   * write an `AbMemoryResult` to the output path. */
  memoryFor?: AbMemoryTask & { side: Side }
}

/** A paired task and the memory readings it wants. */
export interface AbMemoryTask {
  workloadId: string
  alloc: boolean
  peakMem: boolean
}

export interface AbRunnerPlan {
  memory: AbMemoryTask[]
}

/** One side's memory readings from one fresh process. */
export interface AbMemoryResult {
  peak?: PeakMemResult
  alloc?: { bytesPerOp: number; calls: number }
}

/** Sent to the parent before each task is measured, when `progress` is
 * set. `task` counts from 1. */
export interface AbRunnerProgress {
  task: number
  tasks: number
  label: string
}

/** Tasks pair across sides by "group/name" plus `params`, the workload id's identity. */
function pairKey(t: RegisteredTask): string {
  return `${taskId(t)}\u0000${canonicalJSON(t.params ?? null)}`
}

async function importTasks(suiteFile: string): Promise<RegisteredTask[]> {
  resetRegistry()
  await import(suiteFile)
  return [...getRegisteredTasks()]
}

const ERROR_LINES = 5

/** An error's message, cut to its first few lines. */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.split("\n").slice(0, ERROR_LINES).join("\n")
}

/** Reports a failure that stops the whole suite: on stderr, and in
 * `<outputPath>.error` for `ab()` to put in the error it throws. */
async function fail(outputPath: string, message: string): Promise<number> {
  process.stderr.write(`ab runner: ${message}\n`)
  await Bun.write(`${outputPath}.error`, message)
  return 2
}

type Side = "base" | "cand"

type MeasureOutcome =
  | { result: Awaited<ReturnType<typeof measurePaired>> }
  | { threw: NonNullable<Measurement["threw"]> }

/** One pair's `before` hooks, paired timing and `after` hooks. A throw from
 * either side's task or hooks doesn't stop the suite; it's reported with
 * its side instead. Each `before` runs once, and a side whose `before`
 * threw isn't timed or torn down. Every side that was set up is torn down
 * exactly once, candidate first, even when a hook throws. When only one
 * side has thrown, the other side's task is called once more, before
 * teardown and only if that side is set up, to tell whether it throws too
 * (`"both"`). */
async function measureTask(
  base: RegisteredTask,
  cand: RegisteredTask,
  rounds: number,
): Promise<MeasureOutcome> {
  const tasks = { base, cand }
  // The first error from each side.
  const errors = new Map<Side, unknown>()
  const record = (side: Side, err: unknown) => {
    if (!errors.has(side)) errors.set(side, err)
  }
  const ready = new Set<Side>()
  for (const side of ["base", "cand"] as const) {
    try {
      await tasks[side].opts?.before?.()
      ready.add(side)
    } catch (err) {
      record(side, err)
    }
  }

  let result: Awaited<ReturnType<typeof measurePaired>> | undefined
  let internal: { err: unknown } | undefined
  if (ready.size === 2) {
    try {
      result = await measurePaired(base.fn, cand.fn, { rounds })
    } catch (err) {
      if (err instanceof PairedSideError) record(err.side, err.cause)
      else internal = { err }
    }
  }

  if (errors.size === 1) {
    const other: Side = errors.has("base") ? "cand" : "base"
    if (ready.has(other)) {
      try {
        await tasks[other].fn()
      } catch (err) {
        record(other, err)
      }
    }
  }

  for (const side of ["cand", "base"] as const) {
    if (!ready.has(side)) continue
    try {
      await tasks[side].opts?.after?.()
    } catch (err) {
      record(side, err)
    }
  }

  if (internal) throw internal.err
  const baseErr = errors.get("base")
  const candErr = errors.get("cand")
  if (errors.size === 2) {
    return {
      threw: {
        side: "both",
        message: `base: ${errorText(baseErr)}\ncandidate: ${errorText(candErr)}`,
      },
    }
  }
  if (errors.has("base")) {
    return { threw: { side: "base", message: errorText(baseErr) } }
  }
  if (errors.has("cand")) {
    return { threw: { side: "cand", message: errorText(candErr) } }
  }
  return { result: result! }
}

/** A `memoryFor` process. Only one side's suite loads, so the other side's
 * setup and the packages both sides share can't move the readings. Peak is
 * the first call; retained follows a warmup batch, as `bench --alloc`
 * follows timing. */
async function measureMemory(
  suite: string,
  candSuite: string,
  outputPath: string,
  memoryFor: NonNullable<AbRunnerOpts["memoryFor"]>,
  preload: string[],
): Promise<number> {
  const { workloadId, side } = memoryFor
  // Baseline for `measurePeakMem`, taken once ostia (which the suite
  // imports) is loaded.
  const sampler = memoryFor.peakMem ? await startRssSampler() : undefined
  await import("../index.ts")
  const launched = memorySnapshot()
  let t: RegisteredTask | undefined
  try {
    for (const preloadFile of preload) await import(preloadFile)
    t = (await importTasks(suite)).find(
      (t) => taskWorkload(candSuite, t).id === workloadId,
    )
  } catch (err) {
    return fail(
      outputPath,
      `the ${sideLabel(side)} side failed to load ${suite}: ${errorText(err)}`,
    )
  }
  if (!t) {
    return fail(
      outputPath,
      `no task with workload id ${workloadId} in ${suite}.`,
    )
  }
  try {
    const result: AbMemoryResult = {}
    await runGroupHooks(t, "before")
    await t.opts?.before?.()
    if (sampler) result.peak = await measurePeakMem(t.fn, launched, sampler)
    if (memoryFor.alloc) {
      await measureAllocPerOp(t.fn)
      const { memory, calls } = await measureAllocPerOp(t.fn)
      result.alloc = { bytesPerOp: memory.bytesPerOp!, calls }
    }
    await t.opts?.after?.()
    await runGroupHooks(t, "after")
    await Bun.write(outputPath, JSON.stringify(result))
    return 0
  } catch (err) {
    return fail(
      outputPath,
      `${taskId(t)} threw on the ${sideLabel(side)} side while measuring memory: ${errorText(err)}`,
    )
  }
}

/** Pairs one suite file's tasks against the same file at the base checkout,
 * in this process. Each side is imported from its own path so its relative
 * imports resolve within its own tree, while bare imports (including `ostia`,
 * hence the shared registry) share `node_modules`. `baseSuite` is "" when
 * the file doesn't exist at the base ref: every task is candidate-only. */
async function main(): Promise<number> {
  const [candSuite, baseSuite, outputPath, optsJson] = process.argv.slice(2)
  if (!candSuite || baseSuite === undefined || !outputPath || !optsJson) {
    process.stderr.write(
      "ab runner: usage: ab-runner.ts <candSuite> <baseSuite|''> <outputPath> <optsJson>\n",
    )
    return 2
  }
  const opts: AbRunnerOpts = JSON.parse(optsJson)

  if (opts.memoryFor) {
    return measureMemory(
      opts.memoryFor.side === "base" ? baseSuite : candSuite,
      candSuite,
      outputPath,
      opts.memoryFor,
      opts.preload ?? [],
    )
  }

  for (const preloadFile of opts.preload ?? []) {
    await import(preloadFile)
  }

  let baseTasks: RegisteredTask[] = []
  if (baseSuite) {
    try {
      baseTasks = await importTasks(baseSuite)
    } catch (err) {
      return fail(
        outputPath,
        `the base side failed to load ${baseSuite}: ${errorText(err)}`,
      )
    }
  }
  let candRegistered: RegisteredTask[]
  try {
    candRegistered = await importTasks(candSuite)
  } catch (err) {
    return fail(
      outputPath,
      `the candidate side failed to load ${candSuite}: ${errorText(err)}`,
    )
  }
  if (candRegistered.length === 0) {
    return fail(
      outputPath,
      `${candSuite} registered no tasks (no task() calls found).`,
    )
  }

  let candTasks: RegisteredTask[]
  try {
    candTasks = selectTasks(
      candRegistered,
      opts.filter,
      candSuite,
      !opts.workloadIds,
    )
  } catch (err) {
    return fail(outputPath, (err as Error).message)
  }

  const wanted = opts.workloadIds && new Set(opts.workloadIds)
  const baseByKey = new Map(baseTasks.map((t) => [pairKey(t), t]))
  const candKeys = new Set(candRegistered.map(pairKey))

  const workloads: Workload[] = []
  const pairs: {
    workload: Workload
    base: RegisteredTask
    cand: RegisteredTask
  }[] = []
  const candOnly: string[] = []
  for (const cand of candTasks) {
    const workload = taskWorkload(candSuite, cand)
    if (wanted && !wanted.has(workload.id)) continue
    workloads.push(workload)
    if (cand.skipped) continue
    const base = baseByKey.get(pairKey(cand))
    if (base && !base.skipped) pairs.push({ workload, base, cand })
    else candOnly.push(workload.id)
  }

  // Keyed by the candidate suite's path so the id is the one it had before removal.
  // A `.only` in the candidate narrows the run, as `--filter` does: tasks
  // removed from the suite aren't part of it.
  const baseOnly: string[] = []
  if (!wanted && !candRegistered.some((t) => t.only)) {
    for (const base of filterTasks(baseTasks, opts.filter)) {
      if (base.skipped || candKeys.has(pairKey(base))) continue
      const workload = taskWorkload(candSuite, base)
      workloads.push(workload)
      baseOnly.push(workload.id)
    }
  }

  const edges = groupEdges(pairs.map((p) => p.cand))

  if (opts.planPath) {
    const plan: AbRunnerPlan = {
      memory: pairs
        .map((p) => ({
          workloadId: p.workload.id,
          alloc: taskAlloc(p.cand, opts.alloc ?? false),
          peakMem: taskPeakMem(p.cand, opts.peakMem ?? false),
        }))
        .filter((m) => m.alloc || m.peakMem),
    }
    await Bun.write(opts.planPath, JSON.stringify(plan))
  }

  const cfgFp = configFingerprint({
    rounds: opts.rounds,
    thresholdPct: opts.thresholdPct,
  })
  const measurements: Measurement[] = []
  for (let i = 0; i < pairs.length; i++) {
    const { workload, base, cand } = pairs[i]!
    const { enter, leave } = edges(i)
    if (opts.progress) {
      process.send?.({
        task: i + 1,
        tasks: pairs.length,
        label: taskId(cand),
      } satisfies AbRunnerProgress)
    }
    await runGroupHooks(base, "before", enter)
    await runGroupHooks(cand, "before", enter)
    const measured = await measureTask(base, cand, opts.rounds)
    if ("threw" in measured) {
      measurements.push(
        makePairedMeasurement({
          workload,
          configFingerprint: cfgFp,
          threw: measured.threw,
          diagnosticWallNs: 0,
          warnings: [],
        }),
      )
    } else {
      const { result } = measured
      const stats = ratioStats(result.ratios, opts.thresholdPct)
      const timing = computeTimingStats(result.candSamples)
      if (result.batch > 1) timing.batch = result.batch
      measurements.push(
        makePairedMeasurement({
          workload,
          configFingerprint: cfgFp,
          timing,
          diagnosticWallNs: result.diagnosticWallNs,
          warnings: [],
          paired: {
            rounds: result.rounds,
            batch: result.batch,
            baseSamples: result.baseSamples,
            baseMedianNs: median(result.baseSamples),
            ratios: result.ratios,
            ...stats,
            verdict: stats.flagged ?? "unchanged",
            sameOutput: result.sameOutput,
          },
        }),
      )
    }

    await runGroupHooks(cand, "after", leave)
    await runGroupHooks(base, "after", leave)
  }

  const doc = createDocument(workloads, measurements)
  doc.unmatched = { baseOnly, candOnly }
  await saveDocument(doc, outputPath)
  return 0
}

main().then((code) => process.exit(code))
