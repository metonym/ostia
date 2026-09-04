function hashLoop(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 2654435761) % 1000000007
  return acc
}

function boringSetup(): number {
  return 1 + 1
}

boringSetup()
const r = hashLoop(6_000_000)
if (r === -1) console.log("unreachable")
