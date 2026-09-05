# Heap usage

`--heap` captures one instrumented trial's heap snapshot at exit (`bun --heap-prof`)
and summarizes it by type - object counts and retained bytes - instead of leaving you
with a raw `.heapsnapshot` file only DevTools can read. Same phase-separation rule as
`--cpu`: the snapshot trial is labeled `instrumented: true` and never mixed into the
clean timing numbers.

```console
ostia time --heap "bun fixtures/allocate.ts"
```

```
Task                       Median     Spread             Range
---------------------------------------------------------------------------
bun fixtures/allocate.ts   32.5 ms    32.0 ms…34.7 ms    30.2 ms…46.2 ms
  ! outliers-detected

Warnings:
  bun fixtures/allocate.ts: 5 outlier(s) detected (4 severe, 1 mild).

Heap snapshot - bun fixtures/allocate.ts (instrumented, 2516 objects, 0.12MB)
    1369  string
     423  code
     319  closure
     216  object shape
     105  hidden
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
