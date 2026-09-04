function hotLoop(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i) % 1000000007
  return acc
}
const r = hotLoop(5_000_000)
if (r === -1) console.log("unreachable")
