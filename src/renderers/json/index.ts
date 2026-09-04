import { serializeDocument } from "../../ir/document.ts"
import type { ProfileDocument } from "../../ir/types.ts"
import type { Renderer, RenderResult } from "../types.ts"

export const jsonRenderer: Renderer<Record<string, never>> = {
  name: "json",
  async render(doc: ProfileDocument): Promise<RenderResult> {
    return { text: serializeDocument(doc) }
  },
}
