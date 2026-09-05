# ostia

ostia is a profiling and benchmarking toolkit for Bun.

Use it when you want wall-clock timings, CPU hotspots, heap summaries, or JIT tier
data in one place, then diff those results or fail CI when something gets slower.
Everything lands in one schema-versioned JSON document (`ProfileDocument`), so the
CLI and the library speak the same language.

Zero runtime dependencies. Requires Bun ≥ 1.4.

## Install

```sh
bun add ostia
```

## Quick start

Compare two commands:

```sh
ostia time --runs 10 --warmup 2 "bun fixtures/fast.ts" "bun fixtures/slow.ts"
```

```
Apple M2 · 8 cores · load 5.2 · noise floor 0.5%

Task                   Median     Spread             Range              Relative
--------------------------------------------------------------------------------
bun fixtures/fast.ts   7.47 ms    7.56 ms…7.77 ms    7.39 ms…7.78 ms    1.00×
  ! outliers-detected
bun fixtures/slow.ts   20.7 ms    20.9 ms…21.1 ms    20.6 ms…21.1 ms    2.77× slower

Warnings:
  bun fixtures/fast.ts: 1 outlier(s) detected (0 severe, 1 mild).
```

The header line (machine, cores, load, noise floor) prints whenever a document
carries an `environment` - on by default; skip the ~200ms reference
measurement with `--no-noise-check`. `compare`/`ci` widen the regression
threshold to at least the noise floor, so a change smaller than the machine's
own jitter is never called a regression - see
[Statistics](#statistics-a-real-significance-test-not-a-percentage-threshold)
below.

Find a CPU hotspot (profiler runs as a separate labeled trial, never mixed into the
timing numbers above):

```sh
ostia time --runs 5 --cpu --cpu-interval 200 --export-json node_modules/.cache/ostia/doc.json "bun fixtures/work.ts"
```

```
Task                   Median     Spread             Range
-----------------------------------------------------------------------
bun fixtures/work.ts   400.6 ms   393.9 ms…417.8 ms  368.6 ms…430.7 ms

CPU capture - bun fixtures/work.ts (instrumented, 200µs interval, diagnostic wall 433.480ms)
  100.0%    413.40ms self  hashLoop
    0.0%      0.00ms self  (root)
    0.0%      0.00ms self  (module)
  artifact: node_modules/.cache/ostia/artifacts/<run-id>-cpu.cpuprofile
```

Scratch/artifact output defaults to `node_modules/.cache/ostia` (already gitignored
everywhere, no setup needed - same convention as Babel/ESLint/Jest caches). Baselines are
the one exception: they default to `.ostia/baselines/` at the repo root instead, since
they need to survive `node_modules` reinstalls between branches and CI jobs, so gitignore
`.ostia/` if you use `ostia ci`.

Gate a change against a local baseline:

```sh
bun run baseline   # on known-good: measure ostia.config.json -> .ostia/baselines/main.json
ostia ci           # on your branch: rerun changed workloads, exit 1 on regression
```

```
2 workloads
0 affected by this change
2 cached
0 executed
2 passed  0 regressed

Profile CI: ✓
```

## What ostia is for

- Time subprocesses or in-process functions without a profiler attached to the timing runs.
- Capture CPU (`--cpu`), heap (`--heap`), or JSC JIT tiers (`profile(..., { origin: "jsc" })`)
  as separate evidence on the same document.
- Diff two documents (`ostia compare`) or fail CI (`ostia ci`) with exit codes `0` / `1` / `2`.
- Emit files other tools already understand: collapsed stacks, Mermaid, speedscope JSON,
  raw `.cpuprofile`.

## CLI reference

```
ostia time <command...>      time commands; optional --cpu / --heap capture (alias: run)
ostia bench <suite.ts...>    in-process group()/task() suites (time-budgeted)
ostia compare <a> <b>        diff two ProfileDocuments
ostia report <document.json> render a saved document (table/json/markdown/collapsed/...)
ostia ci                     run configured workloads vs a baseline, gate regressions
```

Every subcommand takes `--help` for its full flag list.

### `ostia time`

`ostia run` is kept as an alias for anyone migrating from hyperfine.

Clean wall-clock timing by default. `--cpu` / `--heap` schedule one extra instrumented
trial each, labeled separately in the document.

```sh
ostia time "bun a.ts" "bun b.ts"
ostia time --samples 25 --warmup 3 --cpu --heap "bun src/server.ts"
ostia time --format json --export-json out.json "bun a.ts"
```

`--samples N` is an exact trial count (`--runs` is a deprecated alias); `--budget MS`
is a wall-clock time budget instead (default: a hyperfine-style ~3s min-total-time
loop when neither is given); `--min-samples N` is a hard floor when `--samples` isn't
given. The same three names work on `ostia bench` (`--budget`/`--samples`/
`--min-samples`), where `--budget` is a per-task sampling window (`--time-budget` is
its deprecated alias) - `warmup` differs by surface, though: a trial count here, a
*fraction* of the budget for `ostia bench`, since in-process warmup has no natural
"N calls" unit before the JIT has even seen the function once.

Timing table (two commands get a Relative column automatically):

```
Task                   Median     Spread             Range              Relative
--------------------------------------------------------------------------------
bun fixtures/fast.ts   15.0 ms    14.0 ms…19.3 ms    12.4 ms…23.7 ms    1.00×
bun fixtures/slow.ts   37.3 ms    34.9 ms…40.7 ms    31.3 ms…48.2 ms    2.49× slower
```

Heap summary (type counts from the snapshot trial):

```
Task                       Median     Spread             Range
---------------------------------------------------------------------------
bun fixtures/allocate.ts   32.5 ms    32.0 ms…34.7 ms    30.2 ms…46.2 ms
  ! outliers-detected

Warnings:
  bun fixtures/allocate.ts: 5 outlier(s) detected (4 severe, 1 mild).

Heap snapshot - bun fixtures/allocate.ts (instrumented, 2516 objects, 0.12MB)
    1369  string
     423  code
     319  closure
     216  object shape
     105  hidden
  artifact: node_modules/.cache/ostia/artifacts/<run-id>-heap.heapsnapshot
```

### `ostia bench`

In-process microbenchmarks registered with `group()` / `task()`. Each task samples
for `--time-budget` (default 500ms). `--min-samples` is a hard floor kept even when it
overruns the budget. Left unset, the floor is cost-aware in both directions: as many
trials as fit in the budget (capped at 20) so one slow task can't blow the suite's total,
but never below the floor a task's per-trial cost earns it - 3 at ≤1ms, two more per
decade of cost, 10 from about 3s up. Cheap tasks are time-bound and collect thousands of
trials either way; only the few expensive tasks in a suite pay for the extra rigor, and
those are exactly where a 3-sample mean is shakiest. Fast calls are batched so a trial
spans at least 1µs and a full budget yields about 10k trials at most.

| per-trial cost | fits in 500ms | default floor |
|---|---|---|
| 30ns | thousands | 20 (time-bound; ends in the tens of thousands) |
| 30ms | 16 | 16 |
| 140ms | 3 | 7 |
| 2.4s | 0 | 10 |

A run that ends below its cost-class floor (only possible with an explicit
`--min-samples` or per-task `minSamples`) carries a `low-sample-count` warning with
`{ samples, target, trialCostNs }`, so a renderer or an agent can flag a thin number
without re-deriving the policy from the raw sample array.

```sh
ostia bench bench/*.ts
ostia bench --budget 500 --min-samples 50 bench/stats.ts
ostia bench bench/*.ts --jobs auto          # suite files in parallel, see below
ostia bench bench/*.ts --format minimal       # one compact JSON object per task
```

`--jobs N|auto` runs that many suite files at once, each still in its own child process.
Files are independent by design, so for a multi-file suite this is close to a linear
wall-clock win - but concurrent CPU-bound processes contend for cores, caches and turbo
headroom, so numbers taken at `--jobs > 1` are noisier and not like-for-like with a
baseline measured at 1. It defaults to 1 for that reason; opt in for exploratory runs,
keep 1 for anything you `compare` or `ci` against.

`--isolate` gives every task its own child process instead of sharing its suite file's,
isolating each task's JIT tier state, inline caches and heap shape from every other task
in the run - the same guarantee suite files already get from each other, at task
granularity. `task(name, fn, { isolate })` / `group(name, fn, { isolate })` override the
suite-wide default for mixed suites (e.g. a couple of outlier-prone tasks isolated, the
rest sharing a process). `--jobs` then pools across those per-task processes the same way
it pools across per-file ones, so pair a higher `--jobs` with `--isolate` deliberately -
overhead now scales with task count, not file count.

`--gc` calls `Bun.gc(true)` between trials (default: off, which hides allocation cost as
Bun/V8 batch calls together and amortize it away). `task(name, fn, { gc })` /
`group(name, fn, { gc })` override the suite-wide default per task or group, the same
override pattern as `isolate` - useful when a few allocation-heavy tasks need GC settled
between trials but the rest of the suite doesn't.

`--preload PATH` (repeatable) imports a script before each suite file loads, in the same
subprocess - the same shape as Bun's own `--preload` / `bunfig.toml`'s `preload` array. Use
it to install globals a suite needs at import time (jsdom's `document`/`window`) or register
a `Bun.plugin()` file-loader (e.g. compiling `.svelte`/`.vue` SFCs) before the suite's own
top-level code runs. Multiple `--preload` scripts run in the order given, so state one
installs (a plugin registration, a global) is visible to the next and to the suite itself.
ostia ships none of this itself - just the hook point (for a full jsdom/happy-dom global
setup or a `Bun.plugin()` component-compile hook, see
[docs/preload-recipes.md](docs/preload-recipes.md)):

```ts
// bench/jsdom-setup.ts
import { JSDOM } from "jsdom"
const dom = new JSDOM("<!doctype html>")
Object.assign(globalThis, { document: dom.window.document, window: dom.window })
```

```sh
ostia bench --preload ./bench/jsdom-setup.ts bench/*.dom.bench.ts
```

`--bun-flags FLAGS` (repeatable, space-separated flags within one value are all appended)
passes extra flags through to the `bun` invocation that spawns each suite file - the fix for
packages whose `package.json` `exports` map branches on a resolution condition Bun doesn't
set by default. Svelte 5's `exports` map, for example, is `{ "browser": "./src/index-client.js",
"default": "./src/index-server.js" }`: without `--conditions browser`, Bun resolves `default`
(the server-rendering build), and mounting a component via `@testing-library/svelte` throws
`lifecycle_function_unavailable` since `mount()` isn't available server-side. The same applies
to Vue and other dual-target frameworks:

```sh
ostia bench --bun-flags="--conditions=browser" bench/*.dom.bench.ts
```

Unlike `BUN_OPTIONS` (an env var Bun's CLI reads to prepend flags, which only reaches the
spawned suite process today because ostia's `Bun.spawn()` happens to inherit `process.env`),
`--bun-flags` is a declared, documented integration point that doesn't depend on the parent
shell's environment.


```
Task                                       Median     Spread             Range              Relative
----------------------------------------------------------------------------------------------------
stats:
  stats/computeTimingStats (1e3 samples)   13.7 µs    13.3 µs…14.2 µs    13.1 µs…84.3 µs    1.00×
  stats/computeTimingStats (1e4 samples)   167.3 µs   160.6 µs…168.4 µs  158.3 µs…422.5 µs  12.20× slower
  stats/timingWarnings (1e3 samples)       40.8 µs    40.7 µs…41.1 µs    38.5 µs…598.3 µs   2.98× slower
```

Tasks with a `group()` print the group name once, indented; ungrouped tasks and
subprocess commands print flat.

### `ostia compare`

Match workloads by id, rank timing / frame / heap deltas, print a verdict per workload.

```sh
ostia compare before.json after.json
ostia compare after.json --baseline .ostia/baselines/main.json
```

```
✗ bun fixtures/work.ts
  timing: +50.2% median, 95% CI [+45.9%, +54.4%], p<0.001 (regressed)
```

The verdict needs both a confidence interval clear of `timingPct` and a
significant Mann-Whitney p-value (`thresholds.alpha`, default `0.01`), not
just a point estimate past the threshold - see
[Statistics](#statistics-a-real-significance-test-not-a-percentage-threshold)
below. Comparisons with fewer than 5 samples on either side fall back to the
old point-estimate rule and carry a `thin-comparison` warning instead.

#### Statistics: a real significance test, not a percentage threshold

A point estimate past `timingPct` is not enough to call something a
regression - both documents already carry full sample arrays, so `compare`
runs two tests instead:

- A **bootstrap confidence interval** on the difference of medians:
  resample both sides with replacement `thresholds.bootstrapIterations`
  times (default 2000; each side is randomly subsampled to at most 2000
  samples first, so a many-thousand-sample task doesn't turn a compare into
  a multi-second operation), and report the 2.5th/97.5th percentiles as
  `ci95` (percent of the baseline median). Reproducible: the PRNG seed is
  stored in `Comparison.timing.seed`.
- A **Mann-Whitney U test** (tie-corrected, normal approximation), reported
  as `pValue` - whether the two sample distributions differ at all, without
  assuming normality the way a t-test would.

`regressed` requires `ci95[0] > thresholds.timingPct` (the *whole interval*
clears the threshold) **and** `pValue < thresholds.alpha`; `improved` is the
mirror. Otherwise `unchanged`. This is why the earlier example (`+50.2%
median, 95% CI [+45.9%, +54.4%]`) is a clean regression: even the low end of
the interval is well past `timingPct`.

Both `time()` and `bench()` also stamp `environment` on every document (a
fixed-cost, deterministic, allocation-free hash loop sampled for ~200ms,
`noise.floorPct = mad / median`) unless `noiseCheck: false` / `--no-noise-check`
skips it. `compare` widens the effective threshold to
`max(thresholds.timingPct, base.environment.noise.floorPct,
cand.environment.noise.floorPct)` (`Comparison.thresholds.effectiveTimingPct`),
so a delta smaller than the machine's own jitter right now is never called a
regression. A `noisy-machine` warning fires when the 1-minute load average is
already past 75% of available cores at measurement time.

### `ostia report`

Render a saved `ProfileDocument` without re-running anything. `--format` covers
both the data formats (`table`/`json`/`jsonl`/`markdown`/`minimal`) and the CPU
visualization formats (`collapsed`/`mermaid`/`speedscope`/`cpuprofile`) - one
command instead of two (`ostia viz` still works as a deprecated alias for one
release).

```sh
ostia report out.json                 # table (default)
ostia report out.json --format markdown
ostia report out.json --format json
ostia report out.json --format jsonl
ostia report out.json --format minimal
```

Minimal format - one JSON object per timing run, no header, no raw sample array, no prose.
Built to pipe straight into an LLM agent's context: the full document carries every
sample (tens of thousands for a fast task), which is tokens a reviewer never reads.
Numbers stay in ns so they line up with `compare` deltas and the JSON document.

```
{"task":"diffText()/append at end","group":"diffText()","samples":9282,"mean":50213.4,"median":49871,"stddev":2104.7,"stddevPct":4.19,"min":48120,"max":81002,"p75":50920,"p99":58011,"mad":1780,"relative":1,"warnings":[],"unit":"ns"}
{"task":"repaint/4000 chars","group":"repaint","description":"full repaint every keystroke","samples":3,"mean":2.61e9,"median":2.4e9,"stddevPct":15.3,"relative":47800,"warnings":[{"code":"low-sample-count","data":{"samples":3,"target":10}}],"unit":"ns"}
```

`ostia compare ... --format minimal` adds `delta: { medianPct, meanPct, verdict, pass }` to
each line, so "did this PR regress" is `lines.some(l => l.delta?.verdict === "regressed")`.

Markdown:

```
# Profile Report

Bun 1.4.1 · ostia 0.1.0 · darwin/arm64 · 2026-09-05T13:14:50.085Z

## Timing

| Task | Median | Spread (p75…p99) | Mean ± SD | Range | MAD |
|---|---|---|---|---|---|
| bun -e 1 | 5.03 ms | 5.42 ms…9.70 ms | 5.29 ms ± 0.84 ms | 4.77 ms…13.4 ms | 0.16 ms |
```

#### CPU visualization formats

Turn CPU evidence into files for other tools. Formats: `collapsed`, `mermaid`,
`speedscope`, `cpuprofile` (pass-through of a real CDP artifact when present).
`--measurement <id>` renders only that measurement (default: every CPU
measurement in the document); `--out-dir PATH` writes files there instead of
stdout.

```sh
ostia report doc.json --format collapsed
ostia report doc.json --format mermaid
ostia report doc.json --format speedscope > flame.json
```

Collapsed stacks (one line per stack; feeds `flamegraph.pl` and friends):

```
(root);(module);hashLoop 1055
```

Mermaid call tree (top N nodes by self time, never the whole profile):

```
graph TD
  n1["(root) (self 0.00ms, total 284.19ms)"]
  n2["(module) (self 0.00ms, total 284.19ms)"]
  n3["hashLoop (self 284.19ms, total 284.19ms)"]
  n1 --> n2
  n2 --> n3
```

### `ostia ci`

Reads `ostia.config.json`, fingerprints each workload, reruns only what changed, compares
against a named baseline, exits `1` on regression.

```sh
ostia ci
ostia ci --full                  # ignore cache
ostia ci --baseline main
ostia ci --export-json out.json
```

Pass:

```
1 workloads
1 affected by this change
0 cached
1 executed
1 passed  0 regressed

Profile CI: ✓
```

Fail:

```
1 workloads
1 affected by this change
0 cached
1 executed
0 passed  1 regressed (+1249.2% median on work)

Profile CI: ✗
```

Exit codes: `0` pass, `1` regression, `2` harness error (missing config/baseline, spawn failure).

#### `ostia.config.json`

```json
{
  "baseline": "main",
  "thresholds": { "timingPct": 5 },
  "workloads": [
    {
      "label": "parse",
      "command": ["bun", "bench/parse.ts"],
      "inputs": ["src/**/*.ts"]
    }
  ]
}
```

`inputs` is optional. Workloads with no `inputs` always rerun (cache fails conservative).

Two directory options, both optional: `outDir` (default `node_modules/.cache/ostia`) for
scratch/cache/artifacts, and `baselineDir` (default `.ostia/baselines`) for baselines. They're
independent - `baselineDir` doesn't move just because you override `outDir`.

#### Baselines (local and CI)

Baselines are JSON under `.ostia/baselines/` (gitignored). `ostia ci` only needs the file
on disk; it does not need to be committed.

Local branch workflow:

```sh
git checkout master          # known-good tip
bun run baseline             # -> .ostia/baselines/main.json

