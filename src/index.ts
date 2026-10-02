import type { OstiaConfigInput } from "./config/index.ts"

export type { AbOptions, AbProgress } from "./ab/index.ts"
export { AbBaseError, AbSetupError, ab } from "./ab/index.ts"
export type { BenchOptions } from "./bench/index.ts"
export { bench } from "./bench/index.ts"
export { range } from "./bench/range.ts"
export type { GroupOptions, TaskOptions } from "./bench/registry.ts"
export { group, task } from "./bench/registry.ts"
export type { RunOptions } from "./bench/run.ts"
export { run } from "./bench/run.ts"
export { sweep } from "./bench/sweep.ts"
export type { CompareResult, Thresholds } from "./compare/index.ts"
export { compareDocuments, DEFAULT_THRESHOLDS } from "./compare/index.ts"
export type {
  AbConfig,
  OstiaConfig,
  OstiaConfigInput,
  WorkloadConfig,
} from "./config/index.ts"
export {
  createDocument,
  loadDocument,
  OstiaDocumentError,
  saveDocument,
} from "./ir/document.ts"
export type {
  Comparison,
  ProfileDocument,
  Warning,
  WarningCode,
  Workload,
} from "./ir/types.ts"
export { keep } from "./measure/inprocess.ts"
export type { ProfileOptions, ProfileResult } from "./profile.ts"
export { profile } from "./profile.ts"
export { renderers } from "./renderers/index.ts"
export type { MermaidOptions } from "./renderers/mermaid/index.ts"
// `MinimalEvent` is one parsed line of `--format minimal` output; narrow on `event`.
export type {
  MinimalEvent,
  MinimalProtocolContext,
  MinimalRenderOptions,
} from "./renderers/minimal/index.ts"
export { MINIMAL_PROTOCOL_VERSION } from "./renderers/minimal/index.ts"
export type { VizOptions } from "./renderers/types.ts"
export type {
  PrepareFn,
  PrepareHook,
  PrepareRun,
  TimeSource,
  TimeUnit,
} from "./spawn/index.ts"
export type { CommandSpec, TimeOptions } from "./time.ts"
export { time } from "./time.ts"

/** Identity function that types an `ostia.config.ts` default export. */
export function defineConfig(config: OstiaConfigInput): OstiaConfigInput {
  return config
}
