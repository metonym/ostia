import { availableJobs } from "../bench/index.ts";
import type { FormatName } from "../renderers/index.ts";
import { splitCommand } from "../spawn/index.ts";

/**
 * Thrown for a malformed flag; the dispatcher prints it with a `--help`
 * pointer and exits 2.
 */
export class CliUsageError extends Error {}

const DOCUMENT_FORMATS = [
  "table",
  "json",
  "jsonl",
  "markdown",
  "minimal",
] as const;

export const VIZ_FORMATS = [
  "collapsed",
  "mermaid",
  "speedscope",
  "cpuprofile",
] as const;

export const REPORT_FORMATS: readonly [
  ...typeof DOCUMENT_FORMATS,
  ...typeof VIZ_FORMATS,
] = [...DOCUMENT_FORMATS, ...VIZ_FORMATS] as const;

export function parseIntFlag(
  name: string,
  raw: string | undefined,
  opts: { min?: number; allowAuto?: boolean } = {},
): number {
  if (opts.allowAuto && raw === "auto") return availableJobs();
  const min = opts.min ?? 1;
  const n = raw?.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new CliUsageError(
      `Invalid ${name} "${raw}": expected an integer ≥ ${min}${
        opts.allowAuto ? ` (or "auto")` : ""
      }`,
    );
  }
  return n;
}

function parseExitCodes(name: string, raw: string): number[] {
  return raw.split(",").map((part) => {
    const code = /^\d+$/.test(part) ? Number(part) : Number.NaN;
    if (!(code <= 255)) {
      throw new CliUsageError(
        `Invalid ${name} "${raw}": expected exit codes 0-255, comma-separated`,
      );
    }
    return code;
  });
}

type FlagSpec =
  | { kind: "string" }
  | { kind: "int"; min?: number; allowAuto?: boolean }
  | { kind: "number"; min: number }
  | { kind: "bool"; value: boolean }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "list" }
  | { kind: "words" }
  | { kind: "exitCodes" };

interface FlagDef {
  dest: string;
  spec: FlagSpec;
}

type FlagTable = Record<string, FlagDef>;

const def = (dest: string, spec: FlagSpec): FlagDef => ({ dest, spec });

export const flag = {
  str: (dest: string): FlagDef => def(dest, { kind: "string" }),
  int: (dest: string, min: number = 1, allowAuto: boolean = false): FlagDef =>
    def(dest, { kind: "int", min, allowAuto }),
  num: (dest: string, min: number): FlagDef =>
    def(dest, { kind: "number", min }),
  on: (dest: string): FlagDef => def(dest, { kind: "bool", value: true }),
  off: (dest: string): FlagDef => def(dest, { kind: "bool", value: false }),
  oneOf: (dest: string, values: readonly string[]): FlagDef =>
    def(dest, { kind: "enum", values }),
  /** Repeatable; each occurrence appends one value. */
  list: (dest: string): FlagDef => def(dest, { kind: "list" }),
  /** Repeatable; each occurrence is whitespace-split and appended. */
  words: (dest: string): FlagDef => def(dest, { kind: "words" }),
  /** `--flag[=CODE,...]`: bare means every non-zero exit code. */
  exitCodes: (dest: string): FlagDef => def(dest, { kind: "exitCodes" }),
};

export interface OutputArgs {
  exportJson?: string;
  format: FormatName;
  quiet: boolean;
  help: boolean;
}

export interface RunArgs extends OutputArgs {
  noiseCheck: boolean;
}

export const OUTPUT_DEFAULTS = {
  format: "table",
  quiet: false,
  help: false,
} as const;

export const RUN_DEFAULTS: typeof OUTPUT_DEFAULTS & {
  readonly noiseCheck: true;
} = { ...OUTPUT_DEFAULTS, noiseCheck: true } as const;

export const HELP_FLAGS: FlagTable = {
  "--help": flag.on("help"),
  "-h": flag.on("help"),
};

