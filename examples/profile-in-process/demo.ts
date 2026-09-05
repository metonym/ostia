import { profile, renderers } from "../../src/index.ts"

function hashLoop(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 2654435761) % 1000000007
  return acc
}

const { result, measurement, document } = await profile(
  () => hashLoop(8_000_000),
  { origin: "jsc", intervalUs: 100 },
)

console.log("result:", result)
console.log("instrumented:", measurement.instrumented)
console.log("origin:", measurement.cpu?.origin)
console.log()

console.log("JIT tiers (sample counts):")
console.log(measurement.jit?.tiers)
console.log()

console.log("top frames by self time:")
for (const t of measurement.cpu?.totals.slice(0, 3) ?? []) {
  console.log(
    " ",
    measurement.cpu!.frames[t.frameIx]!.name,
    `${(t.selfUs / 1000).toFixed(2)}ms self`,
  )
}

if (!measurement.jit || measurement.jit.tiers.ftl === 0) {
  console.error(
    "\nerror: expected hashLoop to tier up to FTL - it's a tight loop over 8e6 iterations",
  )
  process.exit(1)
}

// `document` is a full ProfileDocument (one workload, one measurement), so it
// composes with the same renderers `ostia time --cpu` and `ostia bench` use,
// with no need to reach into src/ir/document.ts.
const { files } = await renderers.collapsed.render(document, {})
console.log(
  `\ncollapsed stacks: ${files![0]!.content.split("\n").length} lines`,
)
