export type TaskBody = () => unknown | Promise<unknown>

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<unknown>).then === "function"
  )
}

type Loop = (
  fn: TaskBody,
  sink: unknown[],
  n: number,
) => number | Promise<number>

const AsyncFunction = (async () => {}).constructor as FunctionConstructor
let loopSerial = 0
// Ring buffer every result is stored into: the JIT can't prove a stored value
// unused, so it can't elide the call or its allocations.
const SINK_SIZE = 256

/** Times `n` back-to-back calls of `fn`, returning total ns, through a loop
 * compiled for this task alone. JSC specializes compiled code per function: a
 * shared loop gets its `fn()` call site tuned for whichever task ran first and
 * measures every later task through a slower generic call. The serial in the
 * source keeps JSC's code cache from handing two tasks the same compiled body.
 * An async task gets an awaiting loop; a sync one never pays a microtask per
 * call. */
export function batchTimer(
  fn: TaskBody,
  isAsync: boolean,
): (n: number) => number | Promise<number> {
  const body = `/* ostia task loop ${loopSerial++} */
const t0 = Bun.nanoseconds()
for (let b = 0; b < n; b++) sink[b & ${SINK_SIZE - 1}] = ${isAsync ? "await " : ""}fn()
return Bun.nanoseconds() - t0`
  const loop = (isAsync ? AsyncFunction : Function)(
    "fn",
    "sink",
    "n",
    body,
  ) as Loop
  const sink: unknown[] = new Array(SINK_SIZE)
  return (n) => loop(fn, sink, n)
}

/** Calls `fn` once, timed, to learn whether it is async. */
export async function probeFirstCall(
  fn: TaskBody,
): Promise<{ isAsync: boolean; result: unknown; ns: number }> {
  const t0 = Bun.nanoseconds()
  const value = fn()
  const isAsync = isPromiseLike(value)
  const result = isAsync ? await value : value
  return { isAsync, result, ns: Math.max(1, Bun.nanoseconds() - t0) }
}
