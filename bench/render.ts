import { group, task } from "../src/index.ts"
import { renderers } from "../src/renderers/index.ts"
import {
  cpuEvidenceFromTree,
  LARGE_TREE,
  syntheticDocument,
} from "./lib/fixtures.ts"

group("render", () => {
  const doc = syntheticDocument(1_000)
  task("json render", () => renderers.json.render(doc, {}))
  task("jsonl render", () => renderers.jsonl.render(doc, {}))
  task("markdown render", () => renderers.markdown.render(doc, {}))
  task("table render", () => renderers.table.render(doc, {}))
})

group("viz", () => {
  const doc = syntheticDocument(1_000, cpuEvidenceFromTree(LARGE_TREE, 10_000))
  task("collapsed render (1e4 samples)", () =>
    renderers.collapsed.render(doc, {}),
  )
  task("mermaid render (1e4 samples, top-15)", () =>
    renderers.mermaid.render(doc, {}),
  )
  task("speedscope render (1e4 samples)", () =>
    renderers.speedscope.render(doc, {}),
  )
})

group("cpuprofile passthrough", () => {
  const cpu = cpuEvidenceFromTree(LARGE_TREE, 10_000)
  const artifactPath = "tests/fixtures/capture/sample.cpuprofile.json"
  const doc = syntheticDocument(1, cpu)
  const cpuRun = doc.runs.find((r) => r.phase === "cpu")!
  cpuRun.artifacts = [
    {
      id: "art_bench",
      kind: "cpuprofile",
      path: artifactPath,
      sha256: "",
      bytes: 0,
    },
  ]
  task("cpuprofile render (real fixture, pass-through read)", () =>
    renderers.cpuprofile.render(doc, {}),
  )
})
