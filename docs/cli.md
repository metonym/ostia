# CLI reference

```
ostia time <command...>        time commands as subprocesses; optional --cpu / --heap capture
ostia bench <suite.ts...>      run in-process group()/task() suites
ostia ab <suite.ts...>         pair suites against a git ref in one process, gate on regressions
ostia compare <a> <b>          compare two ProfileDocuments
ostia report <document.json>   render a saved document
ostia ci                       run configured workloads against a baseline, gate on regressions
ostia baseline save|list|show  manage baseline documents
```

Every command takes `--help`. A flag's value can follow it (`--format minimal`) or be
attached (`--format=minimal`); `--ignore-failure[=CODES]` only takes the attached form. Exit codes and the machine-readable error
line are described in [agent-protocol.md](agent-protocol.md).

Output formats shared by `time`, `bench`, `ab`, `compare` and `ci`: `table` (default), `json`,
`jsonl`, `markdown`, `minimal`. `report` additionally accepts the CPU visualization
formats.

## `ostia time`

```
ostia time [flags] <command...>
ostia time [flags] -- <argv...>
```

| Flag | Meaning |
|---|---|
| `--samples N` | Exact trial count per command. The budget is ignored. |
| `--budget MS` | Sampling time budget per command (default: 3000). |
| `--min-samples N` | Floor on trials when `--samples` isn't given (default: 10). |
| `--warmup N` | Discarded warmup trials per command (default: 3). |
| `--no-interleave` | Run each command's trials to completion before the next command starts. |
| `--prepare CMD` | Run `CMD` before every trial, unmeasured. Once (all commands) or once per command. |
| `--time-source REGEX` | Take each trial's time from capture group 1 of the command's output. |
| `--time-unit UNIT` | Unit of the `--time-source` number: `ns`, `us`, `ms` (default), `s`. |
| `--cpu` | Capture one extra CPU-profile trial per command. |
| `--heap` | Capture one extra heap-snapshot trial per command. |
| `--cpu-interval US` | CPU sampling interval (default: 1000). |
| `--timeout MS` | SIGKILL a trial or `--prepare` hook that runs longer than `MS`. No default. |
| `--ignore-failure[=CODE,...]` | Treat these exit codes (bare: every code) as success. |
| `--out-dir PATH` | Artifact directory (default: `node_modules/.cache/ostia`). |
| `--no-noise-check` | Skip the ~200ms noise-floor measurement. |
| `--export-json PATH` | Write the document to `PATH`. |
| `--format FORMAT` | `table`, `json`, `jsonl`, `markdown`, `minimal`. |
| `--quiet` | Don't print the report. |

### Commands

Each `<command>` string is whitespace-split into argv, with no shell: no quoting,
globbing, pipes or redirection. Everything after `--` becomes one more command, given as
argv verbatim (never split or flag-parsed), so an argument can contain a space:

```sh
ostia time "bun a.ts" -- bun -e "console.log('a b')"
```

### Sampling

Default: 3 warmup trials, then timed trials until the budget (3s of wall time) has
elapsed and at least `--min-samples` (10) trials have run. `--samples N` runs exactly N
per command. With several commands, each gets its own N or its own budget.

With 2+ commands, trials run round-robin (one trial of each command, repeated) so drift
over the run (thermal throttling, a busy neighbor process) affects every command
equally. Each such measurement carries `interleaved: true`. `--no-interleave` runs the
commands one after another.

### Failures