git checkout -b my-opt
# ... change code ...
ostia ci                     # or: bun run dogfood
```

The baseline survives branch switches because it is not tracked. Re-seed only when you
intentionally accept a new floor. Seeding on the branch you are guarding compares that
branch to itself.

One-off outside this repo's config:

```sh
ostia time --export-json .ostia/baselines/main.json "bun bench.ts"
ostia ci
```

On pull requests, CI measures the base branch into that same path, checks out the PR,
and runs `ostia ci` against it. If the base has no `package.json` / `ostia.config.json`
yet (empty starter commit), CI seeds from the PR tip instead so dogfood still runs.

## Library API

The CLI is a thin wrapper around the library. Same `ProfileDocument` either way.

```ts
import {
  time,
  profile,
  bench,
  group,
  task,
  range,
  sweep,
  keep,
  compareDocuments,
  createDocument,
  renderers,
  saveDocument,
  loadDocument,
} from "ostia"
import type { ProfileDocument } from "ostia"
```

### `time(opts)` → `ProfileDocument`

Subprocess timing, optional CPU/heap capture. Same behavior as `ostia time`.

```ts
const doc = await time({
  commands: ["bun a.ts", "bun b.ts"],
  samples: 10, // exact trial count; `runs` is a deprecated alias
  // budgetMs: 3000,   // wall-clock budget instead of an exact count
  // minSamples: 10,   // hard floor when samples isn't given
  warmup: 2,
  cpu: true,
  heap: false,
  cpuIntervalUs: 200,
  outDir: "node_modules/.cache/ostia", // default; artifacts land under here
  noiseCheck: true, // default; set false to skip the ~200ms noise floor measurement
})
```

`run` is exported too, as a `@deprecated` alias of `time` for one release.

### `profile(fn, opts)` → `{ result, measurement, document }`

In-process capture. `origin: "jsc"` is the only path that reports JIT tiers
(LLInt / Baseline / DFG / FTL). Default `origin: "inspector"` writes portable CDP-shaped
evidence instead. `document` is a full `ProfileDocument` (the one workload and
measurement), so it composes with `renderers.*` or `saveDocument` directly.

```ts
const { result, measurement, document } = await profile(
  () => hashLoop(8_000_000),
  { origin: "jsc", intervalUs: 100 },
)

