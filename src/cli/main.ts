#!/usr/bin/env bun
export {}

// Help is answered before loading the commands, so `--help` stays fast.
const first = process.argv[2]
if (first === undefined || first === "--help" || first === "-h") {
  const { MAIN_HELP } = await import("./help.ts")
  await Bun.write(Bun.stdout, MAIN_HELP)
  process.exit(first === undefined ? 2 : 0)
}
const { main } = await import("./run.ts")
process.exit(await main())
