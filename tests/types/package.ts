// Typechecks the built `package/index.d.ts` the way a consumer sees it
// (`bun run build && bun run typecheck:package`). The source can be right while
// the bundled declarations are wrong: 0.2.6 shipped `task` as a zero-arg
// function.
import { ab, group, keep, task } from "ostia"

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
