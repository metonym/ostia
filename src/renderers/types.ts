import type { ProfileDocument } from "../ir/types.ts";

export type FormatName =
  | "table"
  | "json"
  | "markdown"
  | "jsonl"
  | "events"
  /** `events`, by the name it had until 0.5.0. */
  | "minimal"
  | "concise"
  | "collapsed"
  | "mermaid"
  | "speedscope"
  | "cpuprofile";

export interface VizOptions {
  /** Render this measurement only, instead of every CPU measurement. */
  measurementId?: string;
}

export interface RenderResult {
  text?: string;
  files?: { path?: string; content: string }[];
}

export interface Renderer<O = unknown> {
  name: FormatName;
  render(doc: ProfileDocument, options: O): Promise<RenderResult>;
}
