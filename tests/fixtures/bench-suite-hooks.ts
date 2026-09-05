import { group, task } from "../../src/index.ts"

const markerPath = `${import.meta.dir}/../../.ostia-test-bench-hooks-marker.json`

async function log(entry: string): Promise<void> {
  const file = Bun.file(markerPath)
  const existing = (await file.exists())
    ? ((await file.json()) as string[])
    : []
  existing.push(entry)
  await Bun.write(markerPath, JSON.stringify(existing))
}

group(
  "g",
  () => {
    task("a", () => 1, {
      before: () => log("task-a-before"),
      after: () => log("task-a-after"),
    })
    task("b", () => 1, {
      before: () => log("task-b-before"),
      after: () => log("task-b-after"),
    })
  },
  {
    before: () => log("group-before"),
    after: () => log("group-after"),
  },
)