console.log(measurement.jit?.tiers)
// {
//   llint: 0,
//   baseline: 9,
//   dfg: 37,
//   ftl: 2825,
// }

const { files } = await renderers.collapsed.render(document)
```

### `createDocument(workloads, measurements)` → `ProfileDocument`

For composing a document from several `profile()` calls (each of which returns
just one workload and measurement):

```ts
const a = await profile(() => taskA())
const b = await profile(() => taskB())
const document = createDocument(
  [a.document.workloads[0]!, b.document.workloads[0]!],
  [a.measurement, b.measurement],
)
```

### `group` / `task` / `bench`

Register in-process suites, then run them (same as `ostia bench`):

```ts
// suite.ts
import { group, task } from "ostia"

group("parse", () => {
  task("small input", () => parse(smallBuf))
  task("large input", () => parse(largeBuf))
  // Per-task options override the suite-wide time budget / min samples.
  task("full pipeline", () => build(), { timeBudgetMs: 2000, minSamples: 10 })
})
```

That is the whole registration surface: `group()` and `task()`. Presentation lives in
the renderers (`--format`), not in the suite file.

All module-scope code in a suite file runs up front, before any task is sampled.
`{ before, after }` is the hook that runs a task's own setup immediately before its
sampling and its teardown immediately after - once each, unmeasured, in the task's
own process (so both work with `isolate`):

```ts
group(
  "parse",
  () => {
    let doc: Document
    task("append", () => doc.append(node), {
      before: () => {
        doc = mountDocument()
      },
      after: () => doc.destroy(),
    })
  },
  {
    // Runs once around the whole group, outside every task's own before/after.
    before: () => setupSharedFixture(),
    after: () => teardownSharedFixture(),
  },
)
```

There is no per-trial hook (no setup/teardown between individual samples the way
mitata's generator-based `bench()` drives one case to completion before starting
the next) - that would defeat batching, which is how ostia keeps a sub-microsecond
task's timer overhead down. Reach for `{ gc }` (`Bun.gc(true)` between trials) or
`{ isolate }` (a fresh process per task) for per-trial concerns instead. Because
`before`/`after` run once per task, not once per instance, a suite that builds more
than one instance of something stateful (a mounted UI component, an open
connection, a server) still has to scope a query to the instance it belongs to,
not write it against a global/ambient lookup that assumes it's the only one alive.
Porting a mitata suite that opens a component's menu and queries `getByRole(...)`
unscoped, for example, breaks once a second instance of that component exists
in the document; scope the query with something like `within(instance.container)`
instead.

Task functions may be async (`() => unknown | Promise<unknown>`, same for
`before`/`after`); `await` on a plain synchronous value still costs a microtask
turn, so an `async` task function measures a few nanoseconds slower per call than
the same body written synchronously - immaterial above microsecond cost, worth
knowing for a task near the timer's resolution floor.

Call `keep(value)` on an intermediate value inside a task body - a subcomputation
whose result the task doesn't return - to pin it against dead-code elimination the
same way ostia already protects a task's own return value:

```ts
import { keep } from "ostia"

