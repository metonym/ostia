// Runs in a fresh process so the probe's first measurement is the harness's
// first ever: prints the probe's median alone, then again after other tasks.
import { measureTask } from "../../src/measure/inprocess.ts"

let x = 1
const probe = () => () => x + 1
const alone = await measureTask(probe(), { budgetMs: 50 })
await measureTask(() => ({ a: x++ }), { budgetMs: 20 })
await measureTask(() => String(x), { budgetMs: 20 })
await measureTask(async () => x, { budgetMs: 20 })
const after = await measureTask(probe(), { budgetMs: 50 })
console.log(
  JSON.stringify({ alone: alone.timing.median, after: after.timing.median }),
)
