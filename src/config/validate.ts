/** A config file that exists but can't be used; the CLI reports it as `config-invalid`. */
export class ConfigError extends Error {}

type Rule = (v: unknown) => boolean

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const isInt =
  (min: number): Rule =>
  (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= min
const isNum =
  (min: number): Rule =>
  (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= min
const isString: Rule = (v) => typeof v === "string"
const isBool: Rule = (v) => typeof v === "boolean"
const isStringArray: Rule = (v) => Array.isArray(v) && v.every(isString)
const oneOf =
  (...values: unknown[]): Rule =>
  (v) =>
    values.includes(v)

interface Field {
  ok: Rule
  expects: string
}

const field = (ok: Rule, expects: string): Field => ({ ok, expects })
const posInt = field(isInt(1), "a positive integer")
const nonNegInt = field(isInt(0), "a non-negative integer")
const text = field(isString, "a string")
const flag = field(isBool, "a boolean")
const strings = field(isStringArray, "an array of strings")

const THRESHOLD_FIELDS: Record<string, Field> = {
  timingPct: field(isNum(0), "a non-negative number"),
  frameSelfPct: field(isNum(0), "a non-negative number"),
  heapTypePct: field(isNum(0), "a non-negative number"),
  minFrameSelfUs: field(isNum(0), "a non-negative number"),
  alpha: field((v) => isNum(0)(v) && (v as number) <= 1, "a number in [0, 1]"),
  bootstrapIterations: posInt,
}

const BENCH_FIELDS: Record<string, Field> = {
  suites: strings,
  preload: strings,
  bunFlags: strings,
  jobs: field(
    (v) => isInt(1)(v) || v === "auto",
    `a positive integer or "auto"`,
  ),
  budgetMs: field(isNum(0), "a non-negative number"),
  samples: posInt,
  minSamples: posInt,
  gc: flag,
  cpu: flag,
  cpuIntervalUs: posInt,
  alloc: flag,
  peakMem: flag,
  filter: text,
  isolate: flag,
  outDir: text,
  timeoutMs: posInt,
}

const COMMAND_ONLY = ["inputs", "prepare", "timeSource", "ignoreExitCodes"]

const WORKLOAD_FIELDS: Record<string, Field> = {
  label: text,
  command: field(
    (v) => isStringArray(v) && (v as string[]).length > 0,
    "a non-empty array of strings (argv, no shell)",
  ),
  suites: field(
    (v) => isStringArray(v) && (v as string[]).length > 0,
    "a non-empty array of glob strings",
  ),
  inputs: strings,
  prepare: field(
    (v) => isString(v) || isStringArray(v) || typeof v === "function",
    "a command string, an argv array, or (ostia.config.ts) a function",
  ),
  timeSource: field(
    (v) =>
      isObject(v) &&
      (isString(v.pattern) || v.pattern instanceof RegExp) &&
      (v.group === undefined || isInt(0)(v.group)) &&
      (v.unit === undefined || oneOf("ns", "us", "ms", "s")(v.unit)),
    `an object { pattern, group?, unit? } with a regex source string (or RegExp) pattern, an integer group, and unit "ns" | "us" | "ms" | "s"`,
  ),
  timeoutMs: posInt,
  ignoreExitCodes: field(
    (v) =>
      Array.isArray(v) && v.every((c) => isInt(0)(c) && (c as number) <= 255),
    "an array of exit codes 0-255",
  ),
}

const TOP_FIELDS: Record<string, Field> = {
  samples: posInt,
  budgetMs: field(isNum(0), "a non-negative number"),
  minSamples: posInt,
  warmup: nonNegInt,
  outDir: field((v) => isString(v) && v !== "", "a non-empty string"),
  baselineDir: field((v) => isString(v) && v !== "", "a non-empty string"),
  baseline: field((v) => isString(v) && v !== "", "a non-empty string"),
  onMissingBaseline: field(oneOf("warn", "fail"), `"warn" or "fail"`),
  noiseCheck: flag,
}

const describe = (v: unknown): string =>
  typeof v === "function"
    ? "a function"
    : v instanceof RegExp
      ? String(v)
      : (JSON.stringify(v) ?? String(v))

/** Checks each present (non-`undefined`) key of `obj` against `fields`; unknown
 * keys are reported to `warn` rather than failing, as they always were
 * ignored. A `$`-prefixed key (`"$schema"`) is never reported. */
function checkFields(
  obj: Record<string, unknown>,
  fields: Record<string, Field>,
  where: string,
  file: string,
  warn: (message: string) => void,
): void {
  const prefix = where === "" ? "" : `${where}.`
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    const spec = Object.hasOwn(fields, key) ? fields[key] : undefined
    if (!spec) {
      if (!key.startsWith("$")) {
        warn(`${file}: unknown key "${prefix}${key}" is ignored.`)
      }
    } else if (!spec.ok(value)) {
      throw new ConfigError(
        `${file}: "${prefix}${key}" must be ${spec.expects}, got ${describe(value)}.`,
      )
    }
  }
}

function checkObject(
  value: unknown,
  where: string,
  file: string,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ConfigError(
      `${file}: "${where}" must be an object, got ${describe(value)}.`,
    )
  }
  return value
}

function checkWorkload(
  wc: unknown,
  i: number,
  file: string,
  warn: (message: string) => void,
): void {
  const where = `workloads[${i}]`
  const obj = checkObject(wc, where, file)
  const has = (key: string) => obj[key] !== undefined
  if (has("command") === has("suites")) {
    throw new ConfigError(
      `${file}: "${where}" needs exactly one of "command" or "suites".`,
    )
  }
  checkFields(obj, WORKLOAD_FIELDS, where, file, warn)
  if (has("suites")) {
    for (const key of COMMAND_ONLY) {
      if (has(key)) {
        warn(
          `${file}: "${where}.${key}" applies to command workloads only; ignored on a suites workload.`,
        )
      }
    }
  }
  const source = (obj.timeSource as { pattern?: unknown } | undefined)?.pattern
  if (typeof source === "string") {
    try {
      new RegExp(source)
    } catch (err) {
      throw new ConfigError(
        `${file}: "${where}.timeSource.pattern" is not a valid regex: ${(err as Error).message}`,
      )
    }
  }
}

/** Throws `ConfigError` naming the offending key for a wrong type or value;
 * `warn` gets keys that are unknown (or inapplicable) and so ignored. `raw` is
 * the already-object-checked config with `undefined` values still present. */
export function validateConfig(
  raw: Record<string, unknown>,
  file: string,
  warn: (message: string) => void,
): void {
  const { thresholds, workloads, bench, ...rest } = raw
  checkFields(rest, TOP_FIELDS, "", file, warn)
  if (thresholds !== undefined) {
    checkFields(
      checkObject(thresholds, "thresholds", file),
      THRESHOLD_FIELDS,
      "thresholds",
      file,
      warn,
    )
  }
  if (bench !== undefined) {
    checkFields(
      checkObject(bench, "bench", file),
      BENCH_FIELDS,
      "bench",
      file,
      warn,
    )
  }
  if (workloads !== undefined) {
    if (!Array.isArray(workloads)) {
      throw new ConfigError(
        `${file}: "workloads" must be an array, got ${describe(workloads)}.`,
      )
    }
    workloads.forEach((wc, i) => {
      checkWorkload(wc, i, file, warn)
    })
  }
}
