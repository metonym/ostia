# ProfileDocument schema

Every command and library call produces a `ProfileDocument`: one JSON object holding the
workloads measured, their measurements, and (after a comparison) the comparisons. The
TypeScript source of truth is [`src/ir/types.ts`](../src/ir/types.ts); `ProfileDocument`,
`Workload`, `Comparison`, `Warning` and `WarningCode` are exported from `ostia`.

Units are fixed: nanoseconds for time, bytes for memory, microseconds for sampling
intervals.

## Versioning

`schemaVersion` is `2`. `loadDocument` (and therefore `compare`, `report`, `ci`) rejects
any other version with `OstiaDocumentError` (`code: "unsupported-schema"`); version 1
documents can't be loaded. New optional fields are added without a version bump.

Documents written before ostia 0.2.4 lack `p25`/`p75`/`p99`/`mad`; `loadDocument`
recomputes them from the stored samples, so every loaded `TimingStats` has them.

`ab` documents written by ostia 0.2.8-0.2.9 name the ratio quartiles of
`PairedEvidence` (and its `repeats`) `p25`/`p75`; they are now `ratioP25`/`ratioP75`,
distinct from `TimingStats.p25`/`p75`, which are ns. This did not bump `schemaVersion`:
`loadDocument` reads the old names as the new ones.

`OstiaDocumentError.code` is `"invalid-json"`, `"not-a-document"` (no numeric
`schemaVersion`, or `workloads`/`measurements` that aren't arrays of well-formed
objects) or `"unsupported-schema"`.

## Top level

| Field | Meaning |
|---|---|
| `schemaVersion` | `2`. |
| `toolVersion`, `bunVersion` | ostia and Bun versions that produced the document. |
| `platform` | `{ os, arch }`. |
| `createdAt` | ISO timestamp. Metadata only. |
| `workloads` | `Workload[]`: what was measured. |
| `measurements` | `Measurement[]`: one per workload and phase. |
| `environment?` | `{ cpuModel, cores, loadAvg1, loadAvg5, noise: { floorPct, referenceMedianNs, samples } }`. Absent when the noise check was skipped. |
| `git?` | `{ sha, branch, dirty }` from the process's cwd. Absent outside a repo. Never part of an id or cache key. |
| `comparisons?` | `Comparison[]`, on a candidate document written by `compare`/`ci`. |
| `comparisonSummary?` | `{ matched, regressed, improved, unchanged, geomeanPct, effectiveTimingPct, verdict }`. |
| `unmatched?` | `{ baseOnly: string[], candOnly: string[] }`: workload ids on only one side. |
| `ab?` | From `ostia ab`/`ab()`: `{ base: { ref, sha }, newSuites?, rounds, thresholdPct, geomeanThresholdPct, matched, regressed, improved, unchanged, unconfirmed, outputDiffers, notComparable, threw, memory?, geomeanPct, verdict }`. `memory` (`{ thresholdPct, regressed, improved }`) is there when any task has a memory reading. |

## Workloads

| Field | Meaning |
|---|---|
| `id` | Stable identity; see below. |
| `kind` | `"subprocess"` or `"inprocess"`. |
| `label?` | Display name. |
| `command?` | Argv, for subprocess workloads. |
| `prepare?` | Argv of a command-form prepare hook. |
| `timeSource?` | `{ pattern, group?, unit? }`. |
| `entry?` | `{ file, task, group? }` for suite tasks; `task` is the `group/name` id. |
| `baseline?` | The group's Relative reference. |
| `description?`, `groupDescription?` | From `task()`/`group()` options. |
| `isolated?` | Ran in a process of its own. |
| `params?` | From `task(..., { params })` or `sweep()`. |
| `skipped?` | From `task.skip()`/`group.skip()`; there is no measurement. |

### Workload ids

Ids identify what was measured, not where or when:

