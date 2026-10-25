import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanGlobs } from "../../src/glob.ts"

describe("scanGlobs", () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "glob-test-"))
    for (const f of [
      "src/a.ts",
      "src/nested/node_modules/x.ts",
      ".github/workflows/ci.yml",
      ".hidden.ts",
      "node_modules/dep/index.ts",
      ".git/hooks/pre-commit.ts",
      ".ostia/ab/0123456789ab/src/a.ts",
      ".ostia/baselines/main.ts",
    ]) {
      await Bun.write(join(dir, f), "")
    }
  })

  afterAll(async () => {
    await Bun.$`rm -rf ${dir}`
  })

  test("wildcards match dotfiles but skip node_modules, .git and ab's base trees", async () => {
    expect(await scanGlobs(["**/*.ts"], dir)).toEqual([
      ".hidden.ts",
      ".ostia/baselines/main.ts",
      "src/a.ts",
    ])
    expect(await scanGlobs([".ostia/**/*.ts"], dir)).toEqual([
      ".ostia/baselines/main.ts",
    ])
    expect(await scanGlobs([".ostia/ab/**/*.ts"], dir)).toEqual([
      ".ostia/ab/0123456789ab/src/a.ts",
    ])
    expect(await scanGlobs([".github/**"], dir)).toEqual([
      ".github/workflows/ci.yml",
    ])
  })

  test("a pattern that names node_modules or .git reaches into it", async () => {
    expect(await scanGlobs(["node_modules/**/*.ts"], dir)).toEqual([
      "node_modules/dep/index.ts",
    ])
    expect(await scanGlobs(["**/node_modules/**/*.ts"], dir)).toEqual([
      "node_modules/dep/index.ts",
      "src/nested/node_modules/x.ts",
    ])
  })

  test("an absolute pattern under node_modules isn't skipped for the prefix", async () => {
    expect(await scanGlobs([`${dir}/node_modules/dep/*.ts`], "/")).toEqual([
      `${dir}/node_modules/dep/index.ts`,
    ])
  })

  test("a wildcard-free path matches only an existing file, relative or absolute", async () => {
    expect(await scanGlobs(["src/a.ts", "src/missing.ts"], dir)).toEqual([
      "src/a.ts",
    ])
    expect(await scanGlobs([join(dir, "src/a.ts")], "/")).toEqual([
      join(dir, "src/a.ts"),
    ])
    expect(await scanGlobs(["src"], dir)).toEqual([])
  })

  test("extglobs are patterns, a bare ( is literal", async () => {
    expect(await scanGlobs(["@(src)/*.ts", "+(src)/*.ts"], dir)).toEqual([
      "src/a.ts",
    ])
    expect(await scanGlobs(["src/!(nested)"], dir)).toEqual(["src/a.ts"])
    await Bun.write(join(dir, "app/(marketing)/page.ts"), "")
    try {
      expect(await scanGlobs(["app/(marketing)/page.ts"], dir)).toEqual([
        "app/(marketing)/page.ts",
      ])
    } finally {
      await Bun.$`rm -rf ${join(dir, "app")}`
    }
  })

  test("results are deduped and sorted across patterns", async () => {
    expect(await scanGlobs(["src/*.ts", "**/*.ts", ".hidden.ts"], dir)).toEqual(
      [".hidden.ts", ".ostia/baselines/main.ts", "src/a.ts"],
    )
  })
})
