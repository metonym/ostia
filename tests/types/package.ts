// Typechecks the built `package/index.d.ts` the way a consumer sees it
// (`bun run build && bun run typecheck:package`). The source can be right while
// the bundled declarations are wrong: 0.2.6 shipped `task` as a zero-arg
// function.
import {
  type AbOptions,
  ab,
  type BenchOptions,
  bench,
  group,
  keep,
  type MermaidOptions,
  type MinimalProtocolContext,
  type MinimalRenderOptions,
  type ProfileOptions,
  type ProfileResult,
  profile,
  renderers,
  task,
} from "ostia"

task("name", () => {})
task("name", async () => 1, { baseline: true })
task.skip("name", () => {})
task.only("name", () => {})

group("name", () => {
  task("inner", () => keep(1))
})
group.skip("name", () => {})
group.only("name", () => {})

// @ts-expect-error name and fn are required
task()
// @ts-expect-error fn is required
group("name")

// `ab()` takes the same suite files as `bench()`.
ab({ suites: ["bench/x.ts"], base: "HEAD", thresholdPct: 5, confirm: 0 }).then(
  (doc) => doc.ab?.verdict,
)
// @ts-expect-error suites is required
ab({ base: "HEAD" })

// The option types of public functions are importable, and each renderer's
// options are typed per format.
const abOptions: AbOptions = { suites: ["bench/x.ts"] }
const benchOptions: BenchOptions = { suites: ["bench/x.ts"] }
ab(abOptions)
bench(benchOptions)
const profileOptions: ProfileOptions = { origin: "jsc" }
profile(() => 1, profileOptions).then((r: ProfileResult<number>) => r.result)

const protocol: MinimalProtocolContext = { command: "ab", exitCode: 0 }
const minimalOptions: MinimalRenderOptions = { protocol }
const mermaidOptions: MermaidOptions = { topN: 5, measurementId: "m" }
declare const doc: Awaited<ReturnType<typeof ab>>
renderers.minimal.render(doc, minimalOptions)
renderers.mermaid.render(doc, mermaidOptions)
renderers.collapsed.render(doc, { measurementId: "m" })
// @ts-expect-error `topN` belongs to mermaid, not collapsed
renderers.collapsed.render(doc, { topN: 5 })
// @ts-expect-error `protocol` belongs to minimal, not mermaid
renderers.mermaid.render(doc, { protocol })
