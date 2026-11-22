import { relative } from "node:path";

import type { BenchProject } from "../config/index.ts";
import { absolutePath } from "./support.ts";

export interface SuiteLaunch {
  /** Absolute paths, imported in order before the suite file. */
  preload: string[];
  bunFlags: string[];
}

export function suiteLauncher(
  cwd: string,
  base: { preload?: string[]; bunFlags?: string[] },
  projects: BenchProject[] = [],
): (file: string) => SuiteLaunch {
  const matchers = projects.map((project) =>
    project.suites.map((pattern) => new Bun.Glob(pattern)),
  );
  return (file) => {
    const rel = relative(cwd, absolutePath(cwd, file));
    const index = matchers.findIndex((globs) =>
      globs.some((g) => g.match(rel)),
    );
    const project = index < 0 ? undefined : projects[index];
    return {
      preload: (project?.preload ?? base.preload ?? []).map((p) =>
        absolutePath(cwd, p),
      ),
      bunFlags: project?.bunFlags ?? base.bunFlags ?? [],
    };
  };
}

export function resolveSuiteLaunches(
  suites: string[],
  cwd: string,
  base: { preload?: string[]; bunFlags?: string[] },
  projects: BenchProject[] = [],
): SuiteLaunch[] {
  const launch = suiteLauncher(cwd, base, projects);
  return suites.map((file) => launch(file));
}
