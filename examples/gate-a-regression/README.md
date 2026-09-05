# Gate a regression

`ostia.config.json` declares workloads once; `ostia ci` reruns only the ones
whose fingerprint changed (via declared `inputs`), compares against a named
baseline, and exits nonzero on a real regression.

```json
{
  "thresholds": { "timingPct": 15 },
  "workloads": [
    { "label": "work", "command": ["bun", "fixtures/work.ts"], "inputs": ["fixtures/work.ts"] }
  ]
}
```

Write a local baseline once (gitignored under `.ostia/`):

```console
ostia time --export-json .ostia/baselines/main.json bun fixtures/work.ts
```

Same idea when you branch to optimize: seed on known-good, switch branches, then
`ostia ci` while you work. Do not re-seed on the branch you are guarding. In this
repo, `bun run baseline` does the seed from root `ostia.config.json`.

Then `ostia ci` on unchanged code passes and reuses the cache on a second run:

```console
ostia ci
# 1 workloads
# 1 affected by this change
# 0 cached
# 1 executed
# 1 passed  0 regressed
#
# Profile CI: ✓
```

Slow the workload down and `ostia ci` catches it - the `inputs` glob sees the
file changed, reruns it, and the gate fails:

```console
ostia ci
# 1 workloads
# 1 affected by this change
# 0 cached
# 1 executed
# 0 passed  1 regressed (+1169.3% median on work)
#
# Profile CI: ✗
```

Exit codes: `0` pass, `1` regression, `2` harness error (missing config,
missing baseline, spawn failure) - safe to wire directly into CI. CI does not need
a committed baseline: measure the base branch (or a previous good run) into
`.ostia/baselines/`, then run `ostia ci` on the candidate.

## Run it

```console
bun run demo
```

The demo writes a baseline, runs `ostia ci` against unchanged code (passes),
then temporarily edits `fixtures/work.ts` to be ~40x slower and runs `ostia ci`
again (fails) - restoring the original file afterward either way.
