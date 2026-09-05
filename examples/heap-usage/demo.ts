const cli = `${import.meta.dir}/../../src/cli/main.ts`

const proc = Bun.spawn([cli, "time", "--heap", "bun fixtures/allocate.ts"], {
  cwd: import.meta.dir,
  stdout: "pipe",
  stderr: "pipe",
})
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
])

process.stdout.write(stdout)

if (exitCode !== 0) {
  process.stderr.write(stderr)
  process.stderr.write(`error: ostia time exited ${exitCode}\n`)
  process.exit(1)
}
if (!stdout.includes("Heap snapshot")) {
  process.stderr.write("error: expected a heap snapshot summary\n")
  process.exit(1)
}
if (!/\bstring\b/.test(stdout)) {
  process.stderr.write(
    "error: expected `string` to show up in the type breakdown - the fixture allocates 200k of them\n",
  )
  process.exit(1)
}
