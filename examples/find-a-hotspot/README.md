# Find a hotspot

`--cpu` schedules one instrumented CPU-capture trial (subprocess `bun --cpu-prof`
under the hood). It's a separate, labeled run - never mixed into the timing
stats above it, so a profiled run can't quietly become "the benchmark."

```console
ostia run --runs 5 --cpu --cpu-interval 200 --export-json .ostia/doc.json fixtures/work.ts
```

```
Command                Mean [ms]        Min…Max [ms]
----------------------------------------------------
bun fixtures/work.ts   282.705 ± 13.668  272.587…309.690

CPU capture - bun fixtures/work.ts (instrumented, 200µs interval, diagnostic wall 293.812ms)
   99.9%    281.63ms self  hashLoop
    0.1%      0.26ms self  isServerConfig
  artifact: .ostia/artifacts/<run-id>-cpu.cpuprofile
```

`hashLoop` is 99.9% of self time - that's the hotspot. `fixtures/work.ts` has
one hot function and one that barely runs, so this is easy to eyeball, but
the same table is what you'd get pointed at real code.

## Viz is files, not a GUI

The captured evidence turns into whatever shape is useful:

```console
ostia viz .ostia/doc.json --format collapsed
# (root);(module);hashLoop 1053

ostia viz .ostia/doc.json --format mermaid
# graph TD
#   n3["hashLoop (self 281.63ms, total 281.63ms)"]
#   ...

ostia viz .ostia/doc.json --format speedscope > flame.json
# open flame.json at speedscope.app
```

Collapsed stacks feed flamegraph.pl and most flame tooling; speedscope JSON
opens directly at speedscope.app; the raw `.cpuprofile` artifact opens in
Chrome DevTools or VS Code as-is.

## Run it

```console
bun run demo
```
