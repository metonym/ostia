# Profile a function in-process

`profile(fn, opts)` is the library path - no subprocess, no CLI. It's the
only place `origin: "jsc"` is available: `bun:jsc.profile()` reports which
JIT tier (LLInt/Baseline/DFG/FTL) each sample landed in, which Chrome
DevTools/CDP-based tooling simply cannot say.

```ts
import { profile } from "ostia"

function hashLoop(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 2654435761) % 1000000007
  return acc
}

const { result, run } = await profile(() => hashLoop(8_000_000), { origin: "jsc", intervalUs: 100 })
console.log(run.jit?.tiers)
```

```
{
  llint: 0,
  baseline: 9,
  dfg: 37,
  ftl: 2825,
}
```

Almost every sample landed in FTL - the loop warmed up and JSC optimized it
almost immediately. A function stuck in LLInt/Baseline despite running a lot
is a different kind of bug than a hot FTL function (deopt loop, megamorphic
call site, etc.) - this is the one piece of evidence that tells them apart.

`run.cpu` carries the same self/total-time breakdown every other capture
origin does, so it renders and diffs the same way:

```ts
import { renderers } from "ostia"
const { text } = await renderers.markdown.render({ /* wrap run in a ProfileDocument */ }, {})
```

`origin: "inspector"` (the default) skips the tier data but gives you a
portable `.cpuprofile`-shaped result via `node:inspector` instead - see
[find-a-hotspot](../find-a-hotspot/) for the subprocess/CLI equivalent.

## Run it

```console
bun run demo
```
