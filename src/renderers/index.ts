import { collapsedRenderer } from "./collapsed/index.ts"
import { cpuprofileRenderer } from "./cpuprofile/index.ts"
import { jsonRenderer } from "./json/index.ts"
import { jsonlRenderer } from "./jsonl/index.ts"
import { markdownRenderer } from "./markdown/index.ts"
import { mermaidRenderer } from "./mermaid/index.ts"
import { speedscopeRenderer } from "./speedscope/index.ts"
import { terminalRenderer } from "./terminal/index.ts"
import type { FormatName, Renderer } from "./types.ts"

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous Renderer options per format
export const renderers: Record<FormatName, Renderer<any>> = {
  table: terminalRenderer,
  json: jsonRenderer,
  markdown: markdownRenderer,
  jsonl: jsonlRenderer,
  collapsed: collapsedRenderer,
  mermaid: mermaidRenderer,
  speedscope: speedscopeRenderer,
  cpuprofile: cpuprofileRenderer,
}

export type { FormatName, Renderer, RenderResult } from "./types.ts"
