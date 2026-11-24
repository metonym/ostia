# ostia

Fast profiling and benchmarking for Bun.

ostia times commands and functions on Bun,
then tells you whether a change made them slower:
it compares two runs with statistics that account for how noisy your
machine is, and `ostia ab` confirms a regression in fresh processes
before it reports one.
The CLI and the library do the same things,
and every result is one JSON document.

```ts
// suite.ts
import { group, task } from "ostia"

const input = Array.from({ length: 2_000 }, (_, i) => i % 500)

group("dedupe", () => {
  task("naive (indexOf scan, O(n²))", () => dedupeNaive(input))
  task("Set-based (O(n))", () => [...new Set(input)])
})
```

```console
$ ostia bench suite.ts
Apple M2 · 8 cores · load 3.5 · noise floor 0.4%

Task                            Median     Spread             Range              Relative
-----------------------------------------------------------------------------------------
dedupe:
  naive (indexOf scan, O(n²))   173.9 µs   180.4 µs…205.8 µs  170.1 µs…635.5 µs  7.40× slower
  Set-based (O(n))              23.5 µs    24.9 µs…72.5 µs    18.7 µs…208.3 µs   1.00×
```

**It tells you when a change made something slower.**
Change the code, and `ostia ab` runs your suite against `HEAD`
and the working tree in alternating batches in one process:

```console
$ ostia ab suite.ts
A/B: working tree vs HEAD (3945768) · 15 rounds · threshold 10% · geomean threshold 1.5%

Task                            Base       Candidate  Change    p25…p75            Verdict
------------------------------------------------------------------------------------------
dedupe:
  naive (indexOf scan, O(n²))   183.5 µs   178.5 µs   -1.9%     -3.5%…-0.3%
  Set-based (O(n))              25.2 µs    181.2 µs   +618.1%   +554.2%…+659.2%    regressed, confirmed (repeats: +630.6%, +584.5%)

Geomean +165.4% (threshold 1.5%) · 1 regressed, 0 improved, 1 unchanged of 2 · fail
```

Exit 1 on a regression, so CI can gate on it.
ostia has no dependencies and needs Bun ≥ 1.4.

## Quick start

```sh
bun add -d ostia
```

Write a suite with `group()` and `task()`, as above, then:

```sh
ostia bench suite.ts      # time each task
ostia ab suite.ts         # compare the working tree with HEAD
```

Exit status: 0 pass, 1 a regression (`ab`, `compare`, `ci`), 2 an error.

## Common tasks

```sh
# Time two commands against each other
ostia time "bun a.ts" "bun b.ts"

# Compare two saved runs
ostia compare before.json after.json

# Save a baseline on known-good code, then gate CI on it
ostia baseline save
ostia ci

# Capture a CPU profile while timing
ostia time "bun a.ts" --cpu

# One JSON object per line, for a script or an agent
ostia bench suite.ts --format minimal
```

These docs ship in the package, at `node_modules/ostia/docs/`.

## From code

```ts
const doc = await time({
  commands: ["bun a.ts", { command: "bun b.ts", label: "b", prepare: "rm -rf dist" }],
  samples: 20,
  cpu: true,
})

group("parse", () => {
  sweep({ size: range(100, 10_000) }, ({ size }) => {
    const input = buildInput(size) // unmeasured setup, once per point
    task("parse", () => parse(input), { isolate: true })
  })
})

const result = compareDocuments(await loadDocument("before.json"), doc)
if (result.summary.verdict === "fail") process.exitCode = 1

const { text } = await renderers.markdown.render(doc, {})
```

## Docs

- [CLI](https://github.com/metonym/ostia/blob/master/docs/cli.md): every
  command and flag
- [Library](https://github.com/metonym/ostia/blob/master/docs/library.md):
  `time()`, `bench()`, `ab()`, `profile()`, and documents
- [Config](https://github.com/metonym/ostia/blob/master/docs/config.md):
  `ostia.config` workloads, thresholds and baselines
- [Machine-readable output](https://github.com/metonym/ostia/blob/master/docs/agent-protocol.md):
  `--format minimal`, exit codes and error codes, for scripts and agents
- [Statistics](https://github.com/metonym/ostia/blob/master/docs/statistics.md):
  how a comparison decides, and the noise floor
- [Document schema](https://github.com/metonym/ostia/blob/master/docs/document-schema.md):
  the JSON a run writes
- [Preload recipes](https://github.com/metonym/ostia/blob/master/docs/preload-recipes.md):
  DOM, Svelte and other setups a suite needs
