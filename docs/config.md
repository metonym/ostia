# Configuration

`ostia ci`, `ostia baseline` and `ostia compare` read a config file from the current
directory; `ostia bench` reads its `bench` section when present. Discovery checks
`ostia.config.ts` first (default export, typically wrapped in `defineConfig` for type
checking), then `ostia.config.json`. Both support the same fields, except that functions
and `RegExp` values only work in `.ts`.

```ts
// ostia.config.ts
import { defineConfig } from "ostia"

export default defineConfig({
  baseline: "main",
  samples: 15,
  warmup: 3,
  thresholds: { timingPct: 5 },
  workloads: [
    { label: "cold-start", command: ["bun", "src/cli.ts", "--help"], inputs: ["src/**/*.ts"] },
    { label: "spawn", command: ["bun", "-e", "1"], inputs: [] },
    // Same command three ways: warm, one input touched, cold.
    { label: "build:warm", command: ["bun", "cli.ts", "build"], timeSource: { pattern: "in (\\d+)ms" } },
    { label: "build:incremental", command: ["bun", "cli.ts", "build"], timeSource: { pattern: "in (\\d+)ms" },
      prepare: () => touch("posts/hello.md") },
    { label: "build:cold", command: ["bun", "cli.ts", "build"], timeSource: { pattern: "in (\\d+)ms" },
      prepare: "rm -rf dist" },
    { label: "suites", suites: ["bench/*.ts"] },
  ],
  bench: { suites: ["bench/*.ts"], budgetMs: 500, isolate: true },
})
```

```json
{
  "baseline": "main",
  "samples": 15,
  "thresholds": { "timingPct": 5 },
  "workloads": [
    { "label": "cold-start", "command": ["bun", "src/cli.ts", "--help"], "inputs": ["src/**/*.ts"] },
    { "label": "suites", "suites": ["bench/*.ts"] }
  ]
}
```

An `ostia.config.json` that isn't valid JSON, or a config that uses a renamed field, fails
with error code `config-invalid` (exit 2). The top-level `runs` field was renamed to
`samples`; a config that still has `runs` is rejected with a message saying so.

## Top-level fields

| Field | Default | Meaning |
|---|---|---|
| `workloads` | `[]` | What `ci` and `baseline save` measure. See below. |
| `samples` | unset | Command workloads: exact trial count. When unset, `budgetMs`/`minSamples` decide. |
| `budgetMs` | 3000 | Command workloads: sampling budget per workload, ms. |
| `minSamples` | 10 | Command workloads: floor on trials when `samples` is unset. |
| `warmup` | 3 | Command workloads: discarded warmup trials. |
| `baseline` | `"main"` | Default baseline name for `ci` and `baseline save`. |
| `baselineDir` | `.ostia/baselines` | Where baselines are stored. |
| `outDir` | `node_modules/.cache/ostia` | Cache, artifacts, scratch. Independent of `baselineDir`. |
| `thresholds` | see below | Regression thresholds for `ci` and `compare`. Partial objects merge over the defaults. |
| `onMissingBaseline` | unset | `"warn"` or `"fail"`; see [cli.md](cli.md#failures-and-missing-baselines). |
| `noiseCheck` | `true` | Measure the noise floor once per `ci` run. `--no-noise-check` overrides. |
| `bench` | unset | Settings for in-process suites. See below. |

## `thresholds`

| Field | Default | Meaning |
|---|---|---|
| `timingPct` | 5 | Minimum median change, in percent, to call a regression or improvement. |
| `alpha` | 0.01 | Mann-Whitney significance level. |
| `bootstrapIterations` | 2000 | Bootstrap rounds for the 95% CI. |
| `frameSelfPct` | 10 | A CPU frame whose self time grows by more than this fails. |
| `minFrameSelfUs` | 1000 | Frames below this self time on both sides are ignored. |
| `heapTypePct` | 10 | A heap object type whose count grows by more than this fails. |

How these are applied: [statistics.md](statistics.md).

## Workloads

Each workload has exactly one of `command` or `suites`.

| Field | Applies to | Meaning |
|---|---|---|
| `label` | both | Display name. Not part of the workload id. |
| `command` | command | Argv array, run without a shell. |
| `suites` | suites | Suite file globs, run via `bench()`. Every task is gated individually. |
| `inputs` | command | Globs of files the timing depends on, for caching. Absent: always rerun. `[]`: depends on nothing. |
| `prepare` | command | Runs before every trial, unmeasured: a command string, an argv array, or (`.ts` only) a function `({ phase, index }) => ...`. |
| `timeSource` | command | `{ pattern, group?, unit? }`: take the time from the command's output. `pattern` is a regex source string, or a `RegExp` in `.ts` (no `g`/`y`/`d` flags). `group` defaults to 1, `unit` to `"ms"`. |
| `timeoutMs` | command | Kill a trial or prepare hook after this long (default under `ci`: 10 minutes). |
| `ignoreExitCodes` | command | Exit codes treated as success. |

`prepare` and `timeSource` are part of the workload id; `label`, `inputs`, `timeoutMs` and
`ignoreExitCodes` are not, so changing them doesn't orphan a baseline. A function-form
`prepare` can't be fingerprinted, so that workload is never served from cache.

Caching rules for `inputs` are in [cli.md](cli.md#caching).

## `bench`

Used by `ostia bench` (as defaults under its flags) and by `ostia ci`/`ostia baseline save`
for `suites` workloads.

| Field | Default | CLI flag |
|---|---|---|
| `suites` | unset | positional files (used by `ostia bench` only; `ci` uses each workload's own `suites`) |
| `budgetMs` | 500 | `--budget` |
| `samples` | unset | `--samples` |
| `minSamples` | cost-aware | `--min-samples` |
| `jobs` | 1 | `--jobs` (number or `"auto"`) |
| `isolate` | `false` | `--isolate` / `--no-isolate` |
| `gc` | `false` | `--gc` / `--no-gc` |
| `cpu` | `false` | `--cpu` / `--no-cpu` |
| `alloc` | `false` | `--alloc` / `--no-alloc` |
| `filter` | unset | `--filter` |
| `preload` | `[]` | `--preload` (CLI list replaces config list) |
| `bunFlags` | `[]` | `--bun-flags` (CLI list replaces config list), e.g. `["--conditions=browser"]` |
| `outDir` | `node_modules/.cache/ostia` (`ci`: top-level `outDir`) | `--out-dir` |
| `timeoutMs` | none (`ci`: 10 minutes) | `--timeout` |

Suite globs resolve against the current directory.
