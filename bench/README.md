# bench/

In-process `group()`/`task()` suites that dogfood ostia's own hot paths - each file
covers one subsystem, running the real library code (not a mock) against synthetic but
deterministic fixtures (`bench/lib/fixtures.ts`).

| File | Covers |
|---|---|
| `stats.ts` | `computeTimingStats`, `timingWarnings` - the sort-heavy path behind every `run`/`ci` |
| `ir.ts` | `fp`/`canonicalJSON`/`sortKeysDeep`, `makeTimingRun`/`makeInstrumentedRun`, `serializeDocument`, `makeArtifactRef` |
| `capture-parse.ts` | `parseCpuProfile`, `parseJscProfile`, `parseHeapSnapshot` - raw capture JSON to IR |
| `cpu-tree.ts` | `buildParentMap`, `computeNodeTimes` - shared ranking behind the mermaid/collapsed renderers |
| `compare.ts` | `compareDocuments`, `compareWorkload` - the diff engine behind `compare`/`ci` |
| `render.ts` | every renderer format: table, json, jsonl, markdown, collapsed, mermaid, speedscope, cpuprofile pass-through |
| `cache.ts` | `computeCacheKey`, `computeInputsDigest` - scans this repo's own `src/**/*.ts`, the same glob `ostia.config.json`'s cold-start workload declares |

`bench/lib/fixtures.ts` is shared setup, not a suite - it's one directory level down so
`bench/*.ts` globs (`bun run bench`) only pick up real suites, never it.

Subprocess-level metrics (spawn overhead, cold start, warm-cache `ci`) live in
`ostia.config.json`'s workloads instead, since those need a real process spawn and
aren't in-process tasks.

## Running

```console
bun run bench                # full-fidelity run, printed table (mitata-shaped: 500ms/task)
bun src/cli/main.ts bench bench/stats.ts   # a single suite
```

## Baseline

`.ostia/baselines/bench-main.json` is a local reference snapshot for comparing
future runs against (gitignored with the rest of `.ostia/`). Capture it with a
much smaller time budget than `bun run bench`
(`--time-budget 3 --min-samples 30` via `bun run bench:baseline`). At full 500ms/task
fidelity, nanosecond-scale tasks batch into millions of samples and the exported
document (which embeds the full raw sample array per the schema's agent contract)
balloons past 400MB. The smaller budget keeps the file in the low single-digit
MB while still producing a valid `ProfileDocument`.

This is separate from `bun run baseline` / `ostia ci`, which gate the subprocess
workloads in `ostia.config.json`. Use that path when you want a hard local or CI
regression gate; use `bench-main` only as a manual sanity check on in-process hot
paths.

To check for a regression against the bench snapshot:

```console
git checkout master
bun run bench:baseline

git checkout -b my-opt
# ... change a hot path ...
bun src/cli/main.ts bench bench/*.ts --export-json /tmp/bench.json
bun src/cli/main.ts compare .ostia/baselines/bench-main.json /tmp/bench.json
```

This is not wired into `bun run dogfood`/CI as a hard gate: at nanosecond scale, run-to-
run noise on a shared dev machine routinely swings past the default 5% timing threshold,
so an automated gate here would be flaky rather than useful. Refresh
`bun run bench:baseline` when a real, intentional improvement lands.
