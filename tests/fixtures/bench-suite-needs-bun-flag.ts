import { task } from "../../src/index.ts"

if (process.env.OSTIA_BUN_FLAG_TEST !== "1") {
  throw new Error("OSTIA_BUN_FLAG_TEST is not set - run with --bun-flags")
}

task("reads-bun-flag", () => process.env.OSTIA_BUN_FLAG_TEST?.length)
