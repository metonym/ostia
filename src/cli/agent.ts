import { processEnv } from "../config/env.ts";

// The variables a coding agent sets, as svelte-typecheck and svelte-lint
// read them, after `bun check`: `AGENT` and `CLAUDECODE`, `AI_AGENT`, the
// shared name, and Codex's `CODEX_CI` and `CODEX_THREAD_ID`. Kept the same
// so the three tools agree on what an agent is (metonym/ostia#53).
const AGENT_ENV = [
  "AGENT",
  "AI_AGENT",
  "CLAUDECODE",
  "CODEX_CI",
  "CODEX_THREAD_ID",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

// The first agent variable set to anything but empty or `0`, which a
// person sets to say "not an agent" without unsetting it.
export function agentVariable(env: Env = processEnv()): string | undefined {
  return AGENT_ENV.find((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0";
  });
}

function asksForFormat(argv: readonly string[]): boolean {
  return argv.some(
    (arg) =>
      arg === "--format" ||
      arg.startsWith("--format=") ||
      arg === "--json" ||
      arg.startsWith("--json="),
  );
}

// `argv` with the format to use when it names none: `OSTIA_FORMAT` when
// set, else `concise` for a coding agent, with a line saying so, so a
// person reading the agent's log knows why the table is missing.
export function withDefaultFormat(
  argv: readonly string[],
  env: Env = processEnv(),
): { argv: string[]; notice?: string } {
  if (asksForFormat(argv)) return { argv: [...argv] };
  const chosen = env.OSTIA_FORMAT;
  if (chosen !== undefined && chosen !== "") {
    return { argv: [...argv, "--format", chosen] };
  }
  const agent = agentVariable(env);
  if (agent === undefined) return { argv: [...argv] };
  return {
    argv: [...argv, "--format", "concise"],
    notice: `ostia: ${agent} is set, so --format concise; pass --format or set OSTIA_FORMAT for another.\n`,
  };
}
