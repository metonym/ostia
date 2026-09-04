/** Geometric sweep points from `start` to `end`, growing by `multiplier` each
 * step and always ending on `end` even if the last step overshot it. Mirrors
 * mitata's `.range(name, start, end, multiplier)` point generation exactly,
 * minus the name templating - build the task name yourself in the loop:
 *
 *   for (const size of range(100, 10_000)) {
 *     const input = buildInput(size)
 *     task(`${size} items`, () => parse(input))
 *   }
 *
 * range(100, 10_000)  -> [100, 800, 6400, 10000]
 * range(100, 100_000) -> [100, 800, 6400, 51200, 100000]
 */
export function range(start: number, end: number, multiplier = 8): number[] {
  if (multiplier <= 1) {
    throw new RangeError(`range: multiplier must be > 1, got ${multiplier}`)
  }
  if (start <= 0) {
    throw new RangeError(`range: start must be > 0, got ${start}`)
  }
  const points: number[] = []
  for (let v = start; v <= end; v *= multiplier) points.push(v)
  if (!points.includes(end)) points.push(end)
  return points
}
