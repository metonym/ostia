export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The caller's input can't be run as given (missing suite, bad ref, absent
 * baseline): the CLI reports it as a usage error (exit 2) rather than an
 * internal failure. */
export class OstiaUsageError extends Error {}
