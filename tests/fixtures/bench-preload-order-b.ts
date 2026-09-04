const order = (globalThis as Record<string, unknown>).__ostiaPreloadOrder as
  | string[]
  | undefined
if (order?.[0] !== "a") {
  throw new Error(
    `preload order violated: expected "a" to have run first, got ${JSON.stringify(order)}`,
  )
}
order.push("b")
