// Stands in for a jsdom-style preload script: installs a `document` global
// before the suite file that needs it is imported.
;(globalThis as Record<string, unknown>).document = { title: "preloaded" }
