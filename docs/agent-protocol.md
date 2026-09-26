# Machine-readable output

`--format minimal` is a line protocol for scripts and LLM agents: one JSON object per
line on stdout, nothing else. It drops the raw sample arrays and prose that make a full
`ProfileDocument` large. It works on `time`, `bench`, `compare`, `ci`, `report` and
`baseline show`.

```sh
ostia time --samples 10 "bun a.ts" --format minimal
ostia bench bench/*.ts --format minimal
ostia compare before.json after.json --format minimal
ostia ci --format minimal; echo $?
```

The TypeScript type for a parsed line is exported as `MinimalEvent`; narrow on `event`.

```ts
import type { MinimalEvent } from "ostia"

const events = stdout.trim().split("\n").map((l) => JSON.parse(l) as MinimalEvent)
const regressed = events.some((e) => e.event === "run" && e.delta?.verdict === "regressed")
```

## Versioning

Every line carries `protocolVersion: 1` (`MINIMAL_PROTOCOL_VERSION`). Within version 1,
keys are only added, never renamed or removed, so a consumer that reads the fields it
knows keeps working. `run` lines also carry the document's `schemaVersion` (currently 2).

## Events

### `run`

One per timing measurement, for every command. Times are in nanoseconds (`unit: "ns"`),
rounded to 6 significant digits.

| Field | Present | Meaning |
|---|---|---|
| `workloadId` | always | Join key to `Workload.id`; stable across runs of the same workload. |
| `task` | always | Display name: the `group/name` task id, the label, or the command line. |
| `group`, `description`, `groupDescription`, `params` | when set | From `group()`/`task()`/`sweep()`. |
| `skipped` | skipped tasks | `true` for `task.skip()`; no stats fields follow. |
| `unit` | measured | `"ns"`. |
| `samples` | measured | Number of timing samples. |
| `batch` | always | Calls per timed trial for batched in-process tasks; 1 otherwise. |
| `mean`, `median`, `stddev`, `min`, `max` | measured | Per-call statistics. |
| `stddevPct` | measured | `stddev / mean` in percent. |
| `p75`, `p99`, `mad` | measured | 75th and 99th percentile; median absolute deviation. |
| `userNs`, `systemNs` | subprocess commands | Median user / system CPU time per trial. |
| `relative` | 2+ runs | Median over the group's reference (its `baseline: true` task, else its fastest). |
| `baseline` | when set | `true` for the group's reference task. |
| `noiseFloorPct` | noise check ran | The machine's noise floor for this document. |
| `warnings` | always | `[{ code, data? }]`: the measurement's warnings, plus CPU-capture and comparison warnings for the same workload. Codes are listed in [document-schema.md](document-schema.md#warnings). |
| `delta` | `compare`/`ci` | See below. |

`delta`:

| Field | Meaning |
|---|---|
| `medianPct`, `meanPct` | Change of the candidate against the baseline, percent. |
| `verdict` | `"regressed"`, `"improved"` or `"unchanged"` (timing only). |
| `pass` | `false` when the comparison failed, including on CPU frame or heap type thresholds. |
| `ci95` | 95% bootstrap CI on the median change, percent. Absent for thin comparisons (<5 samples per side). |
| `pValue` | Mann-Whitney p-value. Same absence rule. |
| `effectiveTimingPct` | The threshold actually applied, after noise-floor widening. |
| `matched` | Always `true`. |

### `unmatched`

`compare`/`ci` only. One per workload present in only one of the two documents.

```json
{"event":"unmatched","protocolVersion":1,"workloadId":"wl_…","task":"old-task","side":"base"}
```

### `summary`

`compare`/`ci` only; always the last line. Never emitted for `time`, `bench` or `report`.

| Field | Meaning |
|---|---|
| `command` | `"compare"` or `"ci"`. |
| `matched`, `regressed`, `improved`, `unchanged` | Counts over matched workloads (timing verdicts). |
| `unmatched` | Count of `unmatched` events. |
| `cached`, `executed`, `failed`, `missingBaseline` | `ci` only. `failed` counts harness failures. |
| `geomeanPct` | Geometric mean of candidate/base median ratios, as a signed percent; `null` when there were no timing comparisons. |
| `effectiveTimingPct` | Threshold after noise-floor widening. |
| `noiseFloorPct` | When the candidate document has one. |
| `baseline` | `ci` only: `{ name, path }`. |
| `git` | `{ base?, cand? }`, each `{ sha, branch, dirty }`, when available. |
| `exportedTo` | The `--export-json` path, when given. |
| `verdict` | `"pass"` when `exitCode` is 0, else `"fail"`. |
| `exitCode` | The process's exit code. |

