# Changelog

## Unreleased

**Features**

- `ostia time` is the primary CLI name for what was `ostia run`; `run` is kept
  as an alias
- `time(opts)` is the primary library export for what was `run(opts)`; `run`
  is kept as a `@deprecated` alias for one release
- `profile(fn, opts)` returns `{ result, measurement, document }`; `document`
  is a full `ProfileDocument` so it composes with `renderers.*` /
  `saveDocument` without reaching into `src/ir/document.ts`
- `createDocument(workloads, measurements)` composes a document from several
  `profile()` calls
- the terminal table now shows `Task | Median | Spread | Range | Relative`
  with an adaptive ns/µs/ms/s unit per row (3 significant digits), replacing
  the hyperfine-shaped `Command | Mean [ms] | Min…Max [ms]` table that
  rendered sub-millisecond microbenchmarks as `0.000 ± 0.000`
- grouped tasks (`group()`) print the group name once, indented, in the
  terminal table; per-row warnings collapse to a code list with full
  messages in a footnote block after the table
- `formatDuration(ns)` in `src/renderers/format.ts`, also used by the
  markdown renderer's Timing table

- `ostia report --format` now covers `collapsed`/`mermaid`/`speedscope`/
  `cpuprofile` too (`--measurement <id>`, `--out-dir PATH`), folding in what
  was `ostia viz`. `ostia viz` is a hidden, deprecated alias for one release.
- `TimingStats` gains `p75`/`p99`/`mad` (median absolute deviation), all in
  ns, additive with no schema bump. Exposed in `minimal` lines and the
  markdown renderer's Timing table. The terminal table's Spread column now
  reads `p75…p99` instead of the IQR item 3 shipped as a placeholder.
- `compareWorkload`/`compareDocuments` verdicts now come from a bootstrap
  95% CI on the difference of medians (`Comparison.timing.ci95`) and a
  tie-corrected Mann-Whitney U p-value (`Comparison.timing.pValue`), not a
  bare point estimate against `timingPct`. `regressed`/`improved` require
  both the CI clearing `timingPct` and `pValue < thresholds.alpha` (default
  `0.01`). New `Thresholds` fields: `alpha`, `bootstrapIterations` (default
  2000, capped and subsampled for large sample counts). Comparisons with
  fewer than 5 samples per side fall back to the old point-estimate rule
  and carry a `thin-comparison` warning.
- `time()`/`bench()` stamp `environment` (`cpuModel`, `cores`, `loadAvg1`,
  `loadAvg5`, `noise: { floorPct, referenceMedianNs, samples }`) on every
  document by default: a ~200ms fixed-cost, deterministic, allocation-free
  reference workload measures how noisy the machine is right now. `compare`
  widens the effective regression threshold to at least the noise floor
  (`Comparison.thresholds.effectiveTimingPct`), and warns `noisy-machine`
  when the 1-minute load average already exceeds 75% of available cores.
  `--no-noise-check` (`noiseCheck: false`) skips it. Terminal and markdown
  renderers print one header line, e.g. `Apple M2 Pro · 12 cores · load
  2.1 · noise floor 1.8%`.
- `Workload.params` (structured `task(name, fn, { params })`, additive) and
  `sweep(dims, fn)`: a cartesian product over one or more dimensions: `task()`
  calls inside automatically inherit the current point as params (an
  explicit `{ params }` merges over it). The workload id folds in `params`
  when present, so two sweep points sharing a task name don't collide.
  `minimal` lines gain `params`; the markdown renderer pivots a group into a
  table when every task in it shares the same two param keys, otherwise
  renders params as a `key=value` suffix on the task name.
- `task(name, fn, { before, after })` / `group(name, fn, { before, after })`:
  once-each, unmeasured setup/teardown around a task's sampling (or a
  group's tasks), in the task's own process so both work with `isolate`. No
  per-trial hook, by design: use `gc`/`isolate` for per-trial concerns.
- `keep(value)` (exported from `src/index.ts`): the sink that already
  protects a task's own return value from dead-code elimination, made
  public for an intermediate value inside a task body.
- `task.skip(...)` / `group.skip(...)`: register without measuring. The
  document still carries the workload (`Workload.skipped`), so a renderer
  prints `- skipped` instead of the task being absent, and `compare` reports
  it as `unchanged` with a `skipped` warning instead of silently passing.
  `task.only(...)` / `group.only(...)` restrict a suite file to only the
  selected tasks (`--filter` still applies on top) and print a one-line
  `bench: N task(s) selected by .only` notice to stderr.
