import { describe, expect, test } from "bun:test"
import { WARNING_CODES } from "../../src/ir/types.ts"

describe("WarningCode - no member can go dead silently", () => {
  test("every WARNING_CODES entry is emitted somewhere in src/", async () => {
    const glob = new Bun.Glob("**/*.ts")
    const srcDir = `${import.meta.dir}/../../src`
    let combined = ""
    for await (const file of glob.scan({ cwd: srcDir, absolute: true })) {
      combined += await Bun.file(file).text()
    }
    for (const code of WARNING_CODES) {
      expect(combined).toContain(`code: "${code}"`)
    }
  })
})
