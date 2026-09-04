import type { ProfileDocument } from "../../ir/types.ts"
import {
  buildDenseTree,
  computeDenseNodeTimes,
  selectCpuRuns,
} from "../cpu-tree.ts"
import type { Renderer, RenderResult, VizOptions } from "../types.ts"

const DEFAULT_TOP_N = 15

export interface MermaidOptions extends VizOptions {
  topN?: number
}

function sanitizeId(nodeId: number): string {
  return `n${nodeId}`
}

function label(name: string, selfUs: number, totalUs: number): string {
  const safeName = (name || "(anonymous)").replace(/"/g, "'")
  return `${safeName} (self ${(selfUs / 1000).toFixed(2)}ms, total ${(totalUs / 1000).toFixed(2)}ms)`
}

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
    const runs = selectCpuRuns(doc, options.runId)

    const files = runs.map((run) => {
      const cpu = run.cpu!
      const { nodes, frames } = cpu
      const tree = buildDenseTree(cpu)
      const { selfUs, totalUs } = computeDenseNodeTimes(cpu, tree)
      const { parentIx } = tree
      const rootIx = tree.roots[0] ?? -1

      const ranked = topNBySelf(selfUs, tree.count, rootIx, topN)

      const included = new Set<number>(rootIx !== -1 ? [rootIx] : [])
      const path: number[] = []
      for (const ix of ranked) {
        path.length = 0
        for (let cur = ix; cur !== -1; cur = parentIx[cur]!) path.push(cur)
        for (let k = path.length - 1; k >= 0; k--) included.add(path[k]!)
      }

      const lines = ["graph TD"]
      for (const ix of included) {
        const id = nodes[ix]!.id
        lines.push(
          `  ${sanitizeId(id)}["${label(frames[nodes[ix]!.frameIx]!.name, selfUs[ix]!, totalUs[ix]!)}"]`,
        )
      }
      for (const ix of included) {
        const p = parentIx[ix]!
        if (p !== -1 && included.has(p)) {
          lines.push(
            `  ${sanitizeId(nodes[p]!.id)} --> ${sanitizeId(nodes[ix]!.id)}`,
          )
        }
      }

      return { path: `${run.id}.mermaid.md`, content: `${lines.join("\n")}\n` }
    })

    return { files }
  },
}
