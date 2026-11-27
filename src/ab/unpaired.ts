// Why `ab` paired nothing, in words a person can act on: each side's task
// count, then the likeliest cause.

// A suite that imports `group` or `task` by a relative path, as one
// inside ostia's own repository does, has the base ref's copy register
// its tasks with the base tree's copy of ostia, which the runner never
// reads, so that side has none.
const RELATIVE_HARNESS =
  /import\s*\{[^}]*\b(?:group|task)\b[^}]*\}\s*from\s*["']\.{1,2}\/[^"']*["']/;

export const importsHarnessRelatively = (suiteText: string): boolean =>
  RELATIVE_HARNESS.test(suiteText);

export interface Unpaired {
  /** The failure: each side's task count. */
  what: string;
  /** The likeliest cause, and what to do. */
  next: string;
}

export function unpairedReason(input: {
  ref: string;
  base: number;
  cand: number;
  /** Every suite is new: none exists at `ref`. */
  allNew: boolean;
  relativeHarness: boolean;
}): Unpaired {
  const { ref, base, cand } = input;
  const tasks = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;
  const what = `Nothing paired: ${ref} has ${tasks(base)}, the working tree ${tasks(cand)}`;
  if (input.allNew) {
    return {
      what,
      next: `no suite exists at ${ref}; time new suites with ostia bench`,
    };
  }
  if (base === 0 && cand > 0 && input.relativeHarness) {
    return {
      what,
      next: `the suite imports ostia by a relative path, so ${ref}'s copy registers with ${ref}'s own ostia; import it as "ostia", or by an absolute path`,
    };
  }
  if (base === 0) {
    return { what, next: `${ref}'s copy of the suite registered no task` };
  }
  if (cand === 0) {
    return { what, next: "the working tree's suite registered no task" };
  }
  return {
    what,
    next: "no task name is on both sides; a renamed task pairs with nothing",
  };
}
