import { serializeDocument } from "../ir/document.ts";
import type { ProfileDocument } from "../ir/types.ts";
import type { Renderer, RenderResult } from "./types.ts";

export const jsonRenderer: Renderer = {
  name: "json",
  render(doc: ProfileDocument): Promise<RenderResult> {
    return Promise.try(() => ({ text: serializeDocument(doc) }));
  },
};
