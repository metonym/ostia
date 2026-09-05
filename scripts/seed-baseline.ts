import { baselinePath, loadConfig } from "../src/config/index.ts"
import {
  configFingerprint,
  makeSubprocessWorkload,
  makeTimingMeasurement,
  newDocument,
  saveDocument,
} from "../src/ir/document.ts"
import type { Measurement, Workload } from "../src/ir/types.ts"
import { runTimingPhase } from "../src/measure/timing.ts"

const name = process.argv[2]
const config = await loadConfig()
if (!config) {
  process.stderr.write("No ostia.config.json found.\n")
  process.exit(2)
}
if (config.workloads.length === 0) {
  process.stderr.write('ostia.config.json has no "workloads" configured.\n')
  process.exit(2)
}

const cfgFp = configFingerprint({
  runs: config.runs,
  warmup: config.warmup,
})

const workloads: Workload[] = []
const measurements: Measurement[] = []

for (const wc of config.workloads) {
  const workload = makeSubprocessWorkload(wc.command, wc.label)
  const phaseResult = await runTimingPhase({
    argv: wc.command,
    runs: config.runs ?? undefined,
    warmup: config.warmup,
  })
  workloads.push(workload)
  measurements.push(
    makeTimingMeasurement({
      workload,
      configFingerprint: cfgFp,
      trials: phaseResult.trials,
      timing: phaseResult.timing,
      warnings: phaseResult.warnings,
    }),
  )
}

const path = baselinePath(config, name)
await saveDocument(newDocument(workloads, measurements), path)
process.stdout.write(`Wrote ${path}\n`)
