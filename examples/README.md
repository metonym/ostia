# Examples

Each folder is a tiny, self-contained package showing one thing ostia
does. There's no build step and no installable dependency - every example
references `../../src` directly by relative path (CLI examples spawn
`bun ../../src/cli/main.ts`; the library example imports from
`../../src/index.ts`). `bun install` is not needed.

## Recipes

- [compare-two-commands](compare-two-commands/) - `ostia run` on two commands, hyperfine-style relative timing table
- [find-a-hotspot](find-a-hotspot/) - `ostia run --cpu` + `ostia viz --format collapsed|mermaid` to name where time goes
- [heap-usage](heap-usage/) - `ostia run --heap`, ranked object-type/retained-bytes breakdown
- [gate-a-regression](gate-a-regression/) - `ostia.config.json` + a local (gitignored) baseline + `ostia ci`; seed on known-good, then gate while you branch
- [profile-in-process](profile-in-process/) - library `profile(fn, { origin: "jsc" })`, JIT tier breakdown (LLInt/Baseline/DFG/FTL) for a function
- [benchmark-a-function](benchmark-a-function/) - library `bench()`/`group()`/`task()`, mitata-shaped in-process microbenchmarking

## Run them

```console
cd examples/<recipe>
bun run demo
```

or run all of them: `bun run examples` from the repo root.

Each recipe's `demo` script runs the real thing end to end (spawns `ostia` or
calls the library) and prints what it found - it is not a docs test framework
bolted onto ostia; per ostia's own non-goals, that is not what this
project builds. The README in each folder is prose plus the same commands you
would run yourself.

## Adding a recipe

1. Create `examples/<job>/` with `package.json`, `README.md`, and whatever
   fixture files the recipe needs.
2. Reference ostia by relative path, not a package dependency: spawn
   `${import.meta.dir}/../../src/cli/main.ts` for CLI recipes, or
   `import { ... } from "../../src/index.ts"` for library recipes.
3. Add a `demo` script that runs the recipe for real and exits nonzero on
   failure - no framework, just `Bun.spawn`/library calls and assertions.
4. Keep the workload/fixture code trivial. The recipe is ostia's wiring,
   not the thing being measured.
