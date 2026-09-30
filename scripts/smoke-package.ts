// Runs the CLI paths that spawn subprocesses or workers (`ab`, `bench
// --peak-mem`, `bench --cpu`) from the packed package, installed into a
// scratch git repo. Those paths resolve files at runtime, so a build that
// drops or misnames one only fails here, never from src/. Run after
// `bun run build`.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const pkgDir = join(import.meta.dir, "..", "package")
if (!existsSync(join(pkgDir, "package.json"))) {
  console.error("smoke-package: no package/ - run `bun run build` first")
  process.exit(2)
}

const SUITE = `import { group, task } from "ostia"

group("smoke", () => {
  task("sum", () => {
    let acc = 0
    for (let i = 0; i < 20_000; i++) acc += i
    return acc
  })
  task("alloc", () => Array.from({ length: 10_000 }, (_, i) => ({ i })).length)
})
`

const repo = mkdtempSync(join(tmpdir(), "ostia-smoke-"))

async function run(
  cmd: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: repo, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

async function sh(cmd: string[]): Promise<string> {
  const { code, stdout, stderr } = await run(cmd)
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}\n${stderr}`)
  return stdout
}

let failed = 0
async function check(
  name: string,
  cmd: string[],
  ok: (stdout: string) => string | undefined,
): Promise<void> {
  const { code, stdout, stderr } = await run(cmd)
  const problem = code !== 0 ? `exit ${code}` : ok(stdout)
  if (problem === undefined) {
    console.log(`✓ ${name}`)
    return
  }
  failed++
  console.error(
    `✗ ${name}: ${problem}\n$ ${cmd.join(" ")}\n${stdout}\n${stderr}`,
  )
}

try {
  const tarball = (
    await sh([
      "bun",
      "pm",
      "pack",
      "--cwd",
      pkgDir,
      "--destination",
      repo,
      "--quiet",
    ])
  ).trim()
  await Bun.write(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "ostia-smoke", private: true, type: "module" })}\n`,
  )
  await Bun.write(join(repo, "bench/s.bench.ts"), SUITE)
  await Bun.write(join(repo, ".gitignore"), "node_modules\n*.tgz\n*.json\n")
  await sh(["bun", "add", "-d", join(repo, tarball.split("/").pop()!)])
  await sh(["git", "init", "-q"])
  await sh(["git", "add", "-A"])
  await sh([
    "git",
    "-c",
    "user.name=ostia",
    "-c",
    "user.email=ostia@example.com",
    "commit",
    "-qm",
    "base",
  ])

  const ostia = ["bun", "node_modules/.bin/ostia"]

  // Thresholds out of reach: this checks that both sides pair and run, not
  // the verdict, which 5 rounds of a scratch suite can't settle.
  await check(
    "ab",
    [
      ...ostia,
      "ab",
      "bench/s.bench.ts",
      "--rounds",
      "5",
      "--confirm",
      "0",
      "--threshold",
      "1000",
      "--geomean-threshold",
      "1000",
      "--no-noise-check",
    ],
    (out) =>
      /Geomean .* of 2 · pass/.test(out)
        ? undefined
        : "no passing Geomean line",
  )

  await check(
    "bench --peak-mem",
    [
      ...ostia,
      "bench",
      "bench/s.bench.ts",
      "--peak-mem",
      "--budget",
      "50",
      "--no-noise-check",
    ],
    (out) => (/Peak mem/.test(out) ? undefined : "no Peak mem column"),
  )

  await check(
    "bench --cpu",
    [
      ...ostia,
      "bench",
      "bench/s.bench.ts",
      "--cpu",
      "--budget",
      "50",
      "--no-noise-check",
      "--export-json",
      "cpu.json",
      "--quiet",
    ],
    () => {
      const doc = JSON.parse(readFileSync(join(repo, "cpu.json"), "utf8"))
      const samples = doc.measurements
        .filter((m: { phase: string }) => m.phase === "cpu")
        .flatMap(
          (m: { cpu?: { totals: { samples: number }[] } }) =>
            m.cpu?.totals ?? [],
        )
        .reduce((n: number, t: { samples: number }) => n + t.samples, 0)
      return samples > 0 ? undefined : "no CPU samples"
    },
  )
} finally {
  rmSync(repo, { recursive: true, force: true })
}

process.exit(failed > 0 ? 1 : 0)