- Subprocess command: a hash of the argv, plus the `prepare` hook (its argv, or a
  function's source text) and the `timeSource` spec when present. The working directory is
  not included, so a baseline saved in one checkout (a CI runner, another worktree)
  matches a run from another.
- Suite task: a hash of the suite file path relative to the working directory, the
  `group/name` task id, and `params` when present, so, as with commands, moving the
  checkout doesn't change the id.
- `profile()` capture: a hash of the `name` option when given (it is also the label),
  else of the function's name and source text, so closures that differ only in captured
  values share an id unless named.

`label`, `description`, `baseline`, `inputs`, `timeoutMs` and `ignoreExitCodes` never
affect the id. (`profile()`'s `name` is the exception only because it is the workload's
identity; it is shown as the label too.)

## Measurements

| Field | Meaning |
|---|---|
| `id` | Hash of the workload id, phase, config fingerprint, Bun and ostia versions. |
| `workloadId` | The workload measured. |
| `phase` | `"timing"`, `"cpu"`, `"heap"`, `"memstats"` or `"paired"` (`ab`). |
| `instrumented` | `true` for cpu/heap/memstats: a separate, profiled run, never mixed into timing. |
| `configFingerprint` | Hash of the sampling settings that produced it. |
| `trials` | `Trial[]`. |
| `timing?` | `TimingStats`, on timing measurements with at least one sample; on a paired measurement, the candidate side's per-call times, one sample per round. |
| `paired?` | Paired measurements only; see below. |
| `threw?` | Paired measurements only: `{ side: "base" \| "cand" \| "both", message, repeat? }` for a task that threw. Usually instead of `timing` and `paired`; when it threw in a confirmation repeat, `repeat` (from 1) says which, and `timing`/`paired` keep the first process's numbers. Either way it's left out of `matched` and the geomean. |
| `interleaved?` | Trials were round-robined with other commands. |
| `diagnosticWallNs?` | Wall time of an instrumented run. |
| `cpu?`, `jit?` | CPU evidence (frames, call tree, per-frame totals, samples) and JIT tier counts (`llint`, `baseline`, `dfg`, `ftl`). |
| `heap?` | `{ typeCounts, objectCount?, heapSizeBytes? }` from a heap snapshot. |
| `memory?` | `maxRssBytes` (subprocess timing), or on `memstats`: `kind: "retained"` with `bytesPerOp` (`--alloc`: heap each call keeps alive after a full GC) or `kind: "peak"` with `peakBytes` (`--peak-mem`: how far the task's first call raised RSS, median of 3 fresh processes). A `memstats` measurement without `kind` predates the field and is `"retained"`. |
| `warnings` | `Warning[]`. |
| `artifacts` | `{ kind, path, sha256, bytes }[]`: raw `.cpuprofile`/`.heapsnapshot` files. |

`Trial`: `{ i, wallNs, exitCode?, userNs?, systemNs?, maxRssBytes?, reportedNs?, timedOut?, timeSourceNoMatch? }`.
`reportedNs` is the value parsed by a `timeSource`; timed-out and unmatched trials
contribute no sample.

`TimingStats`: `{ unit: "ns", samples, mean, median, stddev, min, max, outliers: { mild, severe }, p25, p75, p99, mad, batch? }`.
For batched in-process tasks, `samples` are per-call times and `batch` is the number of
calls per trial.

`PairedEvidence` (`phase: "paired"`): `{ rounds, batch, baseSamples, baseMedianNs, ratios,
medianRatio, ratioP25, ratioP75, flagged?, repeats?, confirmed?, verdict, sameOutput,
suiteChanged?, retained?, peak? }`. `baseSamples[i]` and `timing.samples[i]` are the two sides' per-call
times in round `i`, and `ratios[i]` is candidate over base. `flagged` is what the first
process saw; `repeats` are the fresh-process re-measurements of a flagged task
(`{ medianRatio, ratioP25, ratioP75, flagged? }`), and `verdict` is `flagged` only when
`confirmed`. `suiteChanged` is `true` when the suite file differs from the base's copy;
with `sameOutput: false` too, `verdict` is `unchanged`. `retained` (`--alloc`) and `peak`
(`--peak-mem`) are `MemoryChange`s: `{ baseBytes, candBytes, verdict, floorBytes }`, where
`verdict` counts only a change past both the memory threshold and `floorBytes`. See
[cli.md](cli.md#ostia-ab).

## Comparisons

| Field | Meaning |
|---|---|
| `baselineMeasurementId`, `candidateMeasurementId` | The pair compared. |
| `timing?` | `{ medianDeltaPct, meanDeltaPct, ci95?, pValue?, seed?, verdict }`. |
| `frames?` | Per-frame `{ frameKey, name, baseSelfUs, candSelfUs, deltaPct }`, largest change first. |
| `heapTypes?` | Per-type `{ type, baseCount, candCount, baseBytes?, candBytes?, deltaPct }`. |
| `thresholds` | The thresholds applied, plus `effectiveTimingPct`. |
| `warnings?` | `thin-comparison`, `skipped`, `environment-mismatch`. |
| `verdict` | `"pass"` or `"fail"`. |

See [statistics.md](statistics.md) for how these are computed.

## Warnings

`Warning` is `{ code, message, data? }`. The terminal table prints codes under each row
and messages below the table; `--format minimal` includes `code` and `data`.

| Code | Where | When |
|---|---|---|
| `slow-first-run` | timing | The first sample is both an outlier (above median + 3×IQR) and more than twice the median. |
| `outliers-detected` | subprocess timing | IQR outliers present. Not emitted for in-process tasks, whose GC tails are expected and don't move the median. |
| `fast-command` | subprocess timing | Median under 5ms: spawn overhead may dominate. |
| `nonzero-exit` | subprocess timing | A trial exited non-zero with a code that isn't ignored. `data.exitCodes`. |
| `timeout` | subprocess timing | Trials were killed by `timeoutMs`. |
| `time-source-no-match` | subprocess timing | Trials' output didn't match the `timeSource` pattern. `data: { pattern, trials, output }`. |
| `noisy-machine` | first measurement (`ci`: every executed one) | 1-minute load average above 75% of available cores. |
| `low-sample-count` | in-process timing, `--cpu` capture | Timing: fewer samples than the task's cost class calls for (explicit `minSamples` only). CPU: fewer than 1,000 samples; `data: { samples, target, intervalUs }`. |
| `jit-cold` | `--cpu` capture | More than 20% of samples in the llint/baseline tiers. |
| `empty-profile` | CPU capture | The profile recorded no samples (`--cpu` or `profile()`). |
| `artifact-missing` | CPU/heap capture | The expected `.cpuprofile`/`.heapsnapshot` file wasn't written. |
| `aborted` | last measurement | The run was cancelled; the document is partial. |
| `thin-comparison` | comparison | Fewer than 5 samples on a side; point-estimate verdict. |
| `skipped` | comparison | The candidate task was skipped; treated as unchanged. |
| `environment-mismatch` | comparison | The documents came from different platforms, Bun versions, or CPUs. |
| `suite-changed` | `ab` | The suite file's text differs from the base ref's copy, so each side may run a different benchmark. When the output differs too, the task is not comparable: verdict `unchanged`, left out of the geomean. |
| `peak-hidden` | `--peak-mem` | Earlier work in the process (module-scope setup, `before` hooks) freed 16 MiB or more that the allocator still held, which the call could reuse without RSS rising, so `peakBytes` can be that much low. `data: { slackBytes, processes }`. |

## Files on disk

- `outDir` (default `node_modules/.cache/ostia`): the `ci` cache, `artifacts/`, `bench`
  and `ab` scratch files, and `ab/<sha>/` (or `ab/<sha>-<hash>/` with setup commands),
  the base trees `ab` extracts (one per commit and setup, reused; the 5 most recently used
  are kept, see `--keep-trees`).
- `baselineDir` (default `.ostia/baselines`): `<name>.json` baselines.

Documents are written atomically (temp file, then rename), so an interrupted write never
leaves a truncated file.
