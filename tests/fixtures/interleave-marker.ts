export {}

const [label, logPath] = process.argv.slice(2)
if (!label || !logPath) {
  throw new Error("usage: interleave-marker.ts <label> <logPath>")
}

const existing = (await Bun.file(logPath).exists())
  ? await Bun.file(logPath).text()
  : ""
await Bun.write(logPath, `${existing}${label}\n`)
