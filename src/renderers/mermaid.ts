import type { ProfileDocument } from "../ir/types.ts";
import {
  buildDenseTree,
  computeDenseNodeTimes,
  renderCpuFiles,
} from "./cpu-tree.ts";
import { formatUsAsMs, frameName } from "./format.ts";
import type { Renderer, RenderResult, VizOptions } from "./types.ts";

const DEFAULT_TOP_N = 15;

export interface MermaidOptions extends VizOptions {
  topN?: number;
}

function label(name: string, selfUs: number, totalUs: number): string {
  return `${name.replace(/"/g, "'")} (self ${formatUsAsMs(selfUs)}ms, total ${formatUsAsMs(totalUs)}ms)`;
}

// Insertion into a sorted window instead of a full sort, since n is
// small: O(count * n).
function topNBySelf(
  selfUs: Float64Array,
  count: number,
  exclude: number,
  n: number,
): number[] {
  const top: number[] = [];
  if (n <= 0) return top;
  const selfAt = (ix: number | undefined) =>
    ix === undefined ? 0 : (selfUs[ix] ?? 0);
  for (let i = 0; i < count; i++) {
    if (i === exclude) continue;
    const v = selfAt(i);
    if (top.length === n && v <= selfAt(top[n - 1])) continue;
    let j = top.length;
    while (j > 0 && selfAt(top[j - 1]) < v) j--;
    top.splice(j, 0, i);
    if (top.length > n) top.pop();
  }
  return top;
}

export const mermaidRenderer: Renderer<MermaidOptions> = {
  name: "mermaid",
  render(
    doc: ProfileDocument,
    options: MermaidOptions = {},
  ): Promise<RenderResult> {
    return Promise.try(() => {
      const topN = options.topN ?? DEFAULT_TOP_N;

      return renderCpuFiles(doc, options, "mermaid.md", ({ cpu }) => {
        const { nodes, frames } = cpu;
        const tree = buildDenseTree(cpu);
        const { selfUs, totalUs } = computeDenseNodeTimes(cpu, tree);
        const { parentIx } = tree;
        const rootIx = tree.roots[0] ?? -1;

        // The top-N self-time nodes plus every ancestor, so each has a path to
        // the root.
        const included = new Set<number>(rootIx !== -1 ? [rootIx] : []);
        for (const ix of topNBySelf(selfUs, tree.count, rootIx, topN)) {
          const path: number[] = [];
          for (let cur = ix; cur !== -1; cur = parentIx[cur] ?? -1) {
            path.push(cur);
          }
          for (const p of path.toReversed()) included.add(p);
        }

        const id = (ix: number) => `n${nodes[ix]?.id}`;
        const lines = ["graph TD"];
        for (const ix of included) {
          const node = nodes[ix];
          if (node === undefined) continue;
          const name = frameName(frames[node.frameIx]);
          lines.push(
            `  ${id(ix)}["${label(name, selfUs[ix] ?? 0, totalUs[ix] ?? 0)}"]`,
          );
        }
        for (const ix of included) {
          const p = parentIx[ix] ?? -1;
          if (p !== -1 && included.has(p))
            lines.push(`  ${id(p)} --> ${id(ix)}`);
        }
        return `${lines.join("\n")}\n`;
      });
    });
  },
};
