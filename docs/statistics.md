# Statistics

How ostia samples, summarizes, and decides whether a change is a regression.

## Summary statistics

Every timing measurement stores its raw samples plus `mean`, `median`, `stddev`
(population), `min`, `max`, `p25`, `p75`, `p99`, `mad` (median absolute deviation) and
IQR-based outlier counts (mild: beyond 1.5×IQR from the quartiles; severe: beyond 3×IQR).
Percentiles interpolate linearly between order statistics.

Reports lead with the median and show Spread as p75…p99, since wall-clock timings have a
long right tail that skews the mean and standard deviation.

## Sampling

### Subprocess commands (`time`, `ci`)

3 warmup trials, then timed trials until 3s of wall time have passed and at least 10
trials have run, unless `samples` sets an exact count. With several commands the trials
are interleaved round-robin. Details: [cli.md](cli.md#sampling).

### In-process tasks (`bench`, `run`)

- One untimed first call, then warmup for 10% of the budget. Warmup doubles its batch size
  until a batch takes about 1ms, so the loop is hot at the size it will be sampled at.
- Calls are batched so one trial spans at least 1µs (keeping timer resolution out of the
  reading) and a full budget yields about 10,000 trials. For batched tasks, five
  calibration batches settle the per-call estimate on their median before sampling starts.
  The reported numbers are per call (`batch` records the batch size).
- Sampling runs until the budget (default 500ms) is spent and the floor is met. The
  budget-driven loop stops at 20,000 trials.
- The default floor is cost-aware: as many trials as fit in the budget (capped at 20), but
  never below 3 at ≤1ms per trial, plus 2 per decade of cost, up to 10. See the table in
  [cli.md](cli.md#sampling-1).
- Each task runs through its own compiled timing loop. A loop shared between tasks lets
  the JIT specialize its call site for whichever task ran first, which made later tasks
  read slower depending on their order in the file.
- Every result is stored into a ring buffer, and `keep()` is available for intermediate
  values, so the JIT can't eliminate the work being measured.

Tasks that share a process still share builtin call-site feedback and the GC heap. For
the most comparable numbers, run tasks with `isolate`.

## Noise floor

Before measuring, `time()`, `bench()` and `ostia ci` each run a fixed, allocation-free
hash loop for about 200ms, once per call, and record `mad / median` of its trial times as
`environment.noise.floorPct`. This is how much this machine's timings are varying right
now, independent of the workload. `noiseCheck: false` / `--no-noise-check` skips it (and
the widening below).

A `noisy-machine` warning is added when the 1-minute load average exceeds 75% of the
available cores.

## Comparing two measurements

`compareDocuments` (and `ostia compare`/`ostia ci`) matches workloads by id and, for each
pair of timing measurements with at least 5 samples on each side, runs two tests on the
raw samples:

- **Bootstrap confidence interval** on the difference of medians. Each round resamples
  both sides with replacement and takes the difference of the resampled medians, as a
  percent of the baseline median; the 2.5th and 97.5th percentiles over
  `bootstrapIterations` rounds (default 2000) form `ci95`. A side with more than 2000
  samples is randomly subsampled to 2000 first, which bounds the cost.
- **Mann-Whitney U test**, two-sided, tie-corrected, normal approximation, reported as
  `pValue`. It tests whether the two distributions differ without assuming normality.

The bootstrap PRNG is seeded from a hash of the two sample arrays, so the same two
documents always produce the same interval and verdict. The seed is stored in
`Comparison.timing.seed`.

### Verdict

Let `T = effectiveTimingPct` (below).

- `regressed`: `pValue < alpha` and `ci95[0] > T`, so the whole interval is above the
  threshold.
- `improved`: `pValue < alpha` and `ci95[1] < -T`.
- `unchanged`: anything else.

A large point estimate is not enough. For example, `+21.4% median, 95% CI [+5.6%,
+23.9%], p=0.023` against `T = 10` and `alpha = 0.01` is `unchanged`: the interval
reaches below the threshold and the p-value is above `alpha`.

With fewer than 5 samples on either side, the tests are skipped and the verdict uses the
median change alone against `T`; the comparison carries a `thin-comparison` warning and
has no `ci95`/`pValue`.

### Threshold widening

```
effectiveTimingPct = max(thresholds.timingPct,
                         base.environment.noise.floorPct,
                         cand.environment.noise.floorPct)
```

A change smaller than the machine's current jitter is never called a regression. The
value is stored per comparison (`thresholds.effectiveTimingPct`) and in the summary.

### CPU frames and heap types

When both sides have CPU evidence, per-frame self-time changes are reported; a frame
fails the comparison when its self time grows by more than `frameSelfPct` and it has at
least `minFrameSelfUs` of self time on either side. When both sides have heap snapshots,
a heap object type fails when its count grows by more than `heapTypePct`. These make the
comparison's overall `verdict` `"fail"` (exit 1) without changing the timing verdict.
They are plain percentage thresholds, not significance tests: each side is a single
instrumented run.

### Summary

`summary.geomeanPct` is the geometric mean of candidate/base median ratios over matched
timing comparisons, as a signed percent (negative means faster on average).
`summary.verdict` is `"fail"` when any comparison failed.

### Environment mismatch

When base and candidate differ in OS, architecture, Bun version, or (when both have it)
CPU model or core count, every comparison carries an `environment-mismatch` warning with
the differing fields: the delta may reflect the machine rather than the code.
