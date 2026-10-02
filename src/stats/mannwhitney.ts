import { sortedCopy } from "./index.ts"

export interface MannWhitneyResult {
  /** U statistic for `a`. */
  u: number
  z: number
  /** Two-sided, normal approximation, tie-corrected. */
  pValue: number
}

/** Abramowitz & Stegun 7.1.26: erf approximation, max error ~1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1 / (1 + p * ax)
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return sign * y
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** Mann-Whitney U test: whether `a` and `b` share a distribution, without the
 * normality a t-test assumes (wall-clock samples are right-skewed). Ranks come
 * from a merge walk over the two sorted sides. An empty side gives `pValue: 1`. */
export function mannWhitneyU(a: number[], b: number[]): MannWhitneyResult {
  const n1 = a.length
  const n2 = b.length
  const n = n1 + n2
  // No evidence either way: the variance below is 0/0 for an empty side.
  if (n1 === 0 || n2 === 0) return { u: 0, z: 0, pValue: 1 }

  const sa = sortedCopy(a)
  const sb = sortedCopy(b)

  // One tie group (distinct value) at a time; each member gets the group's average rank.
  let r1 = 0 // rank sum of `a`
  let tieCorrection = 0
  let i = 0
  let j = 0
  let pos = 0 // 0-based rank position consumed so far
  while (i < n1 || j < n2) {
    const v = j >= n2 || (i < n1 && sa[i]! <= sb[j]!) ? sa[i]! : sb[j]!
    let ca = 0
    while (i < n1 && sa[i] === v) {
      ca++
      i++
    }
    let cb = 0
    while (j < n2 && sb[j] === v) {
      cb++
      j++
    }
    const t = ca + cb
    const avgRank = pos + (t + 1) / 2
    r1 += ca * avgRank
    if (t > 1) tieCorrection += t ** 3 - t
    pos += t
  }

  const u1 = r1 - (n1 * (n1 + 1)) / 2
  const muU = (n1 * n2) / 2
  const sigmaU = Math.sqrt(
    (n1 * n2 * (n + 1 - tieCorrection / (n * (n - 1)))) / 12,
  )
  const z = sigmaU === 0 ? 0 : (u1 - muU) / sigmaU
  const pValue = Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))))

  return { u: u1, z, pValue }
}
