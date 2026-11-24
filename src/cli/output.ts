import { errorMessage, OstiaUsageError } from "../errors.ts";
import {
  saveDocument,
  saveDocumentText,
  serializeDocument,
} from "../ir/document.ts";
import type { ProfileDocument } from "../ir/types.ts";
import type { FormatName, RenderResult } from "../renderers/index.ts";
import { renderers } from "../renderers/index.ts";
import {
  MINIMAL_PROTOCOL_VERSION,
  type MinimalRenderOptions,
} from "../renderers/minimal.ts";

// Bun.write, because it skips the Node stream setup process.stdout and
// process.stderr cost at startup.
export const out = (text: string): Promise<number> =>
  Bun.write(Bun.stdout, text);
const errOut = (text: string) => Bun.write(Bun.stderr, text);

/**
 * One per distinct exit-2 cause, as the `code` of the machine-readable
 * `error` event.
 */
export type CliErrorCode =
  | "invalid-flag"
  | "config-missing"
  | "config-invalid"
  | "baseline-missing"
  | "no-matches"
  | "spawn-failed"
  | "suite-failed"
  | "command-failed"
  | "timeout"
  | "time-source-no-match"
  | "document-load-failed"
  | "no-cpu-evidence"
  | "internal";

/** Thrown to abort a command with exit 2; the dispatcher reports it. */
export class CliError extends Error {
  readonly code: CliErrorCode;
  // Structured detail for the `error` event's `data`.
  readonly data?: Record<string, unknown> | undefined;
  constructor(
    code: CliErrorCode,
    message: string,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export async function orFail<T>(
  code: CliErrorCode,
  message: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (err instanceof OstiaUsageError) {
      throw new CliError("invalid-flag", `${message}: ${err.message}`);
    }
    throw new CliError(code, `${message}: ${errorMessage(err)}`);
  }
}

const MACHINE_FORMATS = new Set(["minimal", "json", "jsonl"]);

// Machine errors are for scripts and agents: stderr isn't a terminal, or a
// machine `--format` was asked for.
async function wantsMachineErrors(): Promise<boolean> {
  // perf: imported lazily, since loading node:tty up front costs every
  // invocation ~15ms.
  const { isatty } = await import("node:tty");
  if (!isatty(2)) return true;
  const argv = process.argv.slice(2);
  return argv.some(
    (arg, i) =>
      (arg === "--format" && MACHINE_FORMATS.has(argv[i + 1] ?? "")) ||
      (arg.startsWith("--format=") &&
        MACHINE_FORMATS.has(arg.slice("--format=".length))),
  );
}

// Writes `message` to stderr, then for a machine reader one JSON `error`
// line (first line of `message` only). Never touches stdout.
export async function writeCliError(
  code: CliErrorCode,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await errOut(message.endsWith("\n") ? message : `${message}\n`);
  if (!(await wantsMachineErrors())) return;
  await errOut(
    `${JSON.stringify({
      event: "error",
      protocolVersion: MINIMAL_PROTOCOL_VERSION,
      code,
      message: message.split("\n")[0],
      ...(data && { data }),
    })}\n`,
  );
}

export async function showHelp(
  text: string,
  requested: boolean,
): Promise<0 | 2> {
  await out(text);
  return requested ? 0 : 2;
}

export async function writeRenderResult(
  result: RenderResult,
  outDir?: string,
): Promise<void> {
  if (result.text) await out(result.text);

  if (!result.files || result.files.length === 0) return;

  const only = result.files.length === 1 ? result.files[0] : undefined;
  if (outDir) {
    for (const f of result.files) {
      const path = f.path ? `${outDir}/${f.path}` : outDir;
      await Bun.write(path, f.content);
      await out(`wrote ${path}\n`);
    }
  } else if (only) {
    await out(only.content);
  } else {
    for (const f of result.files) {
      await out(`--- ${f.path ?? "(unnamed)"} ---\n${f.content}\n`);
    }
  }
}

interface OutputOptions {
  exportJson?: string;
  format: FormatName;
  quiet: boolean;
}

// Honors `--export-json`; returns the JSON text when `--format json` will
// print it (the json renderer's output is exactly this, so
// serialize once).
export async function exportDocument(
  doc: ProfileDocument,
  { exportJson, format, quiet }: OutputOptions,
): Promise<string | undefined> {
  const jsonText =
    format === "json" && !quiet ? serializeDocument(doc) : undefined;
  if (exportJson) {
    if (jsonText !== undefined) await saveDocumentText(jsonText, exportJson);
    else await saveDocument(doc, exportJson);
  }
  return jsonText;
}

// Shared tail of time/bench/ab/compare: `--export-json`, then the report
// unless `--quiet`. `rendererOptions` reaches the renderer verbatim.
export async function emitDocument(
  doc: ProfileDocument,
  args: OutputOptions,
  rendererOptions: MinimalRenderOptions = {},
): Promise<void> {
  const jsonText = await exportDocument(doc, args);
  if (args.quiet) return;
  if (jsonText !== undefined) await out(jsonText);
  else {
    await writeRenderResult(
      await renderers[args.format].render(doc, rendererOptions),
    );
  }
}
