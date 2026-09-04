# Changelog

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
