# ostia

ostia is a profiling and benchmarking toolkit for Bun. It times subprocess commands
(like hyperfine) and in-process functions (like mitata), optionally captures CPU
profiles, heap snapshots, JIT tiers, retained heap and peak memory, and writes everything
to one schema-versioned JSON document (`ProfileDocument`). Two documents compare with a
bootstrap confidence interval and a Mann-Whitney test, with the regression threshold
widened to the machine's measured noise floor. `ostia ab` pairs the working tree against
a git ref in one process, which holds up on machines too noisy for that. `ostia ci` gates
a config file of workloads against a saved baseline, and `--format minimal` gives scripts
and LLM agents a compact JSON line protocol. The CLI is a thin wrapper over the library, so anything
`ostia time`/`ostia bench` do, `time()`/`bench()` do too.

Zero runtime dependencies. Requires Bun ≥ 1.4.

## Install

```sh
bun add ostia
```

## Quick start

### Time two commands

```sh
ostia time --samples 10 "bun fixtures/fast.ts" "bun fixtures/slow.ts"
```

```
Apple M2 · 8 cores · load 3.6 · noise floor 0.5%

Task                   Median     Spread             Range              User/Sys           Relative
---------------------------------------------------------------------------------------------------
bun fixtures/fast.ts   9.38 ms    9.52 ms…9.74 ms    9.10 ms…9.76 ms    6.98 ms/3.06 ms    1.00×
bun fixtures/slow.ts   23.2 ms    23.3 ms…23.8 ms    23.0 ms…23.9 ms    20.9 ms/2.89 ms    2.47× slower
  ! outliers-detected

Warnings:
  bun fixtures/slow.ts: 1 outlier(s) detected (1 severe, 0 mild).
```

The header line shows the machine, its load average, and the noise floor from a ~200ms
reference measurement taken once per run (`--no-noise-check` skips it). Spread is
p75…p99; User/Sys is the median user/system CPU time per trial.

### Benchmark a function

```ts
// suite.ts
import { group, task } from "ostia"

const input = Array.from({ length: 2_000 }, (_, i) => i % 500)

group("dedupe", () => {
  task("naive (indexOf scan, O(n²))", () => dedupeNaive(input))
  task("Set-based (O(n))", () => [...new Set(input)])
})
```

```sh
ostia bench suite.ts
```

```
Apple M2 · 8 cores · load 3.5 · noise floor 0.4%

Task                            Median     Spread             Range              Relative
-----------------------------------------------------------------------------------------
dedupe:
  naive (indexOf scan, O(n²))   173.9 µs   180.4 µs…205.8 µs  170.1 µs…635.5 µs  7.40× slower
  Set-based (O(n))              23.5 µs    24.9 µs…72.5 µs    18.7 µs…208.3 µs   1.00×
```

### Check a change for regressions

Commit the suite, then change the code: say the Set-based dedupe becomes
`input.filter((x, i) => input.indexOf(x) === i)`.

```sh
ostia ab suite.ts   # every task: working tree vs HEAD, paired in one process
```

```
A/B: working tree vs HEAD (3945768) · 15 rounds · threshold 10% · geomean threshold 1.5%

Task                            Base       Candidate  Change    p25…p75            Verdict
------------------------------------------------------------------------------------------
dedupe:
  naive (indexOf scan, O(n²))   183.5 µs   178.5 µs   -1.9%     -3.5%…-0.3%
  Set-based (O(n))              25.2 µs    181.2 µs   +618.1%   +554.2%…+659.2%    regressed, confirmed (repeats: +630.6%, +584.5%)

Geomean +165.4% (threshold 1.5%) · 1 regressed, 0 improved, 1 unchanged of 2 · fail
```

Base and candidate run in alternating ~10ms batches, so machine drift cancels within each
round; a flagged task counts only if two fresh processes agree. Exit 1 on a regression.

### Gate CI on a baseline

```json
// ostia.config.json
{
  "samples": 10,
  "workloads": [
    { "label": "work", "command": ["bun", "fixtures/work.ts"], "inputs": ["fixtures/**"] }
  ]
}
```

