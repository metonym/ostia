import { describe, expect, test } from "bun:test"
import { createDocument } from "../../src/ir/document.ts"
import { TOOL_VERSION } from "../../src/version.ts"

describe("TOOL_VERSION", () => {
  test("matches package.json's version", async () => {
    const pkg = await Bun.file(`${import.meta.dir}/../../package.json`).json()
    expect(TOOL_VERSION).toBe(pkg.version)
  })

  test("createDocument stamps toolVersion with it", () => {
    expect(createDocument([], []).toolVersion).toBe(TOOL_VERSION)
  })
})
