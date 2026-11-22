import { collapsedRenderer } from "./collapsed.ts";
import { cpuprofileRenderer } from "./cpuprofile.ts";
import { jsonRenderer } from "./json.ts";
import { jsonlRenderer } from "./jsonl.ts";
import { markdownRenderer } from "./markdown.ts";
import { mermaidRenderer } from "./mermaid.ts";
import { minimalRenderer } from "./minimal.ts";
import { speedscopeRenderer } from "./speedscope.ts";
import { terminalRenderer } from "./terminal.ts";
import type { FormatName, Renderer } from "./types.ts";

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
} satisfies Record<FormatName, Renderer<never>>;

export type { FormatName, Renderer, RenderResult } from "./types.ts";
