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
