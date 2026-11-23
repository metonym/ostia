import { withCurrentParams } from "./registry.ts";

export type SweepPoint<T extends Record<string, readonly unknown[]>> = {
  [K in keyof T]: T[K][number];
};

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
  const keys = Object.keys(dims);

  const go = (index: number, point: Record<string, unknown>): void => {
    const key = keys[index];
    if (key === undefined) {
      withCurrentParams(
        // eslint-disable-next-line typescript/consistent-type-assertions -- `dims` may hold any value, and params carry the point as given
        point as Record<string, string | number | boolean>,
        // eslint-disable-next-line typescript/consistent-type-assertions -- every key of `dims` is set by now, which TS can't follow through a mapped type
        () => fn(point as SweepPoint<T>),
      );
      return;
    }
    for (const value of dims[key] ?? []) {
      go(index + 1, { ...point, [key]: value });
    }
  };

  go(0, {});
}
