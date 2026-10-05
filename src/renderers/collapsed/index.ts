import type { ProfileDocument } from "../../ir/types.ts"
import { buildDenseTree, renderCpuFiles } from "../cpu-tree.ts"
import { frameName } from "../format.ts"
import type { Renderer, RenderResult, VizOptions } from "../types.ts"

export const collapsedRenderer: Renderer<VizOptions> = {
  name: "collapsed",
  async render(
    doc: ProfileDocument,
    options: VizOptions = {},
  ): Promise<RenderResult> {
    return renderCpuFiles(doc, options, "collapsed.txt", ({ cpu }) => {
      const { nodes, frames } = cpu
      const tree = buildDenseTree(cpu)

      const pathOf: string[] = new Array(tree.count)
      for (const i of tree.order) {
        const name = frameName(frames[nodes[i]!.frameIx])
        const p = tree.parentIx[i]!
        pathOf[i] = p === -1 ? name : `${pathOf[p]};${name}`
      }

      // Typed counts plus a first-seen list: this runs over every sample.
      const counts = new Float64Array(tree.count)
      const seen: number[] = []
      for (const id of cpu.samples?.nodeIds ?? []) {
        const ix = tree.indexOf(id)
        if (ix === -1) continue
        if (counts[ix]!++ === 0) seen.push(ix)
      }
      const lines = seen.map((ix) => `${pathOf[ix]} ${counts[ix]}`)
      return lines.length > 0 ? `${lines.join("\n")}\n` : ""
    })
  },
}
