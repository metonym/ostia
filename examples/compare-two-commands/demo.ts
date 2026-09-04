const cli = `${import.meta.dir}/../../src/cli/main.ts`

const proc = Bun.spawn(
  [
    cli,
    "run",
    "--runs",
    "10",
    "--warmup",
    "2",
    "bun fixtures/fast.ts",
    "bun fixtures/slow.ts",
  ],
  { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
)
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
])

process.stdout.write(stdout)

if (exitCode !== 0) {
  process.stderr.write(stderr)
  process.stderr.write(`error: ostia run exited ${exitCode}\n`)
  process.exit(1)
}
if (!stdout.includes("Relative")) {
  process.stderr.write(
    "error: expected a Relative column comparing the two commands\n",
  )
  process.exit(1)
}
if (!/\d+\.\d\d× slower/.test(stdout)) {
  process.stderr.write(
    "error: expected the slower fixture to be marked as such\n",
  )
  process.exit(1)
}
