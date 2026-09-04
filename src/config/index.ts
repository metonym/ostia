import { DEFAULT_THRESHOLDS, type Thresholds } from "../compare/index.ts"

interface WorkloadConfig {
  label?: string
  command: string[]
  inputs?: string[]
}

export interface OstiaConfig {
  runs: number | null
  warmup: number
  outDir: string
  baseline: string
  cpuIntervalUs: number
  thresholds: Thresholds
  workloads: WorkloadConfig[]
}

export const DEFAULT_CONFIG: OstiaConfig = {
  runs: null,
  warmup: 3,
  outDir: ".ostia",
  baseline: "main",
  cpuIntervalUs: 1000,
  thresholds: DEFAULT_THRESHOLDS,
  workloads: [],
}

export async function loadConfig(
  path = "ostia.config.json",
): Promise<OstiaConfig | undefined> {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  const raw = (await file.json()) as Partial<OstiaConfig>
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
  }
}

export function baselinePath(config: OstiaConfig, name?: string): string {
  return `${config.outDir}/baselines/${name ?? config.baseline}.json`
}
