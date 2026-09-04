# Benchmark a function

`bench()` is the library's in-process microbenchmarking path - mitata-shaped time
budget + min-samples, batched when a call is sub-microsecond, no subprocess or
wall-clock command involved. Register tasks with `group()`/`task()` in a suite file,
then run the suite through the library:

```ts
// suite.ts
import { group, task } from "ostia"

group("dedupe", () => {
  task("naive (indexOf scan, O(n²))", () => dedupeNaive(input))
  task("Set-based (O(n))", () => dedupeSet(input))
})
```

```ts
// demo.ts
import { bench, renderers } from "ostia"

const doc = await bench({ suites: ["suite.ts"] })
const { text } = await renderers.table.render(doc, {})
console.log(text)
```

```
Command                              Mean [ms]        Min…Max [ms]        Relative
----------------------------------------------------------------------------------
dedupe/naive (indexOf scan, O(n²))   0.195 ± 0.058    0.168…1.443         9.14× slower
dedupe/Set-based (O(n))              0.022 ± 0.018    0.017…0.638         1.00×
```

Each suite file runs in its own spawned child, isolated from the caller's state - the
same isolation `ostia bench suite.ts...` gives you from the CLI. The result is a
regular `ProfileDocument`: same renderers as `ostia run`/`ostia compare`, and it can be
saved and diffed against a baseline the same way - see
[gate-a-regression](../gate-a-regression/) for the CLI-config version of that, or
`bench/README.md` at the repo root for how this project benchmarks its own hot paths.

## Run it

```console
bun run demo
```
