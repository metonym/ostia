import { task } from "../../src/index.ts"

const doc = (globalThis as Record<string, unknown>).document as
  | { title: string }
  | undefined
if (!doc) {
  throw new Error("document is not defined - run with --preload")
}

task("reads-document-title", () => doc.title.length)
