import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bundleDts } from "../../scripts/bundle-dts.ts"

async function bundle(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bundle-dts-"))
  await mkdir(join(root, "src"))
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(root, "src", name), text)
  }
  const outFile = join(root, "index.d.ts")
  await bundleDts({ root, source: join(root, "src/index.ts"), outFile })
  return readFile(outFile, "utf8")
}

describe("bundleDts", () => {
  test("resolves a reference to its own module's private type", async () => {
    const out = await bundle({
      "a.ts": "type Fn = () => void\nexport function run(fn: Fn): void {}\n",
      "b.ts":
        "interface Fn { (name: string): void }\nexport const task: Fn = () => {}\n",
      "index.ts":
        'export { keep } from "./c.ts"\nexport { task } from "./b.ts"\n',
      "c.ts": 'import "./a.ts"\nexport function keep(): void {}\n',
    })
    expect(out).toContain("interface Fn {")
    expect(out).not.toContain("type Fn =")
  })

  test("fails when two modules' kept declarations share a name", async () => {
    await expect(
      bundle({
        "a.ts": "type Fn = () => void\nexport function run(fn: Fn): void {}\n",
        "b.ts":
          "interface Fn { (name: string): void }\nexport const task: Fn = () => {}\n",
        "index.ts":
          'export { run } from "./a.ts"\nexport { task } from "./b.ts"\n',
      }),
    ).rejects.toThrow(/Fn: /)
  })
})
