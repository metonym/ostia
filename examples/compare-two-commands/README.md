# Compare two commands

The default `ostia run` is clean wall-clock timing: warmup, then N trials, no
profiler, ever mixed in. Two commands get a relative column automatically.

```console
ostia run --runs 10 --warmup 2 "bun fixtures/fast.ts" "bun fixtures/slow.ts"
```

```
Command                Mean [ms]        Min…Max [ms]        Relative
--------------------------------------------------------------------
bun fixtures/fast.ts   8.327 ± 0.478    7.744…9.390         1.00×
bun fixtures/slow.ts   21.042 ± 0.242   20.742…21.580       2.52× slower
```

`fixtures/fast.ts` and `fixtures/slow.ts` are the same busy-loop at different
sizes - nothing else about them matters for this recipe.

Add `--export-json out.json` to get the same result as a schema-versioned
`ProfileDocument` an agent (or [gate-a-regression](../gate-a-regression/))
can consume instead of parsing the table.

## Run it

```console
bun run demo
```
