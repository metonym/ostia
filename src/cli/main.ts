#!/usr/bin/env bun
export {};

// Help and the version are answered before loading the commands, so they
// stay fast.
const first = process.argv[2];
if (first === "--version" || first === "-v") {
  const { TOOL_VERSION } = await import("../version.ts");
  await Bun.write(Bun.stdout, `${TOOL_VERSION}\n`);
  process.exit(0);
}
if (first === undefined || first === "--help" || first === "-h") {
  const { showHelp } = await import("./help.ts");
  process.exit(await showHelp("main", first !== undefined));
}
const { main } = await import("./run.ts");
process.exit(await main());
