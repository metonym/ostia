import type { ProfileDocument, Workload } from "../../ir/types.ts"
import { buildDenseTree, selectCpuRuns } from "../cpu-tree.ts"
import type { Renderer, RenderResult, VizOptions } from "../types.ts"

const SCHEMA_URL = "https://www.speedscope.app/file-format-schema.json"

function workloadLabel(w: Workload | undefined): string {
  return w?.label ?? w?.command?.join(" ") ?? w?.entry?.task ?? "profile"
}

export const speedscopeRenderer: Renderer<VizOptions> = {
  name: "speedscope",
  async render(
    doc: ProfileDocument,
    options: VizOptions = {},
  ): Promise<RenderResult> {
    const runs = selectCpuRuns(doc, options.runId)
    const byWorkload = new Map(doc.workloads.map((w) => [w.id, w]))

    const files = runs.map((run) => {
      const cpu = run.cpu!
      const { nodes } = cpu
      const tree = buildDenseTree(cpu)
      const nodeIds = cpu.samples?.nodeIds ?? []
      const weights = cpu.samples?.timeDeltasUs ?? []

      const stackOf: number[][] = new Array(tree.count)
      for (const i of tree.order) {
        const p = tree.parentIx[i]!
        const frameIx = nodes[i]!.frameIx
        stackOf[i] = p === -1 ? [frameIx] : [...stackOf[p]!, frameIx]
      }

      const samples: number[][] = new Array(nodeIds.length)
      for (let s = 0; s < nodeIds.length; s++) {
        const ix = tree.indexOf(nodeIds[s]!)
        samples[s] = ix === -1 ? [] : stackOf[ix]!
      }
      let endValue = 0
      for (let s = 0; s < weights.length; s++) endValue += weights[s]!

      const document = {
        $schema: SCHEMA_URL,
        exporter: "ostia",
        name: workloadLabel(byWorkload.get(run.workloadId)),
        activeProfileIndex: 0,
        shared: {
          frames: cpu.frames.map((f) => ({
            name: f.name || "(anonymous)",
            file: f.url,
            line: f.line !== undefined ? f.line + 1 : undefined,
          })),
        },
        profiles: [
          {
            type: "sampled",
            name: workloadLabel(byWorkload.get(run.workloadId)),
            unit: "microseconds",
            startValue: 0,
            endValue,
            samples,
            weights,
          },
        ],
      }

      return {
        path: `${run.id}.speedscope.json`,
        content: `${JSON.stringify(document, null, 2)}\n`,
      }
    })

    return { files }
  },
}
