# Compare two commands

The default `ostia time` is clean wall-clock timing: warmup, then N trials, no
profiler, ever mixed in. Two commands get a relative column automatically.

```console
ostia time --runs 10 --warmup 2 "bun fixtures/fast.ts" "bun fixtures/slow.ts"
```

```
Task                   Median     Spread             Range              Relative
--------------------------------------------------------------------------------
bun fixtures/fast.ts   15.0 ms    14.0 ms…19.3 ms    12.4 ms…23.7 ms    1.00×
bun fixtures/slow.ts   37.3 ms    34.9 ms…40.7 ms    31.3 ms…48.2 ms    2.49× slower
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
