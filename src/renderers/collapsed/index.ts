import type { ProfileDocument } from "../../ir/types.ts"
import { buildDenseTree, selectCpuRuns } from "../cpu-tree.ts"
import type { Renderer, RenderResult, VizOptions } from "../types.ts"

export const collapsedRenderer: Renderer<VizOptions> = {
  name: "collapsed",
  async render(
    doc: ProfileDocument,
    options: VizOptions = {},
  ): Promise<RenderResult> {
    const runs = selectCpuRuns(doc, options.runId)
    const files = runs.map((run) => {
      const cpu = run.cpu!
      const { nodes, frames } = cpu
      const tree = buildDenseTree(cpu)

      const pathOf: string[] = new Array(tree.count)
      for (const i of tree.order) {
        const name = frames[nodes[i]!.frameIx]!.name || "(anonymous)"
        const p = tree.parentIx[i]!
        pathOf[i] = p === -1 ? name : `${pathOf[p]};${name}`
      }

      const counts = new Float64Array(tree.count)
      const seen: number[] = []
      const nodeIds = cpu.samples?.nodeIds ?? []
      for (let s = 0; s < nodeIds.length; s++) {
        const ix = tree.indexOf(nodeIds[s]!)
        if (ix === -1) continue
        if (counts[ix]!++ === 0) seen.push(ix)
      }

      const lines: string[] = new Array(seen.length)
      for (let k = 0; k < seen.length; k++) {
        const ix = seen[k]!
        lines[k] = `${pathOf[ix]} ${counts[ix]}`
      }

      return {
        path: `${run.id}.collapsed.txt`,
        content: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
      }
    })

    return { files }
  },
}
