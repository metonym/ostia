#!/usr/bin/env bun

import {
  filterTasks,
  getRegisteredTasks,
  type RegisteredTask,
  resetRegistry,
  selectTasks,
  taskId,
} from "../bench/registry.ts"
import { taskWorkload } from "../bench/run-tasks.ts"
import {
  configFingerprint,
  makePairedMeasurement,
  newDocument,
  saveDocument,
} from "../ir/document.ts"
import { canonicalJSON } from "../ir/fp.ts"
import type { Measurement, Workload } from "../ir/types.ts"
import {
  measurePaired,
  PairedSideError,
  ratioStats,
} from "../measure/paired.ts"
import { computeTimingStats, percentile } from "../stats/index.ts"

export interface AbRunnerOpts {
  /** Regex, matched against "group/name" task ids (see `filterTasks`). */
  filter?: string
  /** Measure only these workloads (a fresh-process repeat of flagged ones). */
  workloadIds?: string[]
  rounds: number
  thresholdPct: number
  /** Scripts imported, in order, before either suite. */
  preload?: string[]
  /** Send an `AbRunnerProgress` message over IPC before each task. */
  progress?: boolean
}

/** Sent to the parent before each task is measured, when `progress` is
 * set. `task` counts from 1. */
export interface AbRunnerProgress {
  task: number
  tasks: number
  label: string
}

/** Tasks pair across the two sides by their "group/name" id plus `params`,
 * the same identity the workload id hashes. */
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

/** Runs one suite file's tasks against the same file at the base checkout,
 * in this one process. The base copy is imported first and the working
 * tree's second, each from its own path, so each side's relative imports
 * (and tsconfig `paths`) resolve within its own tree while bare package
 * imports share the project's `node_modules` - including `ostia` itself, so
 * both register into the same registry. `baseSuite` is "" when the file
 * doesn't exist at the base ref: every task is then candidate-only. */
async function main(): Promise<number> {
  const [candSuite, baseSuite, outputPath, optsJson] = process.argv.slice(2)
  if (!candSuite || baseSuite === undefined || !outputPath || !optsJson) {
    process.stderr.write(
      "ab runner: usage: ab-runner.ts <candSuite> <baseSuite|''> <outputPath> <optsJson>\n",
    )
    return 2
  }
  const opts: AbRunnerOpts = JSON.parse(optsJson)

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
    candTasks = selectTasks(candRegistered, opts.filter, candSuite)
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

  // A task that only exists at the base ref, keyed by the candidate suite's
  // path so its id is the one it had before it was removed.
  const baseOnly: string[] = []
  if (!wanted) {
    for (const base of filterTasks(baseTasks, opts.filter)) {
      if (base.skipped || candKeys.has(pairKey(base))) continue
      const workload = taskWorkload(candSuite, base)
      workloads.push(workload)
      baseOnly.push(workload.id)
    }
  }

  // Group hooks wrap the group's measured tasks, on both sides.
  const firstInGroup = new Map<string, number>()
  const lastInGroup = new Map<string, number>()
  pairs.forEach(({ cand }, i) => {
    if (cand.groupName === undefined) return
    if (!firstInGroup.has(cand.groupName)) firstInGroup.set(cand.groupName, i)
    lastInGroup.set(cand.groupName, i)
  })

  const cfgFp = configFingerprint({
    rounds: opts.rounds,
    thresholdPct: opts.thresholdPct,
  })
  const measurements: Measurement[] = []
  for (let i = 0; i < pairs.length; i++) {
    const { workload, base, cand } = pairs[i]!
    const group = cand.groupName
    const isFirst = group !== undefined && firstInGroup.get(group) === i
    const isLast = group !== undefined && lastInGroup.get(group) === i
    if (opts.progress) {
      process.send?.({
        task: i + 1,
        tasks: pairs.length,
        label: taskId(cand),
      } satisfies AbRunnerProgress)
    }
    if (isFirst) {
      await base.groupBefore?.()
      await cand.groupBefore?.()
    }
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
            baseMedianNs: percentile(
              Float64Array.from(result.baseSamples).sort(),
              0.5,
            ),
            ratios: result.ratios,
            ...stats,
            verdict: stats.flagged ?? "unchanged",
            sameOutput: result.sameOutput,
          },
        }),
      )
    }

    if (isLast) {
      await cand.groupAfter?.()
      await base.groupAfter?.()
    }
  }

  const doc = newDocument(workloads, measurements)
  doc.unmatched = { baseOnly, candOnly }
  await saveDocument(doc, outputPath)
  return 0
}

main().then((code) => process.exit(code))
