import { task } from "../../src/index.ts"

if ((globalThis as Record<string, unknown>).document !== undefined) {
  throw new Error("document is defined - a preload leaked into this suite")
}

task("runs-without-document", () => 1 + 1)
