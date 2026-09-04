import { bench, renderers } from "../../src/index.ts"

const doc = await bench({ suites: [`${import.meta.dir}/suite.ts`] })
const { text } = await renderers.table.render(doc, {})
process.stdout.write(text ?? "")

const byLabel = new Map(
  doc.workloads.map((w) => [w.id, w.label ?? w.entry?.task ?? w.id]),
)
const runs = doc.runs.filter((r) => r.timing)
const naiveRun = runs.find((r) => byLabel.get(r.workloadId)?.includes("naive"))
const setRun = runs.find((r) => byLabel.get(r.workloadId)?.includes("Set"))

if (!naiveRun?.timing || !setRun?.timing) {
  process.stderr.write("error: expected both dedupe tasks to report timing\n")
  process.exit(1)
}
if (setRun.timing.median >= naiveRun.timing.median) {
  process.stderr.write(
    "error: expected the Set-based dedupe to beat the naive O(n²) scan\n",
  )
  process.exit(1)
}
