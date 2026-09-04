import type { ProfileDocument } from "../ir/types.ts"

export type FormatName =
  | "table"
  | "json"
  | "markdown"
  | "jsonl"
  | "minimal"
  | "collapsed"
  | "mermaid"
  | "speedscope"
  | "cpuprofile"

export interface VizOptions {
  runId?: string
}

export interface RenderResult {
  text?: string
  files?: { path?: string; content: string }[]
}

export interface Renderer<O = unknown> {
  name: FormatName
  render(doc: ProfileDocument, options: O): Promise<RenderResult>
}
