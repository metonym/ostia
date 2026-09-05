import { withCurrentParams } from "./registry.ts"

type SweepPoint<T extends Record<string, readonly unknown[]>> = {
  [K in keyof T]: T[K][number]
}

/** Cartesian product over `dims`, calling `fn` once per point. Inside `fn`,
 * `task()` calls automatically inherit the point as their params (an
 * explicit `TaskOptions.params` merges over it, explicit keys win):
 *
 *   group("parse", () => {
 *     sweep({ size: range(100, 10_000), impl: ["current", "fast"] }, ({ size, impl }) => {
 *       const input = build(size)
 *       task(`${impl}`, () => impls[impl](input))
 *     })
 *   })
 */
export function sweep<T extends Record<string, readonly unknown[]>>(
  dims: T,
  fn: (point: SweepPoint<T>) => void,
): void {
  const keys = Object.keys(dims) as (keyof T)[]

  const go = (index: number, point: Record<string, unknown>): void => {
    if (index === keys.length) {
      withCurrentParams(
        point as Record<string, string | number | boolean>,
        () => fn(point as SweepPoint<T>),
      )
      return
    }
    const key = keys[index]!
    for (const value of dims[key]!) {
      go(index + 1, { ...point, [key]: value })
    }
  }

  go(0, {})
}