Example (`ostia ci --format minimal` after a regression):

```
{"event":"run","protocolVersion":1,"schemaVersion":2,"workloadId":"wl_11e8562f3622d528","task":"work","unit":"ns","samples":10,"batch":1,"mean":21012800,"median":20999900,"stddev":231456,"stddevPct":1.1015,"min":20664000,"max":21552300,"warnings":[{"code":"outliers-detected","data":{"mild":1,"severe":0}}],"p75":21086100,"p99":21517600,"mad":126625,"userNs":15519000,"systemNs":6015500,"noiseFloorPct":2.09286,"delta":{"medianPct":44.0989,"meanPct":43.9626,"verdict":"regressed","pass":false,"effectiveTimingPct":10,"matched":true,"ci95":[41.4394,45.5841],"pValue":0.000157103}}
{"event":"summary","protocolVersion":1,"command":"ci","matched":1,"regressed":1,"improved":0,"unchanged":0,"unmatched":0,"geomeanPct":44.098920968212305,"effectiveTimingPct":10,"verdict":"fail","exitCode":1,"cached":1,"executed":0,"failed":0,"missingBaseline":0,"baseline":{"name":"main","path":".ostia/baselines/main.json"},"noiseFloorPct":2.09286}
```

## Exit codes

The same across commands:

| Code | Meaning |
|---|---|
| `0` | Pass. |
| `1` | At least one workload failed its comparison (`compare`, `ci`). `time` and `bench` never return 1. |
| `2` | Harness error: the numbers couldn't be produced or compared. |
| `130` | Cancelled with Ctrl-C (`time`, `bench`). |

`--help` exits 0; a missing required argument prints the help and exits 2.

## Errors

On exit 2, stderr gets a prose message. When stderr is not a TTY, or `--format` is
`minimal`, `json` or `jsonl`, one more line follows it as the last line of stderr:

```json
{"event":"error","protocolVersion":1,"code":"command-failed","message":"One or more commands failed to produce a clean measurement; see the report above for details."}
```

`message` is the first line of the prose message; `data` is included when there is
structured detail. stdout stays pure JSON for the machine formats.

| `code` | Cause |
|---|---|
| `invalid-flag` | Unknown flag or subcommand, bad flag value, bad `--time-source` regex, wrong number of `--prepare` hooks, invalid baseline name. |
| `config-missing` | No `ostia.config.ts`/`ostia.config.json`, or no `workloads` (`ci`, `baseline`). |
| `config-invalid` | The config file can't be loaded: invalid JSON, an `ostia.config.ts` that throws on import, or a renamed field (e.g. `runs`, now `samples`). |
| `baseline-missing` | No baseline file, or the baseline doesn't cover the configured workloads (`onMissingBaseline`). |
| `no-matches` | `compare` found no workload id in both documents. |
| `spawn-failed` | A run threw: a command couldn't start, a `prepare` hook failed or timed out, a suite failed or timed out. |
| `command-failed` | A command had a non-ignored non-zero exit (`time`, `ci`), or produced no samples for another reason. |
| `timeout` | `time`: a command produced no samples because its trials timed out. |
| `time-source-no-match` | `time`: a command produced no samples because no trial's output matched `--time-source`. |
| `document-load-failed` | `compare`/`report` couldn't read a document (missing file, invalid JSON, unsupported schema version). |
| `no-cpu-evidence` | A visualization format was requested for a document with no CPU measurement. |
| `internal` | An unexpected error (a bug in ostia); the message carries the stack. |

## `--format jsonl`

For the full document rather than the condensed protocol: a `kind: "document"` header
line (the document minus `measurements`), then one `kind: "measurement"` line per
measurement, including raw samples and trials.

## `--format json`

The whole document, byte-identical to what `--export-json` writes. Schema:
[document-schema.md](document-schema.md).