- Unified timing vocabulary across `time()`/`ostia time` and
  `bench()`/`ostia bench`: `samples` (exact trial count; `runs` is a
  deprecated alias), `budgetMs` (wall-clock budget; `timeBudgetMs` is a
  deprecated alias for `bench()`), `minSamples`, `warmup` (a trial count for
  `time()`, a *fraction* of `budgetMs` for `bench()` - the asymmetry is
  real, not papered over; `warmupFraction` is a deprecated alias). CLI:
  `ostia time` gains `--samples`/`--budget`/`--min-samples`; `ostia bench`
  gains `--budget`/`--samples` (`--time-budget` stays as an alias).
  `configFingerprint` resolves old and new names to the same canonical
  value, so an old-name and new-name call with the same effective settings
  produce the same fingerprint and don't orphan a baseline.
- `ostia bench --cpu` captures an extra `phase: "cpu"` measurement per task
  (200ms of the task looped under the JSC sampling profiler, JIT tiers
  included) on top of its timing numbers; `ostia bench --alloc` captures an
  extra `phase: "memstats"` measurement with bytes allocated per call
  (`MemoryEvidence.bytesPerOp`, from a `Bun.gc(true)`-bracketed batch of 100
  calls). Neither ever feeds the task's timing stats. `TaskOptions.cpu` /
  `TaskOptions.alloc` and `GroupOptions.cpu` / `GroupOptions.alloc` override
  the suite-wide default per task or group, mirroring `isolate`/`gc`. The
  terminal table prints an `Alloc/op` column when a `memstats` measurement is
  present. With `--cpu` on, `ostia compare`'s per-frame CPU deltas now work
  for bench tasks with no changes to `compare/index.ts` itself, since it
  already matches any `phase: "cpu"` measurement by workload id.
- A `--cpu` measurement with more than 20% of its samples in the
  llint/baseline tiers carries a new `jit-cold` warning
  (`{ llintPct, baselinePct, dfgPct, ftlPct }`): the JIT never warmed the
  task up in the 200ms capture window, so its CPU (and by extension timing)
  numbers may not reflect steady state. Printed alongside the CPU capture in
  the terminal table and folded into the task's line in `--format minimal`.
- `ostia time` with 2+ commands round-robins their trials by default
  (`--interleave`, one trial per command, repeated) instead of running each
  command's whole trial loop to completion before the next starts, so drift
  over the run's wall-clock span (thermal throttling, a noisy neighbor
  process) lands on every command equally instead of favoring whichever ran
  first or last. `--no-interleave` (`interleave: false`) restores the old
  per-command-to-completion order. Interleaved timing measurements carry
  `Measurement.interleaved: true`. `runTimingPhase` is now built on top of a
  `createTimingPhase` per-trial iterator (`warmup()`/`step()`/`done()`/
  `result()`), which `time()` drives round-robin across commands.