task("parse then validate", () => {
  const ast = parse(input)
  keep(ast) // the task returns validate's result; without this, a smart-enough
  // JIT could in principle prove `ast` is otherwise unused and skip building it
  return validate(ast)
})
```

Both take an optional `description` that flows into the document
(`Workload.description` / `Workload.groupDescription`) and into `--format minimal`, so
what a number measures and why travels with the data instead of living only in a
source comment a reader has to go find:

```ts
group(
  "repaint",
  () => {
    task("1,000 chars", () => repaint(doc1k))
    task("4,000 chars", () => repaint(doc4k), {
      description: "worst case: full repaint every keystroke at the max document size",
    })
  },
  { description: "editor repaint cost as document size grows" },
)
```

Mark one task per group as the `Relative` reference with `{ baseline: true }`
(mirrors mitata's `baseline()`); otherwise `Relative` defaults to the fastest
task in the group:

```ts
group("parse", () => {
  task("current impl", () => parse(buf), { baseline: true })
  task("candidate impl", () => parseFast(buf))
})
```

`task.skip(...)` / `group.skip(...)` register without measuring: the runner never
samples them, but the document still carries the workload (marked
`Workload.skipped`), so a renderer prints `- skipped` instead of the task just
being absent, and `compare` reports it as `unchanged` (with a `skipped` warning)
rather than silently passing or failing to match a baseline. `task.only(...)` /
`group.only(...)` restrict a suite file to only the `.only`-marked tasks - `--filter`
still applies on top - and print a one-line notice (`bench: 2 task(s) selected by
.only`) to stderr, so a forgotten `.only` doesn't quietly narrow a run in CI:

```ts
group("parse", () => {
  task.only("fast path", () => parse(buf)) // only this task runs this time
  task("slow path", () => parseSlow(buf))
  task.skip("flaky on CI", () => parseFlaky(buf))
})
```

### `sweep(dims, fn)` → `void`

Cartesian product over one or more named dimensions, calling `fn` once per point.
`task()` calls inside `fn` automatically inherit that point as `Workload.params` -
a structured alternative to baking the point into the task name, so renderers can
pivot on it and `compare` matches on the same point across runs instead of just a name:

```ts
import { group, task, range, sweep } from "ostia"

