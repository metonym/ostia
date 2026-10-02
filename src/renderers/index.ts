import { collapsedRenderer } from "./collapsed/index.ts"
import { cpuprofileRenderer } from "./cpuprofile/index.ts"
import { jsonRenderer } from "./json/index.ts"
import { jsonlRenderer } from "./jsonl/index.ts"
import { markdownRenderer } from "./markdown/index.ts"
import { mermaidRenderer } from "./mermaid/index.ts"
import { minimalRenderer } from "./minimal/index.ts"
import { speedscopeRenderer } from "./speedscope/index.ts"
import { terminalRenderer } from "./terminal/index.ts"
import type { FormatName, Renderer } from "./types.ts"

/** Each format's renderer, typed with its own options. `Renderer<never>` is
 * the top type, so `satisfies` checks every format is present without
 * widening the options. */
export const renderers = {
  table: terminalRenderer,
  json: jsonRenderer,
  markdown: markdownRenderer,
  jsonl: jsonlRenderer,
  minimal: minimalRenderer,
  collapsed: collapsedRenderer,
  mermaid: mermaidRenderer,
  speedscope: speedscopeRenderer,
  cpuprofile: cpuprofileRenderer,
} satisfies Record<FormatName, Renderer<never>>

export type { FormatName, Renderer, RenderResult } from "./types.ts"
