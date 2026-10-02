#!/usr/bin/env bun

import {
  filterTasks,
  getRegisteredTasks,
  groupEdges,
  type RegisteredTask,
  resetRegistry,
  runGroupHooks,
  selectTasks,
  taskId,
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
import { measurePaired, ratioStats } from "../measure/paired.ts"
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
    candTasks = selectTasks(
      candRegistered,
      opts.filter,
      candSuite,
      !opts.workloadIds,
    )
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

  const cfgFp = configFingerprint({
    rounds: opts.rounds,
    thresholdPct: opts.thresholdPct,
  })
  const measurements: Measurement[] = []
  for (let i = 0; i < pairs.length; i++) {
    const { workload, base, cand } = pairs[i]!
    const { enter, leave } = edges(i)
    await runGroupHooks(base, "before", enter)
    await runGroupHooks(cand, "before", enter)
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
          baseMedianNs: median(result.baseSamples),
          ratios: result.ratios,
          ...stats,
          verdict: stats.flagged ?? "unchanged",
          sameOutput: result.sameOutput,
        },
      }),
    )

    await cand.opts?.after?.()
    await base.opts?.after?.()
    await runGroupHooks(cand, "after", leave)
    await runGroupHooks(base, "after", leave)
  }

  const doc = createDocument(workloads, measurements)
  doc.unmatched = { baseOnly, candOnly }
  await saveDocument(doc, outputPath)
  return 0
}

main().then((code) => process.exit(code))
