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
Task                                   Median     Spread             Range              Relative
------------------------------------------------------------------------------------------------
dedupe:
  dedupe/naive (indexOf scan, O(n²))   217.8 µs   208.3 µs…227.2 µs  197.3 µs…825.5 µs  9.08× slower
  dedupe/Set-based (O(n))              24.0 µs    23.2 µs…24.9 µs    21.6 µs…258.8 µs   1.00×
```

Each suite file runs in its own spawned child, isolated from the caller's state - the
same isolation `ostia bench suite.ts...` gives you from the CLI. The result is a
regular `ProfileDocument`: same renderers as `ostia time`/`ostia compare`, and it can be
saved and diffed against a baseline the same way - see
[gate-a-regression](../gate-a-regression/) for the CLI-config version of that, or
`bench/README.md` at the repo root for how this project benchmarks its own hot paths.

## Run it

```console
bun run demo
```
