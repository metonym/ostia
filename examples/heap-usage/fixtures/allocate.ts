interface Entry {
  id: number
  label: string
}

const entries: Entry[] = []
for (let i = 0; i < 200_000; i++) {
  entries.push({ id: i, label: `entry-${i}-${"x".repeat(16)}` })
}

if (entries.length === 0) console.log("unreachable")
