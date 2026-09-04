const cli = `${import.meta.dir}/../../src/cli/main.ts`
const cwd = import.meta.dir
const fixturePath = `${cwd}/fixtures/work.ts`
const originalFixture = await Bun.file(fixturePath).text()
const slowFixture = originalFixture.replace("1_000_000", "40_000_000")

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
  return { stdout: stdout + stderr, exitCode }
}

async function cleanup(): Promise<void> {
  await Bun.write(fixturePath, originalFixture)
  await Bun.spawn(["rm", "-rf", `${cwd}/.ostia`]).exited
}

try {
  await Bun.spawn(["rm", "-rf", `${cwd}/.ostia`]).exited

  const baseline = await run([
    "run",
    "--runs",
    "8",
    "--warmup",
    "2",
    "--export-json",
    ".ostia/baselines/main.json",
    "--quiet",
    "bun fixtures/work.ts",
  ])
  if (baseline.exitCode !== 0) {
    process.stderr.write(baseline.stdout)
    process.stderr.write("error: failed to write the baseline\n")
    process.exit(1)
  }

  process.stdout.write("--- ostia ci (unchanged code, should pass) ---\n")
  const clean = await run(["ci"])
  process.stdout.write(clean.stdout)
  if (clean.exitCode !== 0) {
    process.stderr.write(
      `error: expected ostia ci to pass on unchanged code, got exit ${clean.exitCode}\n`,
    )
    process.exit(1)
  }

  await Bun.write(fixturePath, slowFixture)

  process.stdout.write("\n--- ostia ci (fixture slowed 40x, should fail) ---\n")
  const regressed = await run(["ci"])
  process.stdout.write(regressed.stdout)
  if (regressed.exitCode !== 1) {
    process.stderr.write(
      `error: expected ostia ci to gate the regression with exit 1, got exit ${regressed.exitCode}\n`,
    )
    process.exit(1)
  }

  process.stdout.write(
    "\ngate worked: passed on unchanged code, failed on a real regression.\n",
  )
} finally {
  await cleanup()
}
