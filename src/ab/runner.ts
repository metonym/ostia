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
import { measurePaired, ratioStats } from "../measure/paired.ts"
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
      "ab runner: usage: runner.ts <candSuite> <baseSuite|''> <outputPath> <optsJson>\n",
    )
    return 2
  }
  const opts: AbRunnerOpts = JSON.parse(optsJson)

  for (const preloadFile of opts.preload ?? []) {
    await import(preloadFile)
  }

  const baseTasks = baseSuite ? await importTasks(baseSuite) : []
  const candRegistered = await importTasks(candSuite)
  if (candRegistered.length === 0) {
    process.stderr.write(
      `ab runner: ${candSuite} registered no tasks (no task() calls found).\n`,
    )
    return 2
  }

  let candTasks: RegisteredTask[]
  try {
    candTasks = selectTasks(candRegistered, opts.filter, candSuite)
  } catch (err) {
    process.stderr.write(`ab runner: ${(err as Error).message}\n`)
    return 2
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
    if (isFirst) {
      await base.groupBefore?.()
      await cand.groupBefore?.()
    }
    await base.opts?.before?.()
    await cand.opts?.before?.()

    const result = await measurePaired(base.fn, cand.fn, {
      rounds: opts.rounds,
    })
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

    await cand.opts?.after?.()
    await base.opts?.after?.()
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
