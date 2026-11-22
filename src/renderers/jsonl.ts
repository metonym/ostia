import { canonicalJSON } from "../ir/fp.ts";
import type { ProfileDocument } from "../ir/types.ts";
import type { Renderer, RenderResult } from "./types.ts";

export const jsonlRenderer: Renderer = {
  name: "jsonl",
  render(doc: ProfileDocument): Promise<RenderResult> {
    return Promise.try(() => {
      const { measurements, ...header } = doc;
      const lines = [
        canonicalJSON({ kind: "document", ...header }),
        ...measurements.map((r) =>
          canonicalJSON({ kind: "measurement", ...r }),
        ),
      ];
      return { text: `${lines.join("\n")}\n` };
    });
  },
};
