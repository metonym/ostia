import { profile } from "../../src/index.ts"

function hashLoop(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 2654435761) % 1000000007
  return acc
}

const { result, run } = await profile(() => hashLoop(8_000_000), {
  origin: "jsc",
  intervalUs: 100,
})

console.log("result:", result)
console.log("instrumented:", run.instrumented)
console.log("origin:", run.cpu?.origin)
console.log()

console.log("JIT tiers (sample counts):")
console.log(run.jit?.tiers)
console.log()

console.log("top frames by self time:")
for (const t of run.cpu?.totals.slice(0, 3) ?? []) {
  console.log(
    " ",
    run.cpu!.frames[t.frameIx]!.name,
    `${(t.selfUs / 1000).toFixed(2)}ms self`,
  )
}

if (!run.jit || run.jit.tiers.ftl === 0) {
  console.error(
    "\nerror: expected hashLoop to tier up to FTL - it's a tight loop over 8e6 iterations",
  )
  process.exit(1)
}