A command's trial loop stops at its first non-zero exit that isn't ignored. That
trial's sample is kept, the measurement carries a `nonzero-exit` warning, and `ostia
time` exits 2. The same rule applies in `ostia ci`: any non-ignored non-zero exit, or no
samples at all, is a harness failure (exit 2), not a regression.

```sh
ostia time --ignore-failure=1 "./may-exit-1.sh"   # exit code 1 counts as success
ostia time --ignore-failure "./flaky-exit.sh"      # every exit code counts as success
```

`--timeout MS` kills a trial with SIGKILL. A timed-out trial contributes no sample and
the measurement carries a `timeout` warning. If every trial of a command times out, the
command has no timing stats, prints like a skipped workload, and the run exits 2 with
error code `timeout`. `--timeout` also applies to `--prepare` hooks; a hook that times
out aborts the run.

Ctrl-C cancels cleanly: in-flight children are killed, the document holds whatever
finished (with an `aborted` warning), `--export-json` still writes it, and the exit code
is 130.

### `--prepare`

`--prepare CMD` runs before every trial (warmup, timing, and the `--cpu`/`--heap` trials),
unmeasured, in the same cwd, hyperfine-style. It is whitespace-split like the commands
and must exit 0; a non-zero exit aborts the run. Given once, it applies to every command;
given once per command, the hooks pair up in order, so the same command can be timed warm
and cold side by side:

```sh
ostia time --prepare "true" --prepare "rm -rf dist" "bun build.ts" "bun build.ts"
```

Any other count is a usage error. The hook is part of the workload id, so a command with
and without a hook are two workloads. Its stdout is discarded; its stderr is captured
(bounded to 1 MiB) and included in the error when the hook fails. An argument containing
a space needs the array form in `ostia.config.ts` or the library.

### `--time-source`

`--time-source REGEX` takes each trial's time from the command's own output instead of
its wall clock: the first match in stdout, then stderr, capture group 1, in `--time-unit`
units. Use it for tools that print a more precise figure than wall time, such as a build
tool whose `built in 342ms` excludes runtime startup:

```sh
ostia time --time-source "built in (\d+)ms" "bun build.ts"
```

The parsed values become the timing samples; each trial also keeps `wallNs`. A trial
whose output doesn't match contributes no sample (never a fallback to wall time) and the
measurement carries a `time-source-no-match` warning with the pattern and up to 2 KiB of
output. If every trial misses, the command has no stats and the run exits 2 with error
code `time-source-no-match`. A match with no group 1, or a non-numeric capture, is an
error. The budget always counts wall time.

The time source is part of the workload id, so timing the same command both ways gives
two workloads with two verdicts.

### `--cpu` / `--heap`

Each adds one instrumented trial per command after the timing trials, labeled as a
separate measurement (`phase: "cpu"` / `"heap"`) and never mixed into timing. The raw
`.cpuprofile` / `.heapsnapshot` is written under `<out-dir>/artifacts/`.

```
CPU capture - bun fixtures/work.ts (instrumented, 1000µs interval, diagnostic wall 300.558ms)
  100.0%    292.61ms self  hashLoop
    0.0%      0.00ms self  (root)
    0.0%      0.00ms self  (module)
  artifact: /tmp/ostia-hot/artifacts/run_0fe944c450b24bfc-cpu.cpuprofile
```

```
Heap snapshot - bun fixtures/allocate.ts (instrumented, 2516 objects, 0.12MB)
    1369  string
     423  code
     319  closure
     216  object shape
     105  hidden
  artifact: /tmp/ostia-heap/artifacts/run_608f71a09a849cca-heap.heapsnapshot