- `ostia.config.json` workloads gain a `suites` alternative to `command`:
  glob patterns (same resolution as `bench`'s own `suites` config) run via
  `bench()`, gating every task in those files individually - one
  candidate-vs-baseline comparison per task, matched by workload id the same
  way a `command` workload already is. `ostia ci` now covers in-process
  microbenchmark regressions, not only subprocess commands. A `suites`
  workload always executes (no per-task cache skipping yet - there's no
  cheap way to know a suite file's task ids without importing it first).
  This repo's own `ostia.config.json` gates `bench/*.ts` this way.
- `ostia baseline save [name]` / `list` / `show <name>` manage baseline
  `ProfileDocument`s from the CLI: `save` measures every configured workload
  (the same code path `ostia ci` gates against, no comparison) and writes it
  to `<baselineDir>/<name>.json`; `list` shows every saved baseline (name,
  created date, workload count); `show` delegates to `ostia report`.
  `ostia ci --save-baseline` writes the candidate document as the new
  baseline after a pass, so a green CI run can promote itself to be the next
  run's floor with no separate step. Replaces the repo-local
  `scripts/seed-baseline.ts` / `bun run baseline` (now `ostia baseline save`
  under the hood) - package users previously had no way to seed a baseline
  except a manual `--export-json`.
- `ProfileDocument` gains `git?: { sha, branch, dirty }`, additive with no
  schema bump: `git rev-parse` / `git status --porcelain` in the process's
  cwd, 200ms timeout, silently absent outside a repo or without `git`
  installed. Metadata only, never part of any fingerprint or id. Printed in
  the markdown report's header line, `ostia baseline list`, and as a
  `base a1b2c3d (main) → cand d4e5f6a (my-opt, dirty)` summary line above
  `ostia compare`'s verdicts when both documents carry it.
- `loadConfig` looks for `ostia.config.ts` first (Bun imports TypeScript
  natively), falling back to `ostia.config.json`. `defineConfig(config)`
  (exported from `src/index.ts`) is an identity function purely for typing,
  the same pattern as Vite/Vitest/ESLint's `defineConfig` helpers. Both
  forms are fully supported; the `.ts` file's default export is the config.

**Fixes**

- microbenchmarks under 1ms (e.g. `task("add", () => 1 + 2)`) render a
  readable duration instead of collapsing to `0.000ms`

**Breaking**

- `ProfileDocument.schemaVersion` is now `2`: `runs` is renamed to
  `measurements` and the IR's `Run` type is renamed to `Measurement`.
  `Comparison.baselineRunId` / `candidateRunId` are renamed to
  `baselineMeasurementId` / `candidateMeasurementId`. `loadDocument` upgrades
  a v1 document in memory, so existing `.ostia/baselines/` files still load.
  `renderers.*.render(doc, { runId })` is now `{ measurementId }`.

**Documentation**

- Rewrote the README opening to lead with what ostia is (one document for
  timing/CPU/heap/JIT/allocation, a comparison with confidence intervals and
  a noise floor, CI gating with input-fingerprint caching, per-task process
  isolation, agent-friendly `minimal` output) instead of a generic
  description; the quick start already used the adaptive-unit table from
  item 3, not the old hyperfine-shaped one.
- Removed inline "mirrors mitata" / mitata-comparison phrases from the API
  sections (`baseline()`, `range()`, per-trial hooks) in favor of describing
  ostia's own model on its own terms.
- Added `## Migrating from mitata or hyperfine`: a mapping table (`bench()` →
  `task()`, `baseline()` → `{ baseline: true }`, `.range()` → `sweep()` +
  `range()`, generator setup → `{ before, after }`, `do_not_optimize` →
  `keep()`, `hyperfine -L` → `params`/`sweep()`, `--runs`/`--warmup` →
  `--samples`/`--warmup`, `--export-json`/`--export-markdown` →
  `--export-json`/`--format markdown`).
- Regenerated every real captured sample output in the README by running the
  examples and CLI again.

## 0.1.7 — 2026-09-04

**Features**

- `--bun-flags` passes extra Bun flags (e.g. `--conditions`) to suite
  subprocesses
- `ostia.config.json` `"bench"` section supplies suite/preload/jobs defaults
  when `ostia bench` is run with no arguments; CLI flags still override per
  field

**Fixes**

- avoid importing a suite file twice per invocation (plan + shared-task passes
  now share one import; isolated tasks still get their own subprocess)

**Documentation**

- preload recipes cookbook for DOM/component suites (jsdom/happy-dom,
  Bun.plugin component compile)
- multi-instance scoping pattern for suites

## 0.1.6 — 2026-09-04

**Features**

- `--preload` / `preload` imports one or more scripts before the suite file in
  the same subprocess (mirrors Bun's `--preload` for globals, plugins, etc.)
- `range(start, end, multiplier)` geometric sweep helper for `task()`
- per-task/group `gc` override (task → group → suite-wide `--gc` → false) so
  allocation-heavy and cheap tasks can share a suite file

## 0.1.5 — 2026-09-04

**Features**

- `--isolate` (plus per-task/group overrides) runs each task in its own child
  process so JIT tier state and heap shape don't leak between tasks; `--jobs`
  pools across those spawns the same way it pools suite files

## 0.1.4 — 2026-09-04

**Features**

- `--jobs` runs suite files concurrently (defaults to 1; first failure kills
  the rest)
- `group()` / `task()` accept `{ description }`, carried into the document with
  the numbers; renderers prefer `entry.group` over splitting the id so task
  names may contain slashes
- minimal per-task JSON format for LLM and CI consumers: one object per timing
  run with stats, in-group relative, warning codes, and comparison delta — no
  sample array or prose

**Performance**

- raise the default sample floor with per-trial cost (+2 per decade; 3 at
  ≤1ms, 10 from ~3s); runs that undercut it via an explicit `minSamples` carry
  a structured `low-sample-count` warning

## 0.1.3 — 2026-09-04

**Fixes**

- treat single-task groups as their own Relative baseline instead of falling
  back to the whole-run fastest task

## 0.1.2 — 2026-09-04

**Features**

- `task(name, fn, { timeBudgetMs, minSamples })` per-task overrides
- `task({ baseline: true })` pins the Relative column to that task within its
  group (can report faster, not only slower)
- `--filter` regex flag skips non-matching tasks before they're timed
- default scratch output to `node_modules/.cache/ostia`; baselines stay at
  `.ostia/baselines/` via a separate `baselineDir` config field

**Performance**

- batch fast tasks so a time budget yields ~10k trials instead of millions. The
  calibration call measured an `await` microtask turn instead of the call, so
  sub-microsecond tasks ran unbatched and produced a multi-hundred-MB IPC
  document per suite, costing seconds per task outside the timed region
- the default min-samples floor is now cost-aware (as many trials as fit in the
  budget, clamped to 3..20) so a slow task no longer overruns the budget by
  `20 × per-call cost`. An explicit `--min-samples` is still a hard floor
- drop the dedicated calibration call for slow tasks; the estimate reuses the
  warmup phase

**Fixes**

- scope the Relative column to per-group siblings instead of the whole-run
  fastest task

**Documentation**

- `warmupFraction` is documented as a fraction of the time budget

## 0.1.1 — 2026-09-03

**Fixes**

- include bench runner in published package

## 0.1.0 — 2026-09-03

- initial release