```sh
ostia baseline save   # on known-good code: writes .ostia/baselines/main.json
ostia ci              # on your change: exit 1 on a regression
```

```
1 workloads
0 cached
1 executed
0 passed  1 regressed (+44.1% median on work)

Profile CI: ✗
...
✗ work
  timing: +44.1% median, 95% CI [+41.4%, +45.6%], p<0.001 (regressed)
```

Scratch output (cache, artifacts) goes to `node_modules/.cache/ostia`. Baselines go to
`.ostia/baselines/` so they survive reinstalls; add `.ostia/` to `.gitignore`.

## Using ostia from an AI agent

`--format minimal` (on `time`, `bench`, `ab`, `compare`, `report`, `ci`) prints one JSON
object per line on stdout and nothing else. Every line has `event` and
`protocolVersion: 2`. Timing values are in nanoseconds.

```sh
ostia time --samples 10 "bun a.ts" --format minimal
ostia compare before.json after.json --format minimal
ostia ci --format minimal; echo $?
```

| `event` | When | Key fields |
|---|---|---|
| `run` | One per timing measurement, every command | `workloadId`, `task`, `group?`, `params?`, `skipped?`, `unit`, `samples` (0 when no trial produced one), `batch`, `mean`/`median`/`stddev`/`stddevPct`/`min`/`max`/`p75`/`p99`/`mad`, `userNs`/`systemNs` (subprocess only), `retainedBytesPerOp?`/`peakBytes?` (`--alloc`/`--peak-mem`), `relative?`, `noiseFloorPct?`, `warnings[]`, `threw?` (`ab`, a task that threw), on `compare`/`ci`: `delta: { medianPct, meanPct, verdict, pass, ci95?, pValue?, effectiveTimingPct, matched }`, and on `ab`: `paired: { baseMedian, medianRatio, ratioP25, ratioP75, rounds, verdict, flagged?, confirmed?, repeats?, sameOutput, suiteChanged?, retained?, peak? }` |
| `unmatched` | One per workload on only one side of `compare`/`ci`/`ab` | `workloadId`, `task`, `side: "base" \| "cand"` |
| `summary` | Last line of `compare`/`ci`/`ab` only | `command`, `matched`/`regressed`/`improved`/`unchanged`/`unmatched`, `cached`/`executed`/`failed`/`missingBaseline` (`ci`), `geomeanPct`, `effectiveTimingPct`, `noiseFloorPct?`, `baseline?` (`ci`), `base?`/`geomeanThresholdPct?`/`unconfirmed?`/`outputDiffers?`/`notComparable?`/`threw?`/`newSuites?`/`memory?` (`ab`), `git?`, `exportedTo?`, `verdict`, `exitCode` |

```
{"event":"run","protocolVersion":2,"schemaVersion":2,"workloadId":"wl_11e8562f3622d528","task":"work","unit":"ns","samples":10,"batch":1,"mean":21012800,"median":20999900,"stddev":231456,"stddevPct":1.1015,"min":20664000,"max":21552300,"warnings":[{"code":"outliers-detected","data":{"mild":1,"severe":0}}],"p75":21086100,"p99":21517600,"mad":126625,"userNs":15519000,"systemNs":6015500,"noiseFloorPct":2.09286,"delta":{"medianPct":44.0989,"meanPct":43.9626,"verdict":"regressed","pass":false,"effectiveTimingPct":10,"matched":true,"ci95":[41.4394,45.5841],"pValue":0.000157103}}
{"event":"summary","protocolVersion":2,"command":"ci","matched":1,"regressed":1,"improved":0,"unchanged":0,"unmatched":0,"geomeanPct":44.098920968212305,"effectiveTimingPct":10,"verdict":"fail","exitCode":1,"cached":1,"executed":0,"failed":0,"missingBaseline":0,"baseline":{"name":"main","path":".ostia/baselines/main.json"},"noiseFloorPct":2.09286}
```

Within `protocolVersion: 2`, keys are only ever added, never renamed or removed.

Exit codes, the same for every command:

