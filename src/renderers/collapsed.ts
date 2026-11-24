import type { ProfileDocument } from "../ir/types.ts";
import { buildDenseTree, renderCpuFiles } from "./cpu-tree.ts";
import { frameName } from "./format.ts";
import type { Renderer, RenderResult, VizOptions } from "./types.ts";

export const collapsedRenderer: Renderer<VizOptions> = {
  name: "collapsed",
  render(
    doc: ProfileDocument,
    options: VizOptions = {},
  ): Promise<RenderResult> {
    return Promise.try(() =>
      renderCpuFiles(doc, options, "collapsed.txt", ({ cpu }) => {
        const { nodes, frames } = cpu;
        const tree = buildDenseTree(cpu);

        const pathOf = new Array<string>(tree.count);
        for (const i of tree.order) {
          const node = nodes[i];
          if (node === undefined) continue;
          const name = frameName(frames[node.frameIx]);
          const p = tree.parentIx[i] ?? -1;
          pathOf[i] = p === -1 ? name : `${pathOf[p]};${name}`;
        }

        // Typed counts plus a first-seen list, because this runs over
        // every sample.
        const counts = new Float64Array(tree.count);
        const seen: number[] = [];
        for (const id of cpu.samples?.nodeIds ?? []) {
          const ix = tree.indexOf(id);
          if (ix === -1) continue;
          const count = counts[ix] ?? 0;
          counts[ix] = count + 1;
          if (count === 0) seen.push(ix);
        }
        const lines = seen.map((ix) => `${pathOf[ix]} ${counts[ix]}`);
        return lines.length > 0 ? `${lines.join("\n")}\n` : "";
      }),
    );
  },
};