```

Use `ostia report --format collapsed|mermaid|speedscope|cpuprofile` on the exported
document to turn CPU evidence into files for other tools.

## `ostia bench`

```
ostia bench [flags] <suite.ts...>
```

| Flag | Meaning |
|---|---|
| `--budget MS` | Sampling budget per task (default: 500). |
| `--samples N` | Exact trials per task; the budget is ignored. |
| `--min-samples N` | Floor on trials (default: cost-aware, see below). |
| `--jobs N\|auto` | Suite files run at once (default: 1). |
| `--isolate` / `--no-isolate` | One process per task instead of per file. |
| `--gc` / `--no-gc` | `Bun.gc(true)` between trials (default: off). |
| `--cpu` / `--no-cpu` | Extra per-task CPU profile with JIT tiers, about 2,000 samples. |
| `--cpu-interval US` | CPU sampling interval (default: 100). |
| `--alloc` / `--no-alloc` | Extra per-task measurement of the heap each call retains after a full GC. |
| `--peak-mem` / `--no-peak-mem` | Extra per-task measurement of how far the task's first call raises RSS, in fresh processes. |
| `--filter REGEX` | Only tasks whose `group/name` id matches (unanchored, case-sensitive). |
| `--preload PATH` | Import `PATH` before each suite file (repeatable, in order). |
| `--bun-flags FLAGS` | Extra flags for the `bun` process running each suite (repeatable). |
| `--timeout MS` | SIGKILL a suite (or isolated task) process after `MS`. No default. |
| `--out-dir PATH` | Scratch directory (default: `node_modules/.cache/ostia`). |
| `--no-noise-check` | Skip the ~200ms noise-floor measurement. |
| `--export-json PATH` | Write the document to `PATH`. |
| `--format FORMAT` | `table`, `json`, `jsonl`, `markdown`, `minimal`. |
| `--quiet` | Don't print the report. |

With no suite files, `ostia bench` uses the config's `bench` section (`suites` globs and
the rest). Each flag overrides its config field; `--preload`, `--bun-flags` and suite
files given on the command line replace the config's lists rather than appending. The
`--no-*` forms exist to override a config `true` for one run.

Per-task and per-group options (`budgetMs`, `samples`, `minSamples`, `gc`, `isolate`,
`cpu`, `alloc`, `peakMem`) override the suite-wide values; see [library.md](library.md).

Exit codes: `0` ok, `2` a suite failed to import or run, a task threw, a subprocess timed
out, or a bad flag; `130` Ctrl-C. A failing suite stops the run: queued suites are
skipped and in-flight ones killed.

### Sampling

Each task gets a warmup (10% of its budget, at least one call), then samples until the
budget is spent and the floor is met. Fast calls are batched so one trial spans at least
1µs and a full budget yields about 10,000 trials; the budget-driven loop stops at 20,000
trials. An explicit `--samples`/`--min-samples` can go past that.

Without `--min-samples`, the floor depends on the task's cost: as many trials as fit in
the budget (capped at 20), but never fewer than the task's cost earns it (3 at ≤1ms, two
more per decade of cost, 10 from about 3s up).

| Per-trial cost | Fits in 500ms | Default floor |
|---|---|---|
| 30ns | thousands | 20 (time-bound; ends in the thousands) |
| 30ms | 16 | 16 |
| 140ms | 3 | 7 |
| 2.4s | 0 | 10 |

A run below its cost class's floor (only possible with an explicit `minSamples`) carries
a `low-sample-count` warning with `{ samples, target, trialCostNs }`.

Each task is timed through its own compiled loop, so a task's result doesn't depend on
which tasks ran before it in the same file.

### Isolation and parallelism

Every suite file runs in its own child process. `--isolate` goes further and gives each
task its own process, isolating JIT tier state, inline caches, builtin call-site feedback
(e.g. what `Array.prototype.map` has seen) and the GC heap from every other task. Use it
for the most comparable numbers; it costs one process spawn per task.
`task(name, fn, { isolate })` / `group(name, fn, { isolate })` set it per task or group.

`--jobs N|auto` runs that many processes at once (suite files, and isolated tasks when
`--isolate` is on). Concurrent CPU-bound processes contend for cores, caches and turbo
headroom, so numbers taken at `--jobs > 1` are noisier and not comparable with a baseline
measured at 1.

The noise-floor check runs once per `bench()` call, in the parent process.

### `--gc`, `--cpu`, `--alloc`, `--peak-mem`

`--gc` calls `Bun.gc(true)` between trials, outside the timed region. Off by default, in
which case collection cost lands on whichever trials the GC happens to run in.

`--cpu` adds a `phase: "cpu"` measurement per task: the task looped under the JSC
sampling profiler, JIT tiers included. It samples every 100µs (`--cpu-interval` changes
this) and loops the task long enough to collect about 2,000 samples: 400ms at the default
interval, longer at a coarser one (up to 10s), and never less than one whole call. The
header of each CPU section shows the sample count; below 1,000 the measurement carries a
`low-sample-count` warning (`{ samples, target, intervalUs }`), since frame shares that
thin move by several points between runs. When more than 20% of its samples are in the
llint/baseline tiers, it carries a `jit-cold` warning (`{ llintPct, baselinePct, dfgPct,
ftlPct }`). With CPU evidence on both sides, `compare` reports per-frame deltas.

Self time is attributed to the frame the JIT compiled, so a small helper that got
inlined into its caller shows up as the caller's self time, not its own, and can appear
or vanish from the table between runs as inlining decisions change. When a helper you
expect to see is missing, look at its callers.

```sh
ostia bench bench/parse.bench.ts --cpu --filter 'large input$' --export-json cpu.json
ostia report cpu.json --format collapsed | sort -t' ' -k2 -nr | head
```

`--alloc` adds a `phase: "memstats"` measurement (`memory.kind: "retained"`) of the heap
each call keeps alive: `Bun.gc(true)`, a batch of 100 calls, `Bun.gc(true)` again, and the
heap size delta divided by 100. The second full GC collects everything the calls
allocated and dropped, so this is a leak check, not an allocation counter: a function that
builds and discards a large tree reads near zero. The table shows it as `Retained/op`.

`--peak-mem` adds a `phase: "memstats"` measurement (`memory.kind: "peak"`) of how far
the task's first call raises the process's RSS, which does count garbage. Each task runs
alone in a fresh process, three times, with `OSTIA_PEAK_MEM=1` in its environment: import
the suite, run the group's and the task's `before` hooks, `Bun.gc(true)`, and call the task
once while a worker thread samples RSS (about once a microsecond). The peak is the higher of
the sampled maximum and the peak-RSS high-water mark (`process.resourceUsage().maxRSS`),
measured from the RSS the call started at; the median of the three processes is
`memory.peakBytes`, shown as `Peak mem`. The same suite gives the same reading to within a
few percent.

It measures a first call, in the lower JIT tiers, like a build tool calling a library once
per file; lower tiers can allocate what optimized code doesn't. To measure a warmed-up
call, warm the JIT in a `before` hook on a smaller input than the task's.

Memory that setup freed but the allocator still holds is memory the call can reuse without
RSS rising. Linux hands freed memory back to the OS right away; macOS holds it for seconds.
So on macOS, module-scope code that allocates as much as the task (validating each input by
running it, say) can hide the task's peak. The reading is then low by up to that much, and
the measurement carries a `peak-hidden` warning with the amount (`data.slackBytes`) when
it's 16MB or more. Skip such work in these processes:

```ts
if (!process.env.OSTIA_PEAK_MEM) checkOutputs() // runs every input once
```

Ordinary setup (reading fixtures, building inputs) leaves a few MB of this slack, so read
small differences with that in mind; `--peak-mem` is for calls that allocate megabytes.

```
Task                     Median     Spread             Range              Retained/op Peak mem   Relative
---------------------------------------------------------------------------------------------------------
mem:
  mem/garbage 40MB       1.29 ms    1.38 ms…6.01 ms    1.17 ms…6.73 ms    39B         38.22MB    4291943.33× slower
    ! slow-first-run
  mem/retains 8KB/call   819.4 ns   1027.8 ns…20563.9 ns 493.1 ns…357930.6 ns 7.58KB      48.00KB    2731.39× slower
  mem/noop               0.30 ns    0.31 ns…0.42 ns    0.29 ns…5.40 ns    0B          0B         1.00×
