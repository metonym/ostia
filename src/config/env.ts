// The one module that reads the environment (docs: config.md, one reader
// per package). Everything else receives env values from here.

export function processEnv(): Record<string, string | undefined> {
  // eslint-disable-next-line no-restricted-properties -- the one env reader
  return process.env;
}

// The one wall-clock reader, for comparisons against file times.
export function nowMs(): number {
  // eslint-disable-next-line no-restricted-properties -- the one clock reader
  return Date.now();
}
