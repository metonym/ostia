import type { ProfileDocument } from "../../ir/types.ts"
import { selectCpuRuns } from "../cpu-tree.ts"
import type { Renderer, RenderResult, VizOptions } from "../types.ts"

export const cpuprofileRenderer: Renderer<VizOptions> = {
  name: "cpuprofile",
  async render(
    doc: ProfileDocument,
    options: VizOptions = {},
  ): Promise<RenderResult> {
    const runs = selectCpuRuns(doc, options.measurementId)
    const files: { path?: string; content: string }[] = []
    const skipped: string[] = []

    for (const run of runs) {
      if (run.cpu?.origin !== "cpu-prof" && run.cpu?.origin !== "inspector") {
        skipped.push(
          `${run.id} (origin ${run.cpu?.origin ?? "unknown"} has no .cpuprofile artifact to pass through)`,
        )
        continue
      }
      const artifact = run.artifacts.find((a) => a.kind === "cpuprofile")
      if (!artifact) {
        skipped.push(`${run.id} (no cpuprofile artifact recorded on this run)`)
        continue
      }
      const file = Bun.file(artifact.path)
      if (!(await file.exists())) {
        skipped.push(`${run.id} (artifact missing on disk: ${artifact.path})`)
        continue
      }
      files.push({ path: `${run.id}.cpuprofile`, content: await file.text() })
    }

    if (files.length === 0 && skipped.length > 0) {
      return {
        text: `No .cpuprofile artifacts available:\n${skipped.map((s) => `  - ${s}`).join("\n")}\n`,
      }
    }

    return { files }
  },
}
