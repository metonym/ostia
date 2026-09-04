const examplesDir = `${import.meta.dir}/../examples`
const glob = new Bun.Glob("*/package.json")
const dirs: string[] = []
for await (const path of glob.scan({ cwd: examplesDir })) {
  dirs.push(path.split("/")[0]!)
}
dirs.sort()

if (dirs.length === 0) {
  console.error("no examples found")
  process.exit(2)
}

let failed = 0
for (const dir of dirs) {
  const cwd = `${examplesDir}/${dir}`
  console.log(`\n=== ${dir} ===`)

  const demo = Bun.spawn(["bun", "run", "demo"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await demo.exited) !== 0) {
    console.error(`✗ ${dir}: bun run demo failed`)
    failed++
    continue
  }

  console.log(`✓ ${dir}`)
}

console.log(`\n${dirs.length - failed}/${dirs.length} examples passed`)
process.exit(failed > 0 ? 1 : 0)
