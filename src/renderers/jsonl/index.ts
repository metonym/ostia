import { canonicalJSON } from "../../ir/fp.ts"
import type { ProfileDocument } from "../../ir/types.ts"
import type { Renderer, RenderResult } from "../types.ts"

export const jsonlRenderer: Renderer<Record<string, never>> = {
  name: "jsonl",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const { runs, ...header } = doc
    const lines = [canonicalJSON(header), ...runs.map((r) => canonicalJSON(r))]
    return { text: `${lines.join("\n")}\n` }
  },
}