```

The first task allocates and drops a 40MB array per call: `Retained/op` sees nothing,
`Peak mem` sees all of it. The second keeps 8KB per call alive, which both see.

### `--preload` and `--bun-flags`

`--preload PATH` imports a script before each suite file, in the same subprocess, like
Bun's own `--preload`. Use it to install globals a suite needs at import time or to
register a `Bun.plugin()` loader. Multiple preloads run in the order given.

```ts
// bench/jsdom-setup.ts
import { JSDOM } from "jsdom"
const dom = new JSDOM("<!doctype html>")
Object.assign(globalThis, { document: dom.window.document, window: dom.window })
```

```sh
ostia bench --preload ./bench/jsdom-setup.ts bench/*.dom.bench.ts
```

Complete jsdom, happy-dom and Svelte-plugin setups are in
[preload-recipes.md](preload-recipes.md).

`--bun-flags FLAGS` passes flags to the `bun` process that runs each suite. The common
case is a package whose `exports` map branches on a condition Bun doesn't set by default:
Svelte 5 resolves to its server build without `--conditions=browser`, and mounting a
component then fails.

```sh
ostia bench --bun-flags="--conditions=browser" bench/*.dom.bench.ts
```

Space-separated flags within one value are split and all passed.

### Table layout

Grouped tasks print under their group name; ungrouped tasks and subprocess commands
print flat. `Relative` compares each task with its group's `{ baseline: true }` task, or
else the group's fastest task.

There's no watch mode. Pair `ostia bench` with a file watcher and a small budget:

```sh
watchexec -e ts -- ostia bench bench/parse.ts --budget 100
```

## `ostia ab`

```
ostia ab [flags] <suite.ts...>
```

| Flag | Meaning |
|---|---|
| `--base REF` | Git ref whose committed tree is the base side (default: `HEAD`). |
| `--base-setup CMD` | Shell command run once in a freshly extracted base tree (repeatable, in order). See "The base tree". |
| `--rounds N` | Rounds per task, each one base batch and one candidate batch (default: 15, at least 3). |
| `--threshold PCT` | Flag a task whose median candidate/base ratio moves more than `PCT` percent (default: 10). |
| `--geomean-threshold PCT` | Fail when the geometric mean of all tasks' ratios is more than `PCT` percent slower (default: 1.5). |
| `--confirm N` | Re-measure each flagged task in `N` fresh processes (default: 2; 0 trusts the first process). |
| `--filter REGEX` | Only tasks whose `group/name` id matches. |
| `--preload PATH` | Import `PATH` before each suite file (repeatable, in order). |
| `--bun-flags FLAGS` | Extra flags for the `bun` process running each suite (repeatable). |
| `--timeout MS` | SIGKILL a suite (or repeat) process, or a setup command, after `MS`. No default. |
| `--out-dir PATH` | Scratch directory and base-tree cache (default: `node_modules/.cache/ostia`). |
| `--keep-trees N` | Base trees to keep cached (default: 5). See "The base tree". |
| `--clean` | Remove every cached base tree, then exit. |
| `--no-noise-check` | Skip the ~200ms noise-floor measurement. |
| `--export-json PATH` | Write the document to `PATH`. |
| `--format FORMAT` | `table`, `json`, `jsonl`, `markdown`, `minimal`. |
| `--progress` / `--no-progress` | Print progress to stderr. Default: on when stderr is a terminal and `--quiet` isn't given. |
| `--quiet` | Don't print the report. |

`ostia ab` answers "did my change make this slower?" on a machine too noisy for two runs
minutes apart to agree. It runs each suite file's tasks twice over in one process: once
from the base ref's committed tree and once from the working tree (uncommitted changes
included), in alternating batches, and judges each task on the ratio of the two within
each round. Anything that drifts over the run, such as another process's load or thermal
throttling, hits both halves of a round alike and cancels in the ratio. `ostia compare`
between two documents can't do that: on a shared machine, the same code measured minutes
apart can differ by 10–25%, and the noise-floor widening that keeps `compare` from
reporting that as a regression also hides real 5–10% changes.

```sh
ostia ab bench/parse.bench.ts                 # working tree vs HEAD
ostia ab bench/*.ts --base origin/main        # a branch's changes, e.g. in CI
ostia ab bench/*.ts --filter 'source map' --rounds 21
```

```
A/B: working tree vs HEAD (26e7d0d) · 15 rounds · threshold 10% · geomean threshold 1.5%

Task       Base       Candidate  Change    p25…p75            Verdict
---------------------------------------------------------------------
g:
  g/work   66.9 µs    143.0 µs   +113.0%   +104.8%…+123.6%    regressed, confirmed (repeats: +103.1%, +101.8%)
  g/same   87.1 µs    87.9 µs    -2.2%     -5.1%…+3.2%

Output differs from the base (1):
  g/work

Geomean +41.0% (threshold 1.5%) · 1 regressed, 0 improved, 1 unchanged of 2 · fail
```

**The base tree.** The ref's commit is extracted with `git archive` into
`<out-dir>/ab/<sha>/` once and reused by later runs against the same commit. The suite
file is imported from both trees, so its relative imports, and `tsconfig` `paths` such as
a package importing itself by name, resolve within each tree; bare package imports
(dependencies, and `ostia` itself) resolve to the project's own `node_modules` from both,
which is why `--out-dir` should stay inside the project. The consequences: a change to a
dependency's version isn't what's being compared, files that aren't committed (generated
fixtures, gitignored inputs) don't exist in the base tree until `--base-setup` builds them,
and git submodules aren't extracted. A suite file that doesn't exist at the ref has nothing
to pair with.

**Setup.** `--base-setup CMD` (or the config's `ab.setup`) runs `CMD` with `sh -c` once in
each freshly extracted tree, before the salt pass, so the files it writes are salted too.
Use it when the suites import generated or gitignored files:

```sh
ostia ab bench/*.ts --base-setup "bun scripts/generate.ts"
```

Each command runs in the tree's counterpart of the current directory, with:

- the project's `node_modules` linked into the tree, so build scripts that read
  `./node_modules/...` by relative path work. The link is removed when setup ends, so
  don't install packages in setup: they would land in the project's `node_modules`.
- `OSTIA_AB_SHA`, the base commit, and `OSTIA_AB_CANDIDATE_DIR`, the current directory in
  the working tree. When the generated files don't depend on the base's code, copying them
  is cheaper than building them: `--base-setup 'cp -R "$OSTIA_AB_CANDIDATE_DIR/src/gen" src/'`.

The tree is cached under `<out-dir>/ab/<sha>-<hash>/`, where the hash covers the commands,
so changing them builds a new tree. Setup runs in a temporary directory that is renamed
into place only when every command succeeds, so a failed or interrupted setup never
leaves a half-built tree for a later run to reuse. Each command runs in its own process
group, and the whole group is killed when the command ends, times out or is cancelled, so
nothing it started in the background keeps running. A command that exits non-zero (or runs
past `--timeout`) stops the run with exit 2 (`command-failed`) and the last 20 lines of its
stderr.

Trees pile up as `HEAD` moves, so after each run `ostia ab` keeps only the
`--keep-trees` (default 5) most recently used, this run's included, and removes the rest.
A tree used in the last hour is never removed, since another run may still be using it,
and neither is a temporary directory whose process is still alive. `ostia ab --clean`
removes them all.

Every script in the extracted tree gets one inert line appended,
`;globalThis.__ostia_ab_base__;`, so that no file is byte-identical to its working-tree
copy. JSC reuses compiled code between identical sources, and identical copies didn't
measure independently: with no change at all, whichever copy was imported (and warmed up)
first ran 5–15% faster, reproducibly across processes. With the salt, an A/A run reads
within a fraction of a percent either way.

**Pairing.** Tasks pair across the two trees by their `group/name` id and `params`, the
same identity the workload id hashes, so a paired task has the same workload id as in
`ostia bench`. A task on only one side is listed as unmatched. `task.skip()` skips both
sides; group and task `before`/`after` hooks run for both sides.

**Measuring.** For each task: one call of each side, a warmup that doubles both sides'
batch until each spans 1ms, a batch size planned so the slower side's batch takes about
10ms, three untimed warm rounds, then `--rounds` rounds of one batch per side, alternating
which side goes first. Each side runs through its own compiled timing loop. The
candidate's per-call times become the measurement's `timing`; the base side's and the
per-round ratios go in `paired`.

**Verdict.** A task is flagged `regressed` when its median ratio is above
`1 + threshold` and the 25th percentile is above 1, so the candidate was slower in at
least three quarters of rounds; `improved` is the mirror image. Pairing can't cancel one
thing: how the JIT happened to compile each side's copy of the code in that process,
which can skew a small task by 20% in either direction with tight quartiles. So each
flagged task is measured again in `--confirm` fresh processes, and only counts when every
repeat flags it the same way; otherwise it reads `unconfirmed` and counts as unchanged.

A slowdown spread thinly across many tasks, too small to flag any one of them, shows up
in the geometric mean of the tasks' median ratios, where per-task noise averages out. For
a flagged task, the median over its first run and its repeats goes into the geomean. With
many tasks, an A/A run (no change) typically lands within ±0.3%; with few, the geomean is
only as steady as those few tasks, so raise `--geomean-threshold` accordingly.

**Output.** Each task's first call on each side is compared with `Bun.deepEquals`
(prototypes ignored), and tasks whose results differ are listed. This is informational,
expected for a change in behavior, and never fails the run. Return the result from the
task (`task("x", () => parse(input))`) for it to mean anything.

**Errors.** A task that throws, on either side, doesn't stop the suite. It isn't timed,
reads `base threw`, `candidate threw` or `both threw` in the table, and the error's first
line is listed under "Threw". A throw from a task's `before` or `after` hook counts for
that hook's side. Each hook runs once: a side whose `before` threw isn't timed or torn
down, and every side that was set up is torn down once, even when a hook throws. When only
one side has thrown, the other side's task is called once more, before teardown, to tell
whether it throws too. A task that throws on the candidate side only fails the run, the
same as a regression; one that throws on the base side only (a fix) or both sides doesn't.
A throw in a confirmation repeat counts the same way, reads `(repeat N)`, and the task
keeps the first process's numbers in the document but isn't judged on them. A suite file
that fails to load on either side stops the run with exit 2, naming the side and the error.

**Changed suites.** The base side runs the base tree's copy of each suite file. When the
suite itself changed, the two sides may time different things: a fixed fixture, a new
input size. So when a suite file's text differs from the base's copy, its tasks carry a
`suite-changed` warning. A task whose output differs as well is marked `not comparable`:
its verdict is `unchanged`, it isn't re-measured, and it's left out of the geomean. Only
the suite file itself is checked, not the files it imports.

The noise floor is measured and reported as usual but doesn't widen the threshold:
pairing already cancels the drift it measures.

**Progress.** A run over many suites, with confirmations, can take many minutes. On a
terminal, `ostia ab` shows one progress line on stderr, replaced as it goes and cleared
before the report. `--progress` turns it on anywhere else too, as one line per step, which
is how a script or agent can tell a long run from a stuck one:

```
[ab] base setup: bun scripts/generate.ts
[ab] suite 4/13 bench/search.bench.ts · task 3/7 search/regex
[ab] confirming flagged tasks · repeat 1/6 search/regex
```

Progress never goes to stdout, so `--format minimal` output stays clean.

Exit codes: `0` pass, `1` a confirmed regression, a task that threw on the candidate side
only, or the geomean over its threshold, `2` nothing paired (`no-matches`), not in a git repository or an unknown ref
(`invalid-flag`), a setup command failed (`command-failed`), or a suite failed
(`spawn-failed`); `130` Ctrl-C.

With no suite files, `ostia ab` uses the config's `bench.suites`, and its `filter`,
`preload`, `bunFlags`, `outDir` and `timeoutMs`, and its setup commands from `ab.setup`.
The sampling settings (`budgetMs`, `samples`, `isolate`, ...) don't apply.

## `ostia compare`

```
ostia compare <base.json> <candidate.json>
ostia compare <candidate.json> --baseline <base.json>
```

| Flag | Meaning |
|---|---|
| `--baseline PATH` | The base document, when only the candidate is positional. |
| `--export-json PATH` | Write the candidate document, with comparisons, to `PATH`. |
| `--format FORMAT` | `table`, `json`, `jsonl`, `markdown`, `minimal`. |
| `--quiet` | Don't print the report. |

Thresholds come from `ostia.config.ts`/`ostia.config.json` in the current directory when
one exists (the same `thresholds` `ostia ci` uses), otherwise from `DEFAULT_THRESHOLDS`.
There are no threshold flags. A config that fails to load is an error (`config-invalid`),
even for `compare`. The table and markdown formats print the source first:

```
thresholds: ostia.config.json
base a1b2c3d (main) → cand d4e5f6a (my-opt, dirty)
threshold 5% (widened to 6.2% by noise floor)
```

The `base → cand` line appears when both documents carry git metadata; the `threshold`
line appears (table only) when the noise floor widened the threshold.

```
✗ bun fixtures/work.ts
  timing: +23.8% median, 95% CI [+18.3%, +30.1%], p<0.001 (regressed)
```

A workload id present in only one document is listed instead of dropped:

```
Unmatched:
  baseline only: old-task
  candidate only: new-task
```

When the documents differ in OS, architecture, Bun version, CPU model or core count,
every comparison carries an `environment-mismatch` warning; table and markdown print it
once in the header.

Exit codes: `0` pass, `1` at least one workload failed (timing regression, or a CPU
frame / heap type over its threshold), `2` zero workloads matched (`no-matches`) or a
document failed to load (`document-load-failed`). How verdicts are decided:
[statistics.md](statistics.md).

## `ostia report`

```
ostia report <document.json> [flags]
```

| Flag | Meaning |
|---|---|
| `--format FORMAT` | See below (default: `table`). |
| `--measurement ID` | Visualization formats: render only this measurement (default: every CPU measurement). |
| `--out-dir PATH` | Visualization formats: write files here instead of stdout. |

| Format | Output |
|---|---|
| `table` | Terminal timing / CPU / heap / comparison text |
| `json` | The document, pretty-printed (same bytes as `--export-json`) |
| `jsonl` | One `kind: "document"` header line, then one `kind: "measurement"` line per measurement |
| `markdown` | Report for humans and agents |
| `minimal` | One JSON object per timing measurement ([agent-protocol.md](agent-protocol.md)) |
| `collapsed` | Folded stacks, `root;a;b 42`, for `flamegraph.pl` and similar tools |
| `mermaid` | Call tree, top 15 frames by total time |
| `speedscope` | Sampled-profile JSON for speedscope.app |
| `cpuprofile` | The original `.cpuprofile` artifact, verbatim (`cpu-prof`/`inspector` origins only) |

A visualization format on a document with no CPU evidence exits 2 with `no-cpu-evidence`.

```
$ ostia report doc.json --format collapsed
(root);(module);hashLoop 195

$ ostia report doc.json --format mermaid
graph TD
  n1["(root) (self 0.00ms, total 292.61ms)"]
  n2["(module) (self 0.00ms, total 292.61ms)"]
  n3["hashLoop (self 292.61ms, total 292.61ms)"]
  n1 --> n2
  n2 --> n3
```

```
$ ostia report doc.json --format markdown
# Profile Report

Bun 1.4.2 · ostia 0.2.5 · darwin/arm64 · 2026-09-26T16:36:25.159Z

Apple M2 · 8 cores · load 5.0 · noise floor 2.8%

## Timing

| Task | Median | Spread (p75…p99) | Mean ± SD | Range | MAD | User/Sys |
|---|---|---|---|---|---|---|
| bun fixtures/work.ts | 16.4 ms | 17.1 ms…19.4 ms | 16.8 ms ± 1.06 ms | 15.9 ms…19.5 ms | 0.47 ms | 11.7 ms/5.32 ms |
```

## `ostia ci`

```
ostia ci [flags]
```

| Flag | Meaning |
|---|---|
| `--full` | Ignore the cache; rerun every workload. |
| `--baseline NAME` | Baseline to compare against (default: config `baseline`, or `main`). |
| `--save-baseline` | After a pass, write this run as the new baseline at the same path. |
| `--no-noise-check` | Skip the ~200ms noise-floor measurement. |
| `--export-json PATH` | Write the candidate document, with comparisons, to `PATH`. |
| `--format FORMAT` | `table`, `json`, `jsonl`, `markdown`, `minimal`. |
| `--quiet` | Don't print the report. |

`ostia ci` loads the config ([config.md](config.md)), measures every workload, compares
against `<baselineDir>/<name>.json`, and gates on the result.

```
1 workloads
0 cached
1 executed
1 passed  0 regressed

Profile CI: ✓
```

### Workloads

A `command` workload is timed like `ostia time`, using the config's top-level `samples`,
`budgetMs`, `minSamples` and `warmup`. Its `prepare`, `timeSource`, `timeoutMs` and
`ignoreExitCodes` mean the same as the `ostia time` flags. Every command workload gets a
10-minute timeout unless it sets `timeoutMs`.

A `suites` workload runs its suite files through `bench()` with the config's `bench`
section applied exactly as `ostia bench` applies it (`budgetMs`, `jobs` including
`"auto"`, `isolate`, `preload`, `bunFlags`, `timeoutMs`, ...), except that the workload's
own `suites` list is used. Every task is compared individually. Suite processes get a
10-minute timeout unless `bench.timeoutMs` is set.

### Caching

Command workloads are cached under `outDir`, keyed on the workload id, the sampling
settings, the Bun and ostia versions, and the contents of the files matched by `inputs`:

- no `inputs` field: never cached, always reruns;
- `inputs: []`: depends on nothing, cached until the command or settings change;
- `inputs: ["src/**/*.ts", "/abs/path/data.bin"]`: reused while the matched files'
  contents are unchanged. Absolute paths work.

