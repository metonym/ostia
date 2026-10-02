import type { ProfileDocument } from "../../ir/types.ts"
import {
  buildDenseTree,
  computeDenseNodeTimes,
  renderCpuFiles,
} from "../cpu-tree.ts"
import { formatUsAsMs, frameName } from "../format.ts"
import type { Renderer, RenderResult, VizOptions } from "../types.ts"

const DEFAULT_TOP_N = 15

export interface MermaidOptions extends VizOptions {
  topN?: number
}

function label(name: string, selfUs: number, totalUs: number): string {
  return `${name.replace(/"/g, "'")} (self ${formatUsAsMs(selfUs)}ms, total ${formatUsAsMs(totalUs)}ms)`
}

// Insertion into a sorted window: O(count * n) with n small.
function topNBySelf(
  selfUs: Float64Array,
  count: number,
  exclude: number,
  n: number,
): number[] {
  const top: number[] = []
  if (n <= 0) return top
  for (let i = 0; i < count; i++) {
    if (i === exclude) continue
    const v = selfUs[i]!
    if (top.length === n && v <= selfUs[top[n - 1]!]!) continue
    let j = top.length
    while (j > 0 && selfUs[top[j - 1]!]! < v) j--
    top.splice(j, 0, i)
    if (top.length > n) top.pop()
  }
  return top
}

export const mermaidRenderer: Renderer<MermaidOptions> = {
  name: "mermaid",
  async render(
    doc: ProfileDocument,
    options: MermaidOptions = {},
  ): Promise<RenderResult> {
    const topN = options.topN ?? DEFAULT_TOP_N

    return renderCpuFiles(doc, options, "mermaid.md", ({ cpu }) => {
      const { nodes, frames } = cpu
      const tree = buildDenseTree(cpu)
      const { selfUs, totalUs } = computeDenseNodeTimes(cpu, tree)
      const { parentIx } = tree
      const rootIx = tree.roots[0] ?? -1

      // The top-N self-time nodes plus every ancestor, so each has a path to the root.
      const included = new Set<number>(rootIx !== -1 ? [rootIx] : [])
      for (const ix of topNBySelf(selfUs, tree.count, rootIx, topN)) {
        const path: number[] = []
        for (let cur = ix; cur !== -1; cur = parentIx[cur]!) path.push(cur)
        for (let k = path.length - 1; k >= 0; k--) included.add(path[k]!)
      }

      const id = (ix: number) => `n${nodes[ix]!.id}`
      const lines = ["graph TD"]
      for (const ix of included) {
        const name = frameName(frames[nodes[ix]!.frameIx])
        lines.push(`  ${id(ix)}["${label(name, selfUs[ix]!, totalUs[ix]!)}"]`)
      }
      for (const ix of included) {
        const p = parentIx[ix]!
        if (p !== -1 && included.has(p)) lines.push(`  ${id(p)} --> ${id(ix)}`)
      }
      return `${lines.join("\n")}\n`
    })
  },
}
