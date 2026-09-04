export interface TrialResult {
  wallNs: number
  exitCode: number
  userNs?: number
  systemNs?: number
  maxRssBytes?: number
}

export interface SpawnTrialOptions {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
}

export async function runTrial(opts: SpawnTrialOptions): Promise<TrialResult> {
  const start = Bun.nanoseconds()
  const proc = Bun.spawn(opts.argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
  const exitCode = await proc.exited
  const end = Bun.nanoseconds()
  const usage = proc.resourceUsage?.()

  return {
    wallNs: end - start,
    exitCode,
    userNs: usage ? Number(usage.cpuTime.user) * 1000 : undefined,
    systemNs: usage ? Number(usage.cpuTime.system) * 1000 : undefined,
    maxRssBytes: usage?.maxRSS,
  }
}

export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}
