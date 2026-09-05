const cli = `${import.meta.dir}/../../src/cli/main.ts`
const cwd = import.meta.dir
const docPath = ".ostia/doc.json"

async function run(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn([cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    process.stderr.write(stderr)
    process.stderr.write(`error: ostia ${args[0]} exited ${exitCode}\n`)
    process.exit(1)
  }
  return { stdout, exitCode }
}

const capture = await run([
  "time",
  "--runs",
  "5",
  "--cpu",
  "--cpu-interval",
  "200",
  "--export-json",
  docPath,
  "bun fixtures/work.ts",
])
process.stdout.write(capture.stdout)

const collapsed = await run(["report", docPath, "--format", "collapsed"])
if (!collapsed.stdout.includes("hashLoop")) {
  process.stderr.write(
    "error: expected hashLoop to appear in the collapsed stack output\n",
  )
  process.exit(1)
}
process.stdout.write(
  `\ncollapsed stacks (first line):\n${collapsed.stdout.split("\n")[0]}\n`,
)

const mermaid = await run(["report", docPath, "--format", "mermaid"])
if (!mermaid.stdout.includes("hashLoop")) {
  process.stderr.write(
    "error: expected hashLoop to appear in the mermaid call tree\n",
  )
  process.exit(1)
}
process.stdout.write(`\nmermaid call tree:\n${mermaid.stdout}`)
