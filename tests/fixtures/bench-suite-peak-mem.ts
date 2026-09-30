import { group, task } from "../../src/index.ts"

group("mem", () => {
  // ~40MB allocated and dropped per call: --alloc reads ~0, --peak-mem doesn't.
  task("garbage", () => new Array(5_000_000).fill(1.5).length)
  task("opted out", () => 1, { peakMem: false })
})
