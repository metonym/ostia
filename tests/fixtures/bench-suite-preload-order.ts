import { task } from "../../src/index.ts"

const order = (globalThis as Record<string, unknown>).__ostiaPreloadOrder as
  | string[]
  | undefined
if (order?.join(",") !== "a,b") {
  throw new Error(`expected preload order "a,b", got ${JSON.stringify(order)}`)
}

task("order-check", () => order.length)
