// Builds the git repo the `ab-overhead` workload runs `ostia ab` in, once.
// ostia's own bench suites can't be the subject: they import ostia by
// relative path, so the base tree's copy registers its tasks with the base
// tree's ostia and nothing pairs. This suite imports ostia by absolute path,
// the same module from both trees.

const SRC = `${import.meta.dir}/../src/index.ts`
const DIR = `${import.meta.dir}/../node_modules/.cache/ostia-ab-fixture`

const SUITE = `import { group, task } from "${SRC}"
import { work } from "../src/lib.ts"

group("fixture", () => {
  task("small", () => work(1_000))
  task("large", () => work(20_000))
})
`
const LIB = `export function work(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) acc = (acc + i * 31) % 1000000007
  return acc
}
`

const suite = Bun.file(`${DIR}/bench/s.bench.ts`)
// Rebuilt when the checkout moves, since the suite holds its path.
if (!(await suite.exists()) || (await suite.text()) !== SUITE) {
  await Bun.$`rm -rf ${DIR}`.quiet()
  await Bun.write(`${DIR}/src/lib.ts`, LIB)
  await Bun.write(`${DIR}/bench/s.bench.ts`, SUITE)
  await Bun.write(`${DIR}/.gitignore`, "node_modules\n")
  const git = (...args: string[]) =>
    Bun.$`git -c user.name=ostia -c user.email=ostia@example.com ${args}`
      .cwd(DIR)
      .quiet()
  await git("init", "-q")
  await git("add", "-A")
  await git("commit", "-qm", "fixture")
}