A function-form `prepare` hook makes a workload uncacheable. `suites` workloads always
run. `--full` ignores the cache.

### Failures and missing baselines

Exit codes: `0` pass, `1` a workload regressed, `2` a harness error: no config or no
workloads (`config-missing`), an unloadable config (`config-invalid`), no baseline file or
a baseline mismatch (`baseline-missing`), an unreadable baseline file
(`document-load-failed`), a suite failure (`spawn-failed`), or a command
workload with a non-ignored non-zero exit or no samples (`command-failed`, listed as
`N failed` in the report). A harness failure wins over a regression.

A configured workload with no row in the baseline is handled by `onMissingBaseline`:
unset, the run fails only when *every* configured workload is missing (a stale or wrong
baseline) and otherwise lists the missing ones as skipped; `"fail"` always fails on a
mismatch; `"warn"` never does.

`ci` measures the noise floor once per invocation and stamps it on the candidate
document, so the threshold widening in [statistics.md](statistics.md) applies to `ci`
too. `noiseCheck: false` in the config or `--no-noise-check` skips it.

## `ostia baseline`

```
ostia baseline save [name]
ostia baseline list
ostia baseline show <name> [report flags]
```

`save` measures every configured workload through the same code path as `ci` (no
comparison) and writes `<baselineDir>/<name>.json` (default name: the config's `baseline`
field, or `main`). `list` prints each saved baseline's name, workload count, creation
date, ostia version and git state. `show` renders one via `ostia report` and takes the
same `--format`/`--measurement`/`--out-dir` flags.

A name must match `/^[A-Za-z0-9._-]+$/` and can't start with `-`, so a mistyped flag is an
error rather than a filename.

### Workflow

```sh
git checkout main
ostia baseline save          # -> .ostia/baselines/main.json

git checkout -b my-opt
# ... change code ...
ostia ci
```

Baselines live outside `node_modules` so they survive reinstalls and branch switches;
they don't need to be committed. Re-save only when you accept a new floor. Saving on the
branch you're testing compares that branch with itself.

`ostia ci --save-baseline` folds the re-save into the gate: after a pass, the run just
measured becomes the baseline. This suits a CI job that gates every merge to a trunk
branch.

Any document works as a baseline, including one from `ostia time`:

```sh
ostia time --export-json .ostia/baselines/main.json "bun bench.ts"
ostia ci
```

Workload ids don't include the working directory, so a baseline saved in one checkout
matches runs from another; see [document-schema.md](document-schema.md#workload-ids).