group("parse", () => {
  sweep({ size: range(100, 10_000), impl: ["current", "fast"] }, ({ size, impl }) => {
    const input = buildInput(size) // setup, runs once per point, unmeasured
    task(`${impl}`, () => impls[impl](input))
  })
})
```

An explicit `{ params }` on a particular `task()` call merges over (and wins
against) the current sweep point:

```ts
task(`${impl}`, () => impls[impl](input), { params: { size, impl, variant: "warm" } })
```

`--format minimal` includes `params` on every line. The markdown renderer pivots a
group into a table (rows = first dimension, columns = second) when every task in
it shares the same two param keys - exactly what the example above produces - and
otherwise renders params as a `key=value` suffix on the task name.

### `range(start, end, multiplier?)` → `number[]`

Geometric point generator that feeds `sweep()` (and works standalone) - mitata's
`.range(name, start, end, multiplier)` point generation (default multiplier `8`,
always ending on `end` even if the last step overshot it), without the name
templating: build the task name yourself.

```ts
range(100, 10_000)   // -> [100, 800, 6400, 10000]
range(100, 100_000)  // -> [100, 800, 6400, 51200, 100000]
```

```ts
// demo.ts
import { bench } from "ostia"

const doc = await bench({
  suites: ["suite.ts"],
  budgetMs: 500, // `timeBudgetMs` is a deprecated alias
  // samples: 50,   // exact per-task trial count instead of a budget
  minSamples: 50,
  jobs: 1, // suite files at once; > 1 trades fidelity for wall time
  noiseCheck: true, // default; set false to skip the ~200ms noise floor measurement
})
```

### `compareDocuments(base, cand, thresholds?)` → `Comparison[]`

Same matching and thresholds as `ostia compare` / `ostia ci`.

```ts
const diffs = compareDocuments(baselineDoc, candidateDoc, {
  timingPct: 5,
  frameSelfPct: 10,
  heapTypePct: 10,
  minFrameSelfUs: 1000,
  alpha: 0.01, // Mann-Whitney significance level
  bootstrapIterations: 2000,
})
```

### `saveDocument` / `loadDocument`

```ts
await saveDocument(doc, "doc.json")
const loaded: ProfileDocument = await loadDocument("doc.json")
```

### `renderers`

Pure functions of a `ProfileDocument`. Each returns `{ text? }` and/or `{ files? }`.

| Name | Output |
|---|---|
| `table` | terminal timing / CPU / heap / comparison text |
| `markdown` | agent- and human-readable report |
| `json` | pretty JSON document |
| `jsonl` | one metadata line, then one line per run |
| `minimal` | one compact line per timing run, no sample array; for LLM/CI consumption |
| `collapsed` | folded stacks (`name;name;name count`) |
| `mermaid` | top-N call tree |
| `speedscope` | speedscope.app JSON |
| `cpuprofile` | verbatim `.cpuprofile` when a CDP artifact exists |

```ts
const { text } = await renderers.markdown.render(doc)
const { files } = await renderers.collapsed.render(doc, {
  measurementId: someCpuMeasurementId,
})
```

Units in the IR are fixed: ns (time), bytes (memory), µs (sampling interval).

## Examples

[`examples/`](examples/) has six runnable recipes (they spawn `../../src/cli/main.ts`
or import `../../src` directly; no install step):

- [`compare-two-commands`](examples/compare-two-commands/). Relative timing table.
- [`find-a-hotspot`](examples/find-a-hotspot/). `--cpu` plus collapsed / Mermaid viz.
- [`heap-usage`](examples/heap-usage/). `--heap` type breakdown.
- [`gate-a-regression`](examples/gate-a-regression/). Config, local baseline, and `ostia ci`.
- [`profile-in-process`](examples/profile-in-process/). `profile(fn, { origin: "jsc" })`.
- [`benchmark-a-function`](examples/benchmark-a-function/). `bench()` / `group()` / `task()`.

```sh
cd examples/find-a-hotspot && bun run demo
bun run examples   # all of them from the repo root
```
