# preload recipes

`--preload PATH` (see the README's `--preload` section) is a hook, not a feature - ostia
runs your script before each suite file loads and otherwise has no opinion on what's in
it. In practice, almost every adopter benchmarking DOM or framework-component code ends
up writing one of two scripts: something that installs DOM globals, or something that
registers a `Bun.plugin()` loader for a non-`.ts`/`.js` file type. These are worked,
copy-paste-adapt examples of both, plus a lighter-weight DOM variant. None of the
packages below (`jsdom`, `happy-dom`, `svelte`) are ostia dependencies - install
whichever one your suite actually needs.

## jsdom

The naive version of this script does `Object.assign(globalThis, { document, window })`
- see the tiny example in the README. That's enough for suites that only ever touch
`document`, but it breaks the moment a suite does an `instanceof` check
(`node instanceof HTMLElement`, `event instanceof Event`, ...): `HTMLElement` and `Event`
still resolve to `undefined` on `globalThis`, or worse, to some other realm's version of
the same class if another preload script or dependency defined one. DOM constructors all
need to come from the *same* jsdom realm as `document`/`window` for `instanceof` to hold,
which means copying jsdom's entire window surface, not cherry-picking two properties.

```ts
// bench/dom-preload.ts
import { JSDOM } from "jsdom"

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
})

// Left on Bun's own globals rather than jsdom's: `process`/`Bun` because suite code and
// ostia's own instrumentation expect the real runtime, and the timer/microtask functions
// because jsdom's versions aren't wired into Bun's event loop the way the trial harness
// needs them to be.
const KEEP_BUNS_OWN = new Set([
  "process",
  "Bun",
  "global",
  "globalThis",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
])

for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (KEEP_BUNS_OWN.has(key)) continue
  ;(globalThis as Record<string, unknown>)[key] = (dom.window as unknown as Record<string, unknown>)[key]
}
```

```sh
ostia bench --preload ./bench/dom-preload.ts bench/*.dom.bench.ts
```

## happy-dom

Same global-copy pattern, different source object - `happy-dom`'s `Window` class instead
of `JSDOM`'s `.window`. happy-dom trades some spec coverage (fewer of the more obscure
DOM APIs are implemented) for a noticeably faster startup, which matters when `--preload`
runs once per suite-file subprocess. Reach for this first if your suite's DOM surface is
simple (rendering components, reading text content) and only fall back to jsdom if
something you need isn't implemented.

```ts
// bench/happy-dom-preload.ts
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost/" })

const KEEP_BUNS_OWN = new Set([
  "process",
  "Bun",
  "global",
  "globalThis",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
])

for (const key of Object.getOwnPropertyNames(window)) {
  if (KEEP_BUNS_OWN.has(key)) continue
  ;(globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[key]
}
```

## Component-framework compile plugin (Svelte)

Benchmarking `.svelte` (or `.vue`, `.astro`, ...) components means Bun needs to know how
to turn that file into JS before it can import it - `Bun.plugin()`'s `onLoad` hook is the
integration point, registered from a preload script so it's in place before the suite
file's own `import "./MyComponent.svelte"` runs.

Two wrinkles that aren't obvious from the plugin API alone:

- Frameworks that support "module" files - plain `.js`/`.ts` files that still use
  framework-specific syntax (Svelte 5 runes outside a component, e.g.
  `@testing-library/svelte-core`'s own `*.svelte.js` internals) - compile through a
  *different* entry point than components do (`compileModule` vs `compile`). One
  `onLoad` filter matching only `\.svelte$` will miss these and Bun will try to load them
  as plain JS, which fails on the rune syntax.
- `<script lang="ts">` inside a `.svelte` file isn't touched by Bun's own TS transform,
  because that pipeline only applies to files Bun loads directly - content an `onLoad`
  hook fetches by hand (`Bun.file(path).text()`) and hands to the framework compiler
  bypasses it entirely. `Bun.Transpiler` (a Bun-native API, unrelated to ostia) is the
  tool for stripping that script block yourself before compiling.

```ts
// bench/svelte-preload.ts
import { compile, compileModule } from "svelte/compiler"

const transpiler = new Bun.Transpiler({ loader: "ts" })

function stripScriptLangTs(source: string): string {
  return source.replace(
    /<script lang="ts">([\s\S]*?)<\/script>/,
    (_match, code: string) => `<script>${transpiler.transformSync(code)}</script>`,
  )
}

Bun.plugin({
  name: "svelte-compile",
  setup(build) {
    // Components.
    build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const source = stripScriptLangTs(await Bun.file(path).text())
      const { js } = compile(source, { filename: path, generate: "client" })
      return { contents: js.code, loader: "js" }
    })

    // Rune-using plain-JS "module" files - matched separately since the filter above
    // would also match `.svelte.js` and hand it to the wrong compiler entry point.
    build.onLoad({ filter: /\.svelte\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const { js } = compileModule(source, { filename: path, generate: "client" })
      return { contents: js.code, loader: "js" }
    })
  },
})
```

```sh
ostia bench --preload ./bench/svelte-preload.ts bench/*.component.bench.ts
```

Adapting this to another framework means swapping in that framework's own
compile/transform call in place of `compile`/`compileModule` - the `Bun.plugin()` +
`onLoad` + filter-by-extension shape stays the same.
