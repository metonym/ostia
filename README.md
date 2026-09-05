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
ostia run --runs 10 --warmup 2 "bun fixtures/fast.ts" "bun fixtures/slow.ts"
```

```
Command                Mean [ms]        Min…Max [ms]        Relative
--------------------------------------------------------------------
bun fixtures/fast.ts   8.413 ± 1.340    7.623…12.365        1.00×
bun fixtures/slow.ts   21.712 ± 1.157   20.831…24.220       2.62× slower
```

Find a CPU hotspot (profiler runs as a separate labeled trial, never mixed into the
timing numbers above):

```sh
ostia run --runs 5 --cpu --cpu-interval 200 --export-json node_modules/.cache/ostia/doc.json fixtures/work.ts
```

```
Command                Mean [ms]        Min…Max [ms]
----------------------------------------------------
bun fixtures/work.ts   275.815 ± 2.853  273.334…281.384

CPU capture - bun fixtures/work.ts (instrumented, 200µs interval, diagnostic wall 297.578ms)
  100.0%    284.19ms self  hashLoop
    0.0%      0.00ms self  (root)
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
ostia report <document.json> render a saved document
ostia viz <document.json>    render CPU evidence to a file format
ostia ci                     run configured workloads vs a baseline, gate regressions
```

Every subcommand takes `--help` for its full flag list.

### `ostia time`

`ostia run` is kept as an alias for anyone migrating from hyperfine.

Clean wall-clock timing by default. `--cpu` / `--heap` schedule one extra instrumented
trial each, labeled separately in the document.

```sh
ostia time "bun a.ts" "bun b.ts"
ostia time --runs 25 --warmup 3 --cpu --heap "bun src/server.ts"
ostia time --format json --export-json out.json "bun a.ts"
```

Timing table (two commands get a Relative column automatically):

```
Command                Mean [ms]        Min…Max [ms]        Relative
--------------------------------------------------------------------
bun fixtures/fast.ts   8.413 ± 1.340    7.623…12.365        1.00×
bun fixtures/slow.ts   21.712 ± 1.157   20.831…24.220       2.62× slower
```

Heap summary (type counts from the snapshot trial):

```
Command                    Mean [ms]        Min…Max [ms]
--------------------------------------------------------
bun fixtures/allocate.ts   27.079 ± 6.844   23.888…91.799

Heap snapshot - bun fixtures/allocate.ts (instrumented, 2518 objects, 0.12MB)
    1369  string
     426  code
     321  closure
     216  object shape
     104  hidden
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
ostia bench --time-budget 500 --min-samples 50 bench/stats.ts
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
Command                                  Mean [ms]        Min…Max [ms]        Relative
--------------------------------------------------------------------------------------
stats/computeTimingStats (1e3 samples)   0.014 ± 0.016    0.012…0.598         1.00×
stats/computeTimingStats (1e4 samples)   0.484 ± 0.052    0.434…0.680         38.22× slower
stats/timingWarnings (1e3 samples)       0.036 ± 0.020    0.032…0.541         2.82× slower
```

### `ostia compare`

Match workloads by id, rank timing / frame / heap deltas, print a verdict per workload.

```sh
ostia compare before.json after.json
ostia compare after.json --baseline .ostia/baselines/main.json
```

```
✓ bun fixtures/fast.ts
  timing: -2.9% median (unchanged)

✗ work
  timing: +1249.2% median (regressed)
```

### `ostia report`

Render a saved `ProfileDocument` without re-running anything.

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
{"task":"diffText()/append at end","group":"diffText()","samples":9282,"mean":50213.4,"median":49871,"stddev":2104.7,"stddevPct":4.19,"min":48120,"max":81002,"relative":1,"warnings":[],"unit":"ns"}
{"task":"repaint/4000 chars","group":"repaint","description":"full repaint every keystroke","samples":3,"mean":2.61e9,"median":2.4e9,"stddevPct":15.3,"relative":47800,"warnings":[{"code":"low-sample-count","data":{"samples":3,"target":10}}],"unit":"ns"}
```

`ostia compare ... --format minimal` adds `delta: { medianPct, meanPct, verdict, pass }` to
each line, so "did this PR regress" is `lines.some(l => l.delta?.verdict === "regressed")`.

Markdown:

```
# Profile Report

Bun 1.4.0 · ostia 0.1.0 · darwin/arm64 · 2026-09-04T03:46:02.961Z

## Timing

| Command | Mean ± SD (ms) | Min…Max (ms) | Median (ms) |
|---|---|---|---|
| bun -e 1 | 5.477 ± 0.303 | 5.153…5.882 | 5.396 |
```

### `ostia viz`

Turn CPU evidence into files for other tools. Formats: `collapsed`, `mermaid`,
`speedscope`, `cpuprofile` (pass-through of a real CDP artifact when present).

```sh
ostia viz doc.json --format collapsed
ostia viz doc.json --format mermaid
ostia viz doc.json --format speedscope > flame.json
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
  compareDocuments,
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
  runs: 10,
  warmup: 2,
  cpu: true,
  heap: false,
  cpuIntervalUs: 200,
  outDir: "node_modules/.cache/ostia", // default; artifacts land under here
})
```

`run` is exported too, as a `@deprecated` alias of `time` for one release.

### `profile(fn, opts)` → `{ result, run }`

In-process capture. `origin: "jsc"` is the only path that reports JIT tiers
(LLInt / Baseline / DFG / FTL). Default `origin: "inspector"` writes portable CDP-shaped
evidence instead.

```ts
const { result, run } = await profile(() => hashLoop(8_000_000), {
  origin: "jsc",
  intervalUs: 100,
})

console.log(run.jit?.tiers)
// {
//   llint: 0,
//   baseline: 9,
//   dfg: 37,
//   ftl: 2825,
// }
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

All module-scope code in a suite file runs up front, before any task is sampled -
there's no hook that runs a task's own setup immediately before its sampling and
its teardown immediately after, the way mitata's generator-based `bench()` drove
one case to completion before starting the next. If a suite builds more than one
instance of something stateful (a mounted UI component, an open connection, a
server) at module scope, every instance already exists by the time any task
samples - so a query has to be scoped to the instance it belongs to, not written
against a global/ambient lookup that assumes it's the only one alive. Porting a
mitata suite that opens a component's menu and queries `getByRole(...)`
unscoped, for example, breaks once a second instance of that component exists
in the document; scope the query with something like `within(instance.container)`
instead.

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

### `range(start, end, multiplier?)` → `number[]`

Geometric sweep points for parameterizing `task()` over a size dimension - mitata's
`.range(name, start, end, multiplier)` point generation (default multiplier `8`, always
ending on `end` even if the last step overshot it), without the name templating: build
the task name yourself in the loop.

```ts
import { group, task, range } from "ostia"

group("parse", () => {
  for (const size of range(100, 10_000)) {
    const input = buildInput(size) // setup, runs once per point, unmeasured
    task(`${size} items`, () => parse(input))
  }
})
```

```ts
range(100, 10_000)   // -> [100, 800, 6400, 10000]
range(100, 100_000)  // -> [100, 800, 6400, 51200, 100000]
```

```ts
// demo.ts
import { bench } from "ostia"

const doc = await bench({
  suites: ["suite.ts"],
  timeBudgetMs: 500,
  minSamples: 50,
  jobs: 1, // suite files at once; > 1 trades fidelity for wall time
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
