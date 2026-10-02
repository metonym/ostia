import { fp } from "../ir/fp.ts"
import type { Frame, FrameTotal } from "../ir/types.ts"

export function createFrameTable(): {
  frames: Frame[]
  intern: (
    name: string,
    url: string | undefined,
    line: number | undefined,
    col: number | undefined,
  ) => number
} {
  const ixByName = new Map<string, Map<string, number>>()
  const frames: Frame[] = []
  return {
    frames,
    intern(name, url, line, col) {
      let byUrl = ixByName.get(name)
      if (byUrl === undefined) {
        byUrl = new Map()
        ixByName.set(name, byUrl)
      }
      const urlKey = url ?? ""
      let ix = byUrl.get(urlKey)
      if (ix === undefined) {
        ix = frames.length
        byUrl.set(urlKey, ix)
        frames.push({ key: fp("fr", name, urlKey), name, url, line, col })
      }
      return ix
    },
  }
}

export function addFrameTotal(
  totals: Map<number, FrameTotal>,
  frameIx: number,
  selfUs: number,
  totalUs: number,
  samples: number,
): void {
  const existing = totals.get(frameIx)
  if (existing) {
    existing.selfUs += selfUs
    existing.totalUs += totalUs
    existing.samples += samples
  } else {
    totals.set(frameIx, { frameIx, selfUs, totalUs, samples })
  }
}

export function sortedTotals(totals: Map<number, FrameTotal>): FrameTotal[] {
  return [...totals.values()].sort((a, b) => b.selfUs - a.selfUs)
}
