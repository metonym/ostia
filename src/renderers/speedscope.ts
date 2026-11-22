import type { ProfileDocument } from "../ir/types.ts";
import { buildDenseTree, renderCpuFiles } from "./cpu-tree.ts";
import { frameName } from "./format.ts";
import { workloadsById } from "./select.ts";
import type { Renderer, RenderResult, VizOptions } from "./types.ts";

const SCHEMA_URL = "https://www.speedscope.app/file-format-schema.json";

export const speedscopeRenderer: Renderer<VizOptions> = {
  name: "speedscope",
  render(
    doc: ProfileDocument,
    options: VizOptions = {},
  ): Promise<RenderResult> {
    return Promise.try(() => {
      const byWorkload = workloadsById(doc);

      return renderCpuFiles(doc, options, "speedscope.json", (run) => {
        const { cpu } = run;
        const { nodes } = cpu;
        const tree = buildDenseTree(cpu);
        const nodeIds = cpu.samples?.nodeIds ?? [];
        const weights = cpu.samples?.timeDeltasUs ?? [];

        const stackOf = new Array<number[]>(tree.count);
        for (const i of tree.order) {
          const node = nodes[i];
          if (node === undefined) continue;
          const p = tree.parentIx[i] ?? -1;
          stackOf[i] =
            p === -1 ? [node.frameIx] : [...(stackOf[p] ?? []), node.frameIx];
        }

        const samples = nodeIds.map((id) => {
          const ix = tree.indexOf(id);
          return (ix === -1 ? undefined : stackOf[ix]) ?? [];
        });
        const workload = byWorkload.get(run.workloadId);
        const name =
          workload?.label ??
          workload?.command?.join(" ") ??
          workload?.entry?.task ??
          "profile";

        const document = {
          $schema: SCHEMA_URL,
          exporter: "ostia",
          name,
          activeProfileIndex: 0,
          shared: {
            frames: cpu.frames.map((f) => ({
              name: frameName(f),
              file: f.url,
              line: f.line !== undefined ? f.line + 1 : undefined,
            })),
          },
          profiles: [
            {
              type: "sampled",
              name,
              unit: "microseconds",
              startValue: 0,
              endValue: weights.reduce((sum, w) => sum + w, 0),
              samples,
              weights,
            },
          ],
        };
        return `${JSON.stringify(document, null, 2)}\n`;
      });
    });
  },
};
