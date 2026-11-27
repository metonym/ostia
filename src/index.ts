import type { OstiaConfigInput } from "./config/index.ts";

export type { AbOptions, AbProgress } from "./ab/index.ts";
export { ab, AbBaseError, AbSetupError, AbSuiteError } from "./ab/index.ts";
export type { BenchOptions, BenchProgress } from "./bench/index.ts";
export { bench } from "./bench/index.ts";
export { range } from "./bench/range.ts";
export type { GroupOptions, TaskOptions } from "./bench/registry.ts";
export type { GroupFn, Hook, TaskFn } from "./bench/registry.ts";
export { group, task } from "./bench/registry.ts";
export type { MeasureTasksOpts } from "./bench/run-tasks.ts";
export type { RunOptions } from "./bench/run.ts";
export { run } from "./bench/run.ts";
export type { SweepPoint } from "./bench/sweep.ts";
export { sweep } from "./bench/sweep.ts";
export type { CompareResult, Thresholds } from "./compare/index.ts";
export { compareDocuments, DEFAULT_THRESHOLDS } from "./compare/index.ts";
export type {
  AbConfig,
  BenchConfig,
  BenchProject,
  OstiaConfig,
  OstiaConfigInput,
  WorkloadConfig,
} from "./config/index.ts";
export { OstiaUsageError } from "./errors.ts";
export {
  createDocument,
  loadDocument,
  OstiaDocumentError,
  saveDocument,
} from "./ir/document.ts";
export type {
  AbSummary,
  ComparedTask,
  Comparison,
  ComparisonSummary,
  Environment,
  GitMetadata,
  Measurement,
  PairedEvidence,
  ProfileDocument,
  Warning,
  WarningCode,
  Workload,
} from "./ir/types.ts";
export { WARNING_CODES } from "./ir/types.ts";
export { keep } from "./measure/inprocess.ts";
export type { Side } from "./measure/paired.ts";
export type { ProfileOptions, ProfileResult } from "./profile.ts";
export { profile } from "./profile.ts";
export { renderers } from "./renderers/index.ts";
export type { MermaidOptions } from "./renderers/mermaid.ts";
export type {
  MinimalEvent,
  MinimalProtocolContext,
  MinimalRenderOptions,
  MinimalRunLine,
  MinimalSummaryLine,
  MinimalUnmatchedLine,
} from "./renderers/minimal.ts";
export { MINIMAL_PROTOCOL_VERSION } from "./renderers/minimal.ts";
export type { TableOptions } from "./renderers/terminal.ts";
export type { FormatName, Renderer, VizOptions } from "./renderers/types.ts";
export type {
  PrepareFn,
  PrepareHook,
  PrepareRun,
  TimeSource,
  TimeUnit,
} from "./spawn/index.ts";
export type { CommandSpec, TimeOptions, TimeProgress } from "./time.ts";
export { time } from "./time.ts";

/** Identity function that types an `ostia.config.ts` default export. */
export function defineConfig(config: OstiaConfigInput): OstiaConfigInput {
  return config;
}
