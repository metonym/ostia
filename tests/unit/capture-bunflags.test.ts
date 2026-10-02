import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { withBunFlags } from "../../src/capture/bunflags.ts"
import { runCpuCapture } from "../../src/capture/cpu/index.ts"

const FIXTURE = `${import.meta.dir}/../fixtures/work.ts`
const FLAGS = ["--cpu-prof", "--cpu-prof-dir", "/tmp/a b"]

describe("capture/bunflags - withBunFlags", () => {
  test("inserts flags after a bun argv[0], including bun.exe", () => {
    for (const bin of ["bun", "/usr/local/bin/bun", "C:\\bin\\bun.exe"]) {
      expect(withBunFlags([bin, "x.ts"], ["--f"], undefined).argv).toEqual([
        bin,
        "--f",
        "x.ts",
      ])
    }
  })

  test("a non-bun argv[0] gets BUN_OPTIONS with spaces escaped", () => {
    const { argv, env } = withBunFlags(["sh", "run.sh"], FLAGS, {})
    expect(argv).toEqual(["sh", "run.sh"])
    expect(env?.BUN_OPTIONS?.endsWith("--cpu-prof-dir /tmp/a\\ b")).toBe(true)
  })

  test("keeps an existing BUN_OPTIONS ahead of ours", () => {
    const { env } = withBunFlags(["sh"], ["--cpu-prof"], {
      BUN_OPTIONS: "--smol",
    })
    expect(env?.BUN_OPTIONS).toBe("--smol --cpu-prof")
  })
})

describe("capture/bunflags - BUN_OPTIONS fallback, real capture", () => {
  const root = mkdtempSync(`${tmpdir()}/ostia bunflags `)
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("writes the artifact into a dir with spaces, keeping caller BUN_OPTIONS", async () => {
    const artifactDir = `${root}/out dir`
    await Bun.$`mkdir -p ${artifactDir}`
    const result = await runCpuCapture({
      // Not a bun argv[0], so flags travel via BUN_OPTIONS.
      argv: ["sh", "-c", `exec bun "$0"`, FIXTURE],
      env: { BUN_OPTIONS: "--smol" },
      artifactDir,
      fileName: "p.cpuprofile",
      intervalUs: 1000,
    })
    expect(result.warnings.map((w) => w.code)).not.toContain("artifact-missing")
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(`${artifactDir}/p.cpuprofile`).exists()).toBe(true)
  }, 20_000)
})
