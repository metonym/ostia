import { relative } from "node:path"
import type { BenchProject } from "../config/index.ts"
import { absolutePath } from "./support.ts"

export interface SuiteLaunch {
  /** Absolute paths, imported in order before the suite file. */
  preload: string[]
  bunFlags: string[]
}

/** Launch settings for each of `suites`, in order: the first project whose
 * globs match the file (against its path relative to `cwd`) overrides the
 * top-level `preload` / `bunFlags` field by field; a field the project leaves
 * unset, or a file no project matches, keeps the top-level value. */
export function resolveSuiteLaunches(
  suites: string[],
  cwd: string,
  base: { preload?: string[]; bunFlags?: string[] },
  projects: BenchProject[] = [],
): SuiteLaunch[] {
  const matchers = projects.map((project) =>
    project.suites.map((pattern) => new Bun.Glob(pattern)),
  )
  return suites.map((file) => {
    const rel = relative(cwd, absolutePath(cwd, file))
    const index = matchers.findIndex((globs) => globs.some((g) => g.match(rel)))
    const project = index < 0 ? undefined : projects[index]
    return {
      preload: (project?.preload ?? base.preload ?? []).map((p) =>
        absolutePath(cwd, p),
      ),
      bunFlags: project?.bunFlags ?? base.bunFlags ?? [],
    }
  })
}