| Code | Meaning |
|---|---|
| `0` | Pass |
| `1` | At least one workload regressed (`compare`/`ci`/`ab` only; `time`/`bench` never return 1) |
| `2` | Harness error: a command exited non-zero or produced no samples, a suite failed, nothing matched, a bad flag, a missing/invalid config or baseline |
| `130` | Cancelled with Ctrl-C (`time`/`bench`/`ab`/`ci`; partial results are still exported) |

On exit 2, stderr's last line is `{"event":"error","protocolVersion":2,"code":...,"message":...,"data"?:...}`
when stderr is not a TTY or a machine format (`minimal`/`json`/`jsonl`) was requested.
A person at a terminal sees only the prose message. `code` is one of `invalid-flag`,
`config-missing`, `config-invalid`, `baseline-missing`, `no-matches`, `spawn-failed`, `suite-failed`,
`command-failed`, `timeout`, `time-source-no-match`, `document-load-failed`,
`no-cpu-evidence`, `internal`. Full reference: [docs/agent-protocol.md](docs/agent-protocol.md).

## Commands

Every command takes `--help`. Per-flag detail is in [docs/cli.md](docs/cli.md).

### `ostia time`

Times commands as subprocesses. `--cpu`/`--heap` add one separate instrumented trial each;
the profiler never runs during timing trials.

```sh
ostia time "bun a.ts" "bun b.ts"
ostia time --samples 25 --cpu --heap "bun src/server.ts"
ostia time --prepare "rm -rf dist" "bun build.ts"
ostia time --time-source "built in (\d+)ms" "bun build.ts"
```

- Each command string is whitespace-split into argv, with no shell. Everything after
  `--` is one more command's argv, verbatim: `ostia time -- bun -e "console.log('a b')"`.
- Default sampling: 3 warmup trials, then trials until ~3s have elapsed and at least 10
  ran. `--samples N` gives an exact count per command; `--budget MS`/`--min-samples N`
  tune the loop.
- With 2+ commands, trials round-robin across commands (`--no-interleave` to run them
  one after another).
- A command stops at its first non-ignored non-zero exit, and `ostia time` exits 2.
  `--ignore-failure[=CODE,...]` treats the listed codes (bare: all) as success.

### `ostia bench`

Runs in-process `group()`/`task()` suites. Each suite file runs in its own child process.

```sh
ostia bench bench/*.ts
ostia bench bench/*.ts --filter parse --cpu --alloc
ostia bench bench/*.ts --filter large --peak-mem
ostia bench bench/*.ts --isolate
ostia bench --preload ./bench/dom-setup.ts --bun-flags="--conditions=browser" bench/*.ts
```

- Each task samples for `--budget` ms (default 500). Fast calls are batched so one trial
  spans at least 1µs; the budget-driven loop stops at 20,000 trials.
- `--isolate` runs every task in its own process, isolating JIT state, builtin call-site
  feedback (e.g. `Array.prototype.map`) and GC heap from other tasks. Use it when you need
  the most comparable numbers.
- `--jobs N|auto` runs suite files in parallel. Faster, but noisier; keep the default of 1
  for anything you `compare` or gate in `ci`.
- `--cpu` profiles each task at 100µs for about 2,000 samples (`--cpu-interval` changes
  the interval). Inlined helpers count as their callers' self time.
- `--alloc` reports the heap each call *retains* after a full GC: a leak check, not an
  allocation count. `--peak-mem` reports how far the task's first call raises RSS,
  garbage included, in 3 fresh processes (`OSTIA_PEAK_MEM=1` is set there, so a suite can
  skip heavy setup that would peak first).
- With no files, `ostia bench` uses the config's `bench` section. Each flag overrides its
  config field; `--no-gc`/`--no-cpu`/`--no-alloc`/`--no-peak-mem`/`--no-isolate` override
  a config `true`.

### `ostia ab`

Runs suites on a git ref's committed tree and on the working tree in one process,
alternating short batches, and gates on the per-round time ratio.

