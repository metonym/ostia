import { task } from "../../src/index.ts"

const garbage = () => new Array(5_000_000).fill(1.5).length

// Module-scope work that peaks as high as the task: it hides the task's
// peak unless skipped in peak-memory processes.
if (!process.env.OSTIA_PEAK_MEM_FIXTURE_GATED || !process.env.OSTIA_PEAK_MEM) {
  garbage()
}

task("garbage", garbage)
