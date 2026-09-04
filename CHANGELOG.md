# Changelog

## Unreleased

- perf(bench): batch fast tasks so a time budget yields ~10k trials instead of
  millions. The calibration call measured an `await` microtask turn instead of the
  call, so sub-microsecond tasks ran unbatched and produced a multi-hundred-MB IPC
  document per suite, costing seconds per task outside the timed region.
- perf(bench): the default min-samples floor is now cost-aware (as many trials as
  fit in the budget, clamped to 3..20) so a slow task no longer overruns the budget
  by `20 × per-call cost`. An explicit `--min-samples` is still a hard floor.
- perf(bench): drop the dedicated calibration call for slow tasks; the estimate
  reuses the warmup phase.
- feat(bench): `task(name, fn, { timeBudgetMs, minSamples })` per-task overrides.
- docs(bench): `warmupFraction` is documented as a fraction of the time budget.

## 0.1.1 — 2026-09-03

- fix: include bench runner in published package

## 0.1.0 — 2026-09-03

- initial release
