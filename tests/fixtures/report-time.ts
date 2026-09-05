// A build-tool-shaped command: prints a summary line whose number is read
// from the file at argv[2] when given (so a `prepare` hook can drive it) or
// is a fixed 7 otherwise. The reported number is deliberately unrelated to
// how long the process actually takes.
const path = process.argv[2]
const n = path ? Number(await Bun.file(path).text()) : 7
console.log(`built ${n} pages in ${n}ms`)

export {}
