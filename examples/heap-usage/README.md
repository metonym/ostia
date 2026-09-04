# Heap usage

`--heap` captures one instrumented trial's heap snapshot at exit (`bun --heap-prof`)
and summarizes it by type - object counts and retained bytes - instead of leaving you
with a raw `.heapsnapshot` file only DevTools can read. Same phase-separation rule as
`--cpu`: the snapshot trial is labeled `instrumented: true` and never mixed into the
clean timing numbers.

```console
ostia run --heap "bun fixtures/allocate.ts"
```

```
Command                    Mean [ms]        Min…Max [ms]
--------------------------------------------------------
bun fixtures/allocate.ts   27.270 ± 3.488   23.912…44.858

Heap snapshot - bun fixtures/allocate.ts (instrumented, 2518 objects, 0.12MB)
    1369  string
     426  code
     321  closure
     216  object shape
     104  hidden
  artifact: .ostia/artifacts/<run-id>-heap.heapsnapshot
```

`fixtures/allocate.ts` builds 200k small objects and distinct strings before exiting -
`string` dominating the type breakdown is the signal that a change actually shows up
here, the same way a hot frame shows up in `--cpu`.

The raw `.heapsnapshot` artifact is still written to disk (openable in DevTools if you
want the full retainer graph); the table is the IR's own summary of it, so it also
renders as markdown/JSON and diffs the same way `--cpu` frames do (`heapTypePct` in
[gate-a-regression](../gate-a-regression/)'s thresholds).

## Run it

```console
bun run demo
```
