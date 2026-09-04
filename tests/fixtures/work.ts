function hotInner(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}
const r = hotInner(4_000_000)
if (r === -1) console.log("impossible")