export const OUTPUT_FLAGS: FlagTable = {
  ...HELP_FLAGS,
  "--export-json": flag.str("exportJson"),
  "--format": flag.oneOf("format", DOCUMENT_FORMATS),
  "--quiet": flag.on("quiet"),
};

export const NOISE_CHECK_FLAGS: FlagTable = {
  "--no-noise-check": flag.off("noiseCheck"),
};

export const CONFIG_FLAGS: FlagTable = {
  "--config": flag.str("config"),
};

export interface ConfigArgs {
  config?: string;
}

// Every command that runs measurements takes these, except `ci`, which
// doesn't take per-run flags.
export const RUN_FLAGS: FlagTable = {
  ...OUTPUT_FLAGS,
  ...NOISE_CHECK_FLAGS,
  "--timeout": flag.int("timeoutMs"),
  "--out-dir": flag.str("outDir"),
};

export const SUITE_FLAGS: FlagTable = {
  ...RUN_FLAGS,
  ...CONFIG_FLAGS,
  "--filter": flag.str("filter"),
  "--preload": flag.list("preload"),
  "--bun-flags": flag.words("bunFlags"),
};

// invariant: a repeatable flag's `dest` starts as an array in the
// command's defaults.
function listAt(args: object, dest: string): unknown[] {
  const list: unknown = Reflect.get(args, dest);
  if (!Array.isArray(list)) {
    throw new TypeError(`ostia: flag destination "${dest}" isn't an array`);
  }
  return list;
}

interface ParseSpec<T> {
  command: string;
  flags: FlagTable;
  args: T;
  /** Receives each bare word; omitted, a bare word is an unknown-flag error. */
  positional?: (arg: string, args: T) => void;
  /**
   * Receives everything after a `--`, verbatim; omitted, `--` is an unknown
   * flag.
   */
  rest?: (rest: string[], args: T) => void;
}

// Throws only `CliUsageError`, so the dispatcher can print a `--help`
// pointer for any parse failure. `--flag=value` equals `--flag value`.
export function parseFlags<T extends object>(
  argv: string[],
  { command, flags, args, positional, rest }: ParseSpec<T>,
): T {
  const set = (dest: string, value: unknown) => Reflect.set(args, dest, value);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--" && rest) {
      rest(argv.slice(i + 1), args);
      break;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const flagDef = Object.hasOwn(flags, name) ? flags[name] : undefined;
    if (!flagDef || (eq > 0 && flagDef.spec.kind === "bool")) {
      if (arg.startsWith("-") || !positional) {
        throw new CliUsageError(
          `Unknown flag "${arg}" for "ostia ${command}".`,
        );
      }
      positional(arg, args);
      continue;
    }
    const value = (): string => {
      if (eq > 0) return arg.slice(eq + 1);
      if (i + 1 >= argv.length) {
        throw new CliUsageError(`Missing value for ${name}.`);
      }
      return argv[++i] ?? "";
    };
    const { dest, spec } = flagDef;
    switch (spec.kind) {
      case "string":
        set(dest, value());
        break;
      case "int":
        set(dest, parseIntFlag(name, value(), spec));
        break;
      case "number": {
        const raw = value();
        const n = Number(raw);
        if (raw === "" || !Number.isFinite(n) || n < spec.min) {
          throw new CliUsageError(
            `Invalid ${name} "${raw}": expected a number ≥ ${spec.min}`,
          );
        }
        set(dest, n);
        break;
      }
      case "bool":
        set(dest, spec.value);
        break;
      case "list":
        listAt(args, dest).push(value());
        break;
      case "words":
        listAt(args, dest).push(...splitCommand(value()));
        break;
      case "exitCodes":
        listAt(args, dest).push(
          ...(eq > 0
            ? parseExitCodes(name, arg.slice(eq + 1))
            : Array.from({ length: 255 }, (_, n) => n + 1)),
        );
        break;
      case "enum": {
        const raw = value();
        if (!spec.values.includes(raw)) {
          throw new CliUsageError(
            `Invalid ${name} "${raw}": expected one of: ${spec.values.join(", ")}`,
          );
        }
        set(dest, raw);
        break;
      }
    }
  }
  return args;
}
