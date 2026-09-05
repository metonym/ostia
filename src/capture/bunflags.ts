/** Injects profiler flags into a `bun` invocation. When argv[0] is the bun
 * binary the flags go inline ahead of the script; otherwise they ride along
 * in BUN_OPTIONS so a wrapper script that eventually execs bun still picks
 * them up. Returns argv/env for `Bun.spawn`. */
export function withBunFlags(
  argv: string[],
  flags: string[],
  env: Record<string, string> | undefined,
): { argv: string[]; env: Record<string, string> | undefined } {
  const bin = argv[0]
  if (bin === "bun" || bin?.endsWith("/bun")) {
    return { argv: [bin, ...flags, ...argv.slice(1)], env }
  }
  return {
    argv,
    env: { ...process.env, ...env, BUN_OPTIONS: flags.join(" ") },
  }
}
