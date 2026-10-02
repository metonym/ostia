import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { bundleDts } from "./bundle-dts.ts"

const root = join(import.meta.dir, "..")
const out = join(root, "package")

const STRIP = new Set(["devDependencies", "scripts"])

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const pkg = await Bun.file(join(root, "package.json")).json()

const result = await Bun.build({
  entrypoints: [
    join(root, "src/cli/main.ts"),
    join(root, "src/index.ts"),
    join(root, "src/bench/runner.ts"),
    join(root, "src/ab/ab-runner.ts"),
  ],
  outdir: out,
  target: "bun",
  minify: true,
  splitting: true,
  naming: "[name].js",
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// The runners are spawned by path (`new URL("./runner.ts", import.meta.url)`),
// so they keep their source names.
for (const [from, to] of [
  ["main.js", "cli.js"],
  ["runner.js", "runner.ts"],
  ["ab-runner.js", "ab-runner.ts"],
]) {
  if (!existsSync(join(out, from!))) {
    console.error(`build: missing ${from}`)
    process.exit(1)
  }
  renameSync(join(out, from!), join(out, to!))
}

await bundleDts({
  root,
  source: join(root, "src/index.ts"),
  outFile: join(out, "index.d.ts"),
})

for (const extra of ["README.md", "LICENSE"]) {
  const path = join(root, extra)
  if (existsSync(path)) {
    cpSync(path, join(out, extra))
  }
}

for (const key of STRIP) {
  delete pkg[key]
}

pkg.bin = { ostia: "cli.js" }
pkg.main = "./index.js"
pkg.module = "./index.js"
pkg.types = "./index.d.ts"
pkg.exports = { ".": { types: "./index.d.ts", default: "./index.js" } }

writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