```sh
ostia ab bench/*.ts                    # vs HEAD
ostia ab bench/*.ts --base origin/main
ostia ab bench/*.ts --threshold 5 --rounds 21
```

- The same suite files as `ostia bench`, unchanged. The ref's tree is extracted once per
  commit under `node_modules/.cache/ostia/ab/`; relative imports resolve within each tree,
  package imports to the project's `node_modules`.
- Files git doesn't hold (generated or gitignored sources) aren't in the base tree.
  `--base-setup "bun scripts/generate.ts"` (or `ab.setup` in the config) builds them once
  per tree, with the project's `node_modules` linked in.
- A task is flagged when its median ratio moves past `--threshold` (default 10%) in at
  least three quarters of rounds, and counts only if `--confirm` (default 2) fresh
  processes agree. Each suite runs once with each side first, since the side that goes
  first can run faster. The run also fails when the geometric mean of all ratios is more than
  `--geomean-threshold` (default 1.5%) slower.
- Tasks whose first call returns different values on each side are listed (not a
  failure). The base side runs the base's copy of each suite, so a task whose suite file
  changed is marked `suite-changed`; if its output changed too, it reads `not comparable`
  and stays out of the verdict. A task that throws reads `base threw`, `candidate threw` or
  `both threw` and isn't timed; one that throws on the candidate side only fails the run.
  Exit: `0` pass, `1` regression (time or memory), `2` nothing paired or a harness error.
- `--alloc` and `--peak-mem` compare memory too: retained heap per call, and how far the
  first call raises RSS. A reading that grows past `--mem-threshold` (default 10%) and
  past its noise floor fails the run.
- Progress goes to stderr on a terminal; `--progress` turns it on in logs and pipes too.
- The 5 most recently used base trees stay cached (`--keep-trees`); `ostia ab --clean`
  removes them all.

### `ostia compare`

Matches two documents' workloads by id and reports a verdict per workload.

```sh
ostia compare before.json after.json
ostia compare after.json --baseline .ostia/baselines/main.json
ostia compare before.json after.json --format markdown
```

```
✗ bun fixtures/work.ts
  timing: +23.8% median, 95% CI [+18.3%, +30.1%], p<0.001 (regressed)
```

A regression needs the whole 95% CI above the threshold and a Mann-Whitney p-value below
`alpha` (default 0.01). Thresholds come from the config file when one exists, otherwise
the defaults (`timingPct: 5`). The bootstrap is seeded from the samples, so the same two
documents always give the same verdict. See [docs/statistics.md](docs/statistics.md).
Exit: `0` pass, `1` regression, `2` nothing matched or a load error.

### `ostia report`

Renders a saved document without re-running anything.

```sh
ostia report doc.json --format markdown
ostia report doc.json --format minimal
ostia report doc.json --format speedscope --out-dir viz/
ostia report doc.json --format collapsed | flamegraph.pl > flame.svg
```

Formats: `table` (default), `json`, `jsonl`, `markdown`, `minimal`, and, for documents
with CPU evidence, `collapsed`, `mermaid`, `speedscope`, `cpuprofile`. `time`, `bench`,
`compare` and `ci` accept only the first five; export a document and use `report` for the
visualization formats.

### `ostia ci`

Runs the config's workloads, compares them against a named baseline, and exits 1 on a
regression.

```sh
ostia ci
ostia ci --full                  # ignore the cache
ostia ci --baseline release
ostia ci --save-baseline         # after a pass, make this run the new baseline
```

- Command workloads are cached by their declared `inputs`: no `inputs` field always
  reruns; `inputs: []` means "depends on nothing" and caches; otherwise the run is reused
  while the matched files' contents are unchanged. `suites` workloads always run.
- `suites` workloads run with the config's `bench` section, the same way `ostia bench`
  reads it.
- Exit 2 if any command workload exits non-zero (not ignored) or produces no samples, or
  if the baseline file is missing. A baseline that matches none of the configured
  workloads is also an error; one missing only some lists them and carries on
  (`onMissingBaseline` in the config changes this).

### `ostia baseline`

