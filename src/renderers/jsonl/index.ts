import { canonicalJSON } from "../../ir/fp.ts"
import type { ProfileDocument } from "../../ir/types.ts"
import type { Renderer, RenderResult } from "../types.ts"

export const jsonlRenderer: Renderer<Record<string, never>> = {
  name: "jsonl",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    const { measurements, ...header } = doc
    const lines = [
      canonicalJSON(header),
      ...measurements.map((r) => canonicalJSON(r)),
    ]
    return { text: `${lines.join("\n")}\n` }
  },
}
