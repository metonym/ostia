# Library API

The CLI is a thin wrapper over these functions; both produce the same `ProfileDocument`
([document-schema.md](document-schema.md)).

```ts
import {
  time, profile, bench, ab, group, task, sweep, range, run, keep,
  compareDocuments, DEFAULT_THRESHOLDS, defineConfig,
  createDocument, loadDocument, saveDocument, OstiaDocumentError,
  renderers, MINIMAL_PROTOCOL_VERSION,
} from "ostia"
import type {
  ProfileDocument, Workload, Comparison, Warning, WarningCode, CompareResult, Thresholds,
  TaskOptions, GroupOptions, RunOptions, OstiaConfig, OstiaConfigInput, WorkloadConfig,
  TimeOptions, CommandSpec, PrepareHook, PrepareFn, PrepareRun, TimeSource, TimeUnit,
  MinimalEvent,
} from "ostia"
```

## `time(opts)` → `Promise<ProfileDocument>`

Subprocess timing; the same behavior as `ostia time` ([cli.md](cli.md#ostia-time)).

```ts
const controller = new AbortController()
const doc = await time({
  commands: ["bun a.ts", ["bun", "-e", "console.log('a b')"]],
  prepare: "rm -rf dist",       // before every trial; or ({ phase, index }) => ...
  timeSource: { pattern: /in (\d+)ms/, unit: "ms" },
  samples: 10,                  // or budgetMs / minSamples
  warmup: 2,
  interleave: true,             // default with 2+ commands
  cpu: true,
  heap: false,
  cpuIntervalUs: 1000,          // default
  cwd: "packages/app",
  env: { NODE_ENV: "production" },
  outDir: "node_modules/.cache/ostia",
  noiseCheck: true,
  timeoutMs: 30_000,            // no default
  ignoreExitCodes: [1],
  signal: controller.signal,
})
```

A command is a string (whitespace-split, no shell), an argv array, or an object
`{ command, label?, prepare?, timeSource?, timeoutMs?, ignoreExitCodes? }` whose fields
override the top-level ones for that command. That's how one command becomes several
labeled workloads:

```ts
const build = ["bun", "cli.ts", "build", "fixture"]
const inMs = { pattern: /in (\d+)ms/ }
const doc = await time({
  commands: [
    { command: build, label: "warm", timeSource: inMs },
    { command: build, label: "incremental", timeSource: inMs, prepare: () => touchPost() },
    { command: build, label: "cold", timeSource: inMs, prepare: "rm -rf fixture/dist" },
    { command: build, label: "wall clock" },
  ],
  samples: 5,
})
```

A `prepare` function receives `{ phase, index }` with `phase` one of `"warmup"`,
`"timing"`, `"cpu"`, `"heap"`. A `RegExp` `timeSource` pattern must not have the `g`, `y`
or `d` flag; `time()` rejects with a `RangeError` before running anything.

A command stops at its first non-ignored non-zero exit. `time()` still resolves; check
`Trial.exitCode` or the `nonzero-exit` warning. Aborting `signal` kills in-flight
children and resolves with the measurements completed so far, the last one carrying an
`aborted` warning.

## `profile(fn, opts?)` → `Promise<{ result, measurement, document }>`

CPU capture of a function in the current process. The default `origin: "inspector"`
produces CDP-shaped evidence; `origin: "jsc"` uses `bun:jsc`'s sampling profiler and adds
JIT tier counts (LLInt / Baseline / DFG / FTL).

```ts
const { result, measurement, document } = await profile(() => hashLoop(8_000_000), {
  origin: "jsc",
  intervalUs: 100,  // default 1000
})
measurement.jit?.tiers // { llint: 0, baseline: 9, dfg: 37, ftl: 2825 }
const { files } = await renderers.collapsed.render(document, {})
```

`document` holds the one workload and measurement. An already-aborted `signal` runs `fn`
without the profiler and returns an `aborted` warning in place of CPU evidence; a signal
can't interrupt `fn` once it's running.

## Suites: `group()`, `task()`, `bench()`

```ts
// suite.ts
import { group, task } from "ostia"

group("parse", () => {
  task("small input", () => parse(smallBuf))
  task("large input", () => parse(largeBuf))
  task("full pipeline", () => build(), { budgetMs: 2000, minSamples: 10 })
})
```

```ts
const doc = await bench({
  suites: ["bench/parse.ts"],
  budgetMs: 500,       // per task; default 500
  // samples: 50,      // exact per-task count instead
  minSamples: 20,
  jobs: 1,
  isolate: false,
  gc: false,
  cpu: false,
  cpuIntervalUs: 100,  // default
  alloc: false,
  peakMem: false,
  filter: "parse/",
  preload: ["bench/setup.ts"],
  bunFlags: ["--conditions=browser"],
  timeoutMs: 60_000,
  outDir: "node_modules/.cache/ostia",
  cwd: process.cwd(),
  noiseCheck: true,
})
```

`bench()` runs each suite file in a child process (and each isolated task in its own),
exactly like `ostia bench` ([cli.md](cli.md#ostia-bench)). It rejects if a suite fails.
It also takes a `signal`: aborting kills in-flight suite processes and resolves with the
suites and tasks that had finished.

### `TaskOptions`

| Option | Meaning |
|---|---|
| `budgetMs`, `samples`, `minSamples` | Override the suite-wide sampling settings for this task. |
| `isolate`, `gc`, `cpu`, `alloc`, `peakMem` | Override the suite-wide flag (and the group's) for this task. |
| `baseline` | This task is the group's Relative reference (default: the group's fastest). |
| `description` | Stored as `Workload.description` and shown in `minimal` output. |
| `params` | Structured parameters; part of the workload id. Merged over the current `sweep()` point. |
| `before`, `after` | Run once, unmeasured, before the task's warmup and after its last trial, in the task's own process (works with `isolate`). |

`GroupOptions` takes `description`, `isolate`, `gc`, `cpu`, `alloc`, `peakMem`, `before` and `after`;
the flags are defaults for the group's tasks, and `before`/`after` run once around the
group's first and last measured task.

```ts
group(
  "editor",
  () => {
    let doc: Document
    task("append", () => doc.append(node), {
      before: () => { doc = mountDocument() },
      after: () => doc.destroy(),
      description: "worst case: full repaint at max document size",
    })
  },
  { before: setupSharedFixture, after: teardownSharedFixture, isolate: true },
)
```

Module-scope code in a suite file runs once, before any task is sampled. There is no
per-trial hook, since that would defeat batching; use `gc` or `isolate` for per-trial
concerns. Because `before`/`after` run once per task, a suite that creates several
instances of something stateful (a mounted component, a server) should scope its queries
to the instance, not to a global lookup that assumes only one exists.

Task functions and hooks may be async. Awaiting costs a microtask per call, so an async
task measures a few nanoseconds slower than the same synchronous body.

### `.skip` and `.only`

`task.skip()`/`group.skip()` register without measuring. The workload stays in the
document with `skipped: true`, prints as `- skipped`, and `compare` treats it as
unchanged with a `skipped` warning. `task.only()`/`group.only()` restrict the suite file
to the marked tasks (`--filter` still applies) and print `bench: N task(s) selected by
.only` to stderr so a forgotten `.only` is visible.

### `keep(value)`

A task's return value is already protected from dead-code elimination. Use `keep()` for
an intermediate value the task doesn't return:

```ts
task("parse then validate", () => {
  const ast = parse(input)
  keep(ast)
  return validate(ast)
})
```

## `sweep(dims, fn)` and `range(start, end, multiplier = 8)`

`sweep()` calls `fn` once per point of the Cartesian product of `dims`; `task()` calls
inside inherit the point as `params`, so each point is its own workload and `compare`
matches points across runs.

```ts
group("parse", () => {
  sweep({ size: range(100, 10_000), impl: ["current", "fast"] }, ({ size, impl }) => {
    const input = buildInput(size) // once per point, unmeasured
    task(impl, () => impls[impl](input))
  })
})
```

`range()` produces geometric points ending exactly on `end`: `range(100, 10_000)` is
`[100, 800, 6400, 10000]`. The markdown renderer pivots a group into a table (rows = first
dimension, columns = second) when all its tasks share the same two param keys; otherwise
params print as a `key=value` suffix.

## `run(opts?)` → `Promise<ProfileDocument>`

Runs the tasks registered in the current file, in the current process, prints a report,
and returns the document. For a suite run directly with `bun suite.ts`:

```ts
import { group, run, task } from "ostia"

group("parse", () => { task("small", () => parse(smallBuf)) })

try {
  await run({ filter: process.env.FILTER })
} finally {
  await cleanupFixtures()
}
```

Options: `filter`, `budgetMs`, `samples`, `minSamples`, `warmup` (a fraction of the
budget, default 0.1), `gc`, `cpu`, `cpuIntervalUs`, `alloc`, `noiseCheck`, `quiet` (don't
print), `format` (default `"table"`). There is no subprocess, so `isolate` and `peakMem`
are ignored; prefer `ostia bench` or `bench()` for numbers you will compare.

## `ab(opts)` → `Promise<ProfileDocument>`

Paired A/B timing of suite files against a git ref; the same behavior as `ostia ab`
([cli.md](cli.md#ostia-ab)). The suite files are the ones `bench()` runs, unchanged.

```ts
const doc = await ab({
  suites: ["bench/parse.bench.ts"],
  base: "origin/main",        // default "HEAD"; the candidate is the working tree
  baseSetup: ["bun scripts/generate.ts"], // run once in a freshly extracted base tree
  rounds: 15,                 // default
  thresholdPct: 10,           // default
  geomeanThresholdPct: 1.5,   // default
  confirm: 2,                 // fresh-process repeats per flagged task; default
  filter: "parse/",
  preload: ["bench/setup.ts"],
  bunFlags: ["--conditions=browser"],
  timeoutMs: 120_000,
  outDir: "node_modules/.cache/ostia",
  cwd: process.cwd(),
  noiseCheck: true,
})
doc.ab            // { base, matched, regressed, improved, unchanged, unconfirmed, outputDiffers, notComparable, threw, geomeanPct, verdict, ... }
doc.measurements  // one phase: "paired" measurement per paired task; `threw` instead of `timing` when it threw
if (doc.ab!.verdict === "fail") process.exitCode = 1
```

It rejects with a `RangeError` for bad settings, with an `AbBaseError` when `cwd` isn't
in a git repository or `base` isn't a commit, and with an `AbSetupError` (its message
ends with the command's output) when a `baseSetup` command fails. A task that returns its
result gets an output comparison between the two sides for free
(`paired.sameOutput`).

## `compareDocuments(base, cand, thresholds?)` → `CompareResult`

The comparison behind `ostia compare` and `ostia ci` ([statistics.md](statistics.md)).
`thresholds` defaults to `DEFAULT_THRESHOLDS` and must be complete; spread over the
defaults to change one field.

```ts
const result = compareDocuments(base, cand, { ...DEFAULT_THRESHOLDS, timingPct: 3 })
result.comparisons  // Comparison[], one per workload id in both documents
result.unmatched    // { baseOnly: Workload[], candOnly: Workload[] }
result.summary      // { matched, regressed, improved, unchanged, geomeanPct, effectiveTimingPct, verdict }
```

`ostia compare` stores these on the candidate document as `comparisons`,
`comparisonSummary` and `unmatched` (ids only).

## Documents

```ts
const doc = createDocument(workloads, measurements) // optional 3rd arg: environment
await saveDocument(doc, "doc.json")          // atomic write
const loaded = await loadDocument("doc.json") // throws OstiaDocumentError
```

`createDocument` stamps versions, platform, timestamp and git metadata. It's useful for
combining several `profile()` results:

```ts
const a = await profile(() => taskA())
const b = await profile(() => taskB())
const doc = createDocument(
  [a.document.workloads[0]!, b.document.workloads[0]!],
  [a.measurement, b.measurement],
)
```

`loadDocument` accepts `schemaVersion: 2` only.

## `renderers`

Each renderer is `{ name, render(doc, options) }` returning `{ text? }` and/or
`{ files? }`. Names: `table`, `markdown`, `json`, `jsonl`, `minimal`, `collapsed`,
`mermaid`, `speedscope`, `cpuprofile`. The visualization renderers take
`{ measurementId? }`.

```ts
const { text } = await renderers.markdown.render(doc, {})
const { files } = await renderers.speedscope.render(doc, { measurementId })
```

## `defineConfig(config)`

Returns its argument unchanged; it exists to type-check `ostia.config.ts`.
See [config.md](config.md).

## Coming from mitata or hyperfine

| mitata / hyperfine | ostia |
|---|---|
| `bench("name", fn)` | `task("name", fn)` |
| `run()` at the bottom of the file | `run()` at the bottom of the file |
| `baseline()` | `task(name, fn, { baseline: true })` |
| `.range(name, start, end, mult)` | `sweep({ name: range(start, end, mult) }, ...)` |
| generator setup (`function* () { ...; yield fn }`) | `task(name, fn, { before, after })` |
| `do_not_optimize(value)` | `keep(value)` |
| `hyperfine --runs N --warmup N` | `ostia time --samples N --warmup N` |
| `hyperfine --prepare CMD` | `ostia time --prepare CMD` |
| `hyperfine -i` / `--ignore-failure` | `ostia time --ignore-failure` |
| `hyperfine -L var a,b cmd-{var}` | one command per value, or `sweep()` for in-process code |
| `hyperfine --export-json` / `--export-markdown` | `--export-json PATH` / `--format markdown` |