```sh
ostia baseline save              # measure the configured workloads -> .ostia/baselines/main.json
ostia baseline save my-feature
ostia baseline list
ostia baseline show main --format markdown
```

`save` uses the same measurement code path as `ci`. `show` accepts `report`'s flags.

## Library API

```ts
import {
  time, bench, ab, group, task, sweep, range, run, profile, keep,
  compareDocuments, defineConfig, createDocument, loadDocument, saveDocument, renderers,
} from "ostia"
import type { ProfileDocument, MinimalEvent } from "ostia"
```

| Export | Does |
|---|---|
| `time(opts)` | Subprocess timing, same as `ostia time`. Returns a `ProfileDocument`. |
| `bench(opts)` | Runs suite files, same as `ostia bench`. |
| `ab(opts)` | Paired A/B of suite files against a git ref, same as `ostia ab`. |
| `group(name, fn, opts?)` / `task(name, fn, opts?)` | Register in-process tasks; `.skip`/`.only` variants. |
| `sweep(dims, fn)` / `range(start, end, mult?)` | Parameter sweeps; tasks inherit the point as `params`. |
| `run(opts?)` | Runs the tasks registered in the current file, in this process (`bun suite.ts`). |
| `profile(fn, opts?)` | In-process CPU capture; `origin: "jsc"` adds JIT tier data. |
| `keep(value)` | Pins an intermediate value against dead-code elimination. |
| `compareDocuments(base, cand, thresholds?)` | Same comparison as `ostia compare`. |
| `defineConfig(config)` | Typing helper for `ostia.config.ts`. |
| `createDocument` / `loadDocument` / `saveDocument` | Build, read (schema v2 only), and write documents. |
| `renderers` | `table`, `markdown`, `json`, `jsonl`, `minimal`, `collapsed`, `mermaid`, `speedscope`, `cpuprofile`. |

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

Full reference, including task options, hooks, and a mitata/hyperfine migration table:
[docs/library.md](docs/library.md).

## Configuration

`ostia.config.ts` (checked first) or `ostia.config.json`, in the current directory.

```ts
// ostia.config.ts
import { defineConfig } from "ostia"

export default defineConfig({
  baseline: "main",
  samples: 15, // command workloads; or budgetMs/minSamples
  warmup: 3,
  thresholds: { timingPct: 5 },
  workloads: [
    { label: "cold-start", command: ["bun", "src/cli.ts", "--help"], inputs: ["src/**/*.ts"] },
    { label: "spawn", command: ["bun", "-e", "1"], inputs: [] },
    { label: "build:cold", command: ["bun", "build.ts"], prepare: "rm -rf dist" },
    { label: "suites", suites: ["bench/*.ts"] },
  ],
  bench: { budgetMs: 500, isolate: true, preload: ["bench/setup.ts"] },
})
```

A config with a wrong-typed value, or the old `runs` field, fails to load with a message
naming the key (error code `config-invalid`). All fields: [docs/config.md](docs/config.md).

## Documentation

- [docs/cli.md](docs/cli.md): every command and flag
- [docs/config.md](docs/config.md): config file reference
- [docs/library.md](docs/library.md): library API reference
- [docs/agent-protocol.md](docs/agent-protocol.md): `--format minimal`, exit codes, error codes
- [docs/statistics.md](docs/statistics.md): sampling, the comparison test, noise floor
- [docs/document-schema.md](docs/document-schema.md): `ProfileDocument`, workload ids, warnings
- [docs/preload-recipes.md](docs/preload-recipes.md): jsdom, happy-dom and `Bun.plugin()` preloads

## Examples

[`examples/`](examples/) has runnable recipes (they use `../../src` directly, no install):
[`compare-two-commands`](examples/compare-two-commands/),
[`find-a-hotspot`](examples/find-a-hotspot/),
[`heap-usage`](examples/heap-usage/),
[`gate-a-regression`](examples/gate-a-regression/),
[`profile-in-process`](examples/profile-in-process/),
[`benchmark-a-function`](examples/benchmark-a-function/).

```sh
cd examples/find-a-hotspot && bun run demo
bun run examples   # all of them, from the repo root
```
