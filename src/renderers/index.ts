import { collapsedRenderer } from "./collapsed.ts";
import { conciseRenderer } from "./concise.ts";
import { cpuprofileRenderer } from "./cpuprofile.ts";
import { jsonRenderer } from "./json.ts";
import { jsonlRenderer } from "./jsonl.ts";
import { markdownRenderer } from "./markdown.ts";
import { type MermaidOptions, mermaidRenderer } from "./mermaid.ts";
import { minimalRenderer, type MinimalRenderOptions } from "./minimal.ts";
import { speedscopeRenderer } from "./speedscope.ts";
import { terminalRenderer } from "./terminal.ts";
import type { FormatName, Renderer, VizOptions } from "./types.ts";

/** Each format's renderer, typed with its own options. `Renderer<never>` is
 * the top type, so `satisfies` checks every format is present without
 * widening the options. */
export const renderers: {
  table: Renderer;
  json: Renderer;
  markdown: Renderer;
  jsonl: Renderer;
  events: Renderer<MinimalRenderOptions>;
  /** `events`, by the name it had until 0.5.0. */
  minimal: Renderer<MinimalRenderOptions>;
  concise: Renderer;
  collapsed: Renderer<VizOptions>;
  mermaid: Renderer<MermaidOptions>;
  speedscope: Renderer<VizOptions>;
  cpuprofile: Renderer<VizOptions>;
} = {
  table: terminalRenderer,
  json: jsonRenderer,
  markdown: markdownRenderer,
  jsonl: jsonlRenderer,
  events: minimalRenderer,
  minimal: minimalRenderer,
  concise: conciseRenderer,
  collapsed: collapsedRenderer,
  mermaid: mermaidRenderer,
  speedscope: speedscopeRenderer,
  cpuprofile: cpuprofileRenderer,
} satisfies Record<FormatName, Renderer<never>>;

export type { FormatName, Renderer, RenderResult } from "./types.ts";
