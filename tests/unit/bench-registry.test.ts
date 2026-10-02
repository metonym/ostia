import { beforeEach, describe, expect, test } from "bun:test"
import {
  filterTasks,
  getRegisteredTasks,
  group,
  groupEdges,
  resetRegistry,
  runGroupHooks,
  selectTasks,
  task,
  taskAlloc,
  taskCpu,
  taskGc,
  taskId,
  taskIsolate,
} from "../../src/bench/registry"
import { sweep } from "../../src/bench/sweep"

describe("bench/registry", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("task outside group registers with undefined groupName", () => {
    task("solo", () => 1)
    const tasks = getRegisteredTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.name).toBe("solo")
    expect(tasks[0]!.groupName).toBeUndefined()
  })

  test("task stores per-task options when given", () => {
    task("plain", () => 1)
    task("tuned", () => 1, { budgetMs: 2000, minSamples: 10 })
    const tasks = getRegisteredTasks()
    expect(tasks[0]!.opts).toBeUndefined()
    expect(tasks[1]!.opts).toEqual({ budgetMs: 2000, minSamples: 10 })
  })

  test("tasks inside group register with correct groupName", () => {
    group("g1", () => {
      task("a", () => 1)
      task("b", () => 2)
    })
    const tasks = getRegisteredTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.name).toBe("a")
    expect(tasks[0]!.groupName).toBe("g1")
    expect(tasks[1]!.name).toBe("b")
    expect(tasks[1]!.groupName).toBe("g1")
  })

  test("group context is properly restored after group call", () => {
    group("g1", () => {
      task("x", () => 1)
    })
    task("y", () => 2)
    const tasks = getRegisteredTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.groupName).toBe("g1")
    expect(tasks[1]!.groupName).toBeUndefined()
  })

  test("task registers with baseline: true when passed in options", () => {
    group("g1", () => {
      task("old", () => 1, { baseline: true })
      task("new", () => 2)
    })
    const tasks = getRegisteredTasks()
    expect(tasks[0]!.baseline).toBe(true)
    expect(tasks[1]!.baseline).toBeUndefined()
  })

  test("group and task descriptions are recorded; group description reaches every member", () => {
    group(
      "parse",
      () => {
        task("small", () => 1, { description: "fast path" })
        task("large", () => 2)
      },
      { description: "parser throughput" },
    )
    task("solo", () => 3)
    const tasks = getRegisteredTasks()
    expect(tasks[0]!.opts?.description).toBe("fast path")
    expect(tasks[0]!.groupDescription).toBe("parser throughput")
    expect(tasks[1]!.opts?.description).toBeUndefined()
    expect(tasks[1]!.groupDescription).toBe("parser throughput")
    expect(tasks[2]!.groupDescription).toBeUndefined()
  })

  test("a nested group's name is its path, and the outer group is restored after it", () => {
    group(
      "outer",
      () => {
        group("inner", () => {
          task("i", () => 1)
        })
        task("o", () => 2)
      },
      { description: "outer desc" },
    )
    const tasks = getRegisteredTasks()
    expect(tasks[0]!.groupName).toBe("outer/inner")
    expect(taskId(tasks[0]!)).toBe("outer/inner/i")
    expect(tasks[1]!.groupName).toBe("outer")
    expect(tasks[1]!.groupDescription).toBe("outer desc")
  })

  test("a nested group inherits what it doesn't set and overrides what it does", () => {
    group(
      "outer",
      () => {
        group("inherits", () => task("a", () => 1))
        group("overrides", () => task("b", () => 1), {
          description: "inner desc",
          gc: false,
        })
      },
      { description: "outer desc", isolate: true, gc: true },
    )
    const [a, b] = getRegisteredTasks()
    expect(a!.groupDescription).toBe("outer desc")
    expect(a!.groupIsolate).toBe(true)
    expect(a!.groupGc).toBe(true)
    expect(b!.groupDescription).toBe("inner desc")
    expect(b!.groupIsolate).toBe(true)
    expect(b!.groupGc).toBe(false)
  })

  test("group.skip/group.only reach nested groups", () => {
    group.skip("s", () => group("inner", () => task("a", () => 1)))
    group.only("o", () => group("inner", () => task("b", () => 1)))
    group("plain", () => group.skip("inner", () => task("c", () => 1)))
    const [a, b, c] = getRegisteredTasks()
    expect(a!.skipped).toBe(true)
    expect(b!.only).toBe(true)
    expect(c!.skipped).toBe(true)
    expect(c!.only).toBeUndefined()
  })

  test("registered task function can be invoked and returns expected value", () => {
    task("t", () => 42)
    const tasks = getRegisteredTasks()
    const result = tasks[0]!.fn()
    expect(result).toBe(42)
  })

  test("resetRegistry clears all tasks and state", () => {
    task("before", () => 1)
    expect(getRegisteredTasks()).toHaveLength(1)
    resetRegistry()
    expect(getRegisteredTasks()).toHaveLength(0)

    group("new-group", () => {
      task("after", () => 2)
    })
    const tasks = getRegisteredTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.groupName).toBe("new-group")
  })

  test("sequential group calls maintain separate group contexts", () => {
    group("g1", () => {
      task("x", () => 1)
    })
    group("g2", () => {
      task("y", () => 2)
    })
    const tasks = getRegisteredTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.groupName).toBe("g1")
    expect(tasks[0]!.name).toBe("x")
    expect(tasks[1]!.groupName).toBe("g2")
    expect(tasks[1]!.name).toBe("y")
  })
})

describe("bench/registry - params and sweep()", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("task(name, fn, { params }) records params on the registered task", () => {
    task("t", () => 1, { params: { size: 100 } })
    const [t] = getRegisteredTasks()
    expect(t!.params).toEqual({ size: 100 })
  })

  test("a task with no params and none inherited from a sweep has undefined params", () => {
    task("t", () => 1)
    const [t] = getRegisteredTasks()
    expect(t!.params).toBeUndefined()
  })

  test("sweep() calls fn once per cartesian point, in dimension order", () => {
    const points: unknown[] = []
    sweep({ size: [1, 2], impl: ["a", "b"] }, (point) => {
      points.push({ ...point })
    })
    expect(points).toEqual([
      { size: 1, impl: "a" },
      { size: 1, impl: "b" },
      { size: 2, impl: "a" },
      { size: 2, impl: "b" },
    ])
  })

  test("task() calls inside sweep() inherit the current point as params", () => {
    sweep({ size: [100, 200], impl: ["current", "fast"] }, ({ impl }) => {
      task(impl, () => 1)
    })
    const tasks = getRegisteredTasks()
    expect(tasks).toHaveLength(4)
    expect(tasks.map((t) => t.params)).toEqual([
      { size: 100, impl: "current" },
      { size: 100, impl: "fast" },
      { size: 200, impl: "current" },
      { size: 200, impl: "fast" },
    ])
  })

  test("an explicit params on task() merges over (and wins against) the sweep point", () => {
    sweep({ size: [100] }, ({ size }) => {
      task("t", () => 1, { params: { size, variant: "override" } })
    })
    const [t] = getRegisteredTasks()
    expect(t!.params).toEqual({ size: 100, variant: "override" })
  })

  test("sweep() state does not leak into task() calls after it returns", () => {
    sweep({ size: [1] }, () => {
      task("inside", () => 1)
    })
    task("outside", () => 1)
    const tasks = getRegisteredTasks()
    expect(tasks[0]!.params).toEqual({ size: 1 })
    expect(tasks[1]!.params).toBeUndefined()
  })
})

describe("bench/registry - filterTasks", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("no filter returns every registered task, unchanged order", () => {
    group("parse", () => {
      task("small", () => 1)
    })
    task("noop", () => 1)
    const all = getRegisteredTasks()
    expect(filterTasks(all)).toEqual([...all])
  })

  test("filter matches against the group/name task id, substring, no anchoring", () => {
    group("parse", () => {
      task("small", () => 1)
      task("large", () => 2)
    })
    group("write", () => {
      task("small", () => 3)
    })
    const all = getRegisteredTasks()

    const parseOnly = filterTasks(all, "parse")
    expect(parseOnly.map(taskId)).toEqual(["parse/small", "parse/large"])

    const small = filterTasks(all, "small")
    expect(small.map(taskId)).toEqual(["parse/small", "write/small"])
  })

  test("filter is case-sensitive, matching mitata's default", () => {
    group("Parse", () => {
      task("small", () => 1)
    })
    const all = getRegisteredTasks()
    expect(filterTasks(all, "parse")).toHaveLength(0)
    expect(filterTasks(all, "Parse")).toHaveLength(1)
  })

  test("filter matching nothing returns an empty array, not a throw", () => {
    task("solo", () => 1)
    const all = getRegisteredTasks()
    expect(filterTasks(all, "nonexistent-xyz")).toEqual([])
  })

  test("taskId qualifies grouped tasks and leaves ungrouped tasks bare", () => {
    group("g1", () => {
      task("a", () => 1)
    })
    task("b", () => 2)
    const all = getRegisteredTasks()
    expect(all.map(taskId)).toEqual(["g1/a", "b"])
  })
})

describe("bench/registry - taskIsolate", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("falls back to the suite-wide default when neither task nor group set isolate", () => {
    task("solo", () => 1)
    const [t] = getRegisteredTasks()
    expect(taskIsolate(t!, false)).toBe(false)
    expect(taskIsolate(t!, true)).toBe(true)
  })

  test("group isolate wins over the suite-wide default", () => {
    group("g", () => task("a", () => 1), { isolate: true })
    const [t] = getRegisteredTasks()
    expect(taskIsolate(t!, false)).toBe(true)
  })

  test("task isolate wins over its group's and the suite-wide default", () => {
    group(
      "g",
      () => {
        task("a", () => 1, { isolate: false })
      },
      { isolate: true },
    )
    const [t] = getRegisteredTasks()
    expect(taskIsolate(t!, true)).toBe(false)
  })
})

describe("bench/registry - taskGc", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("falls back to the suite-wide default when neither task nor group set gc", () => {
    task("solo", () => 1)
    const [t] = getRegisteredTasks()
    expect(taskGc(t!, false)).toBe(false)
    expect(taskGc(t!, true)).toBe(true)
  })

  test("group gc wins over the suite-wide default", () => {
    group("g", () => task("a", () => 1), { gc: true })
    const [t] = getRegisteredTasks()
    expect(taskGc(t!, false)).toBe(true)
  })

  test("task gc wins over its group's and the suite-wide default", () => {
    group(
      "g",
      () => {
        task("a", () => 1, { gc: false })
      },
      { gc: true },
    )
    const [t] = getRegisteredTasks()
    expect(taskGc(t!, true)).toBe(false)
  })
})

describe("bench/registry - taskCpu", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("falls back to the suite-wide default when neither task nor group set cpu", () => {
    task("solo", () => 1)
    const [t] = getRegisteredTasks()
    expect(taskCpu(t!, false)).toBe(false)
    expect(taskCpu(t!, true)).toBe(true)
  })

  test("group cpu wins over the suite-wide default", () => {
    group("g", () => task("a", () => 1), { cpu: true })
    const [t] = getRegisteredTasks()
    expect(taskCpu(t!, false)).toBe(true)
  })

  test("task cpu wins over its group's and the suite-wide default", () => {
    group(
      "g",
      () => {
        task("a", () => 1, { cpu: false })
      },
      { cpu: true },
    )
    const [t] = getRegisteredTasks()
    expect(taskCpu(t!, true)).toBe(false)
  })
})

describe("bench/registry - taskAlloc", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("falls back to the suite-wide default when neither task nor group set alloc", () => {
    task("solo", () => 1)
    const [t] = getRegisteredTasks()
    expect(taskAlloc(t!, false)).toBe(false)
    expect(taskAlloc(t!, true)).toBe(true)
  })

  test("group alloc wins over the suite-wide default", () => {
    group("g", () => task("a", () => 1), { alloc: true })
    const [t] = getRegisteredTasks()
    expect(taskAlloc(t!, false)).toBe(true)
  })

  test("task alloc wins over its group's and the suite-wide default", () => {
    group(
      "g",
      () => {
        task("a", () => 1, { alloc: false })
      },
      { alloc: true },
    )
    const [t] = getRegisteredTasks()
    expect(taskAlloc(t!, true)).toBe(false)
  })
})

describe("bench/registry - before/after hooks", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("task before/after are recorded on TaskOptions", () => {
    const before = () => 1
    const after = () => 2
    task("t", () => 1, { before, after })
    const [t] = getRegisteredTasks()
    expect(t!.opts?.before).toBe(before)
    expect(t!.opts?.after).toBe(after)
  })

  test("group hooks fire once around the group's first and last measured task", async () => {
    const calls: string[] = []
    group(
      "g",
      () => {
        task("a", () => 1)
        task("b", () => 1)
        task.skip("c", () => 1)
      },
      {
        before: () => void calls.push("before"),
        after: () => void calls.push("after"),
      },
    )
    const tasks = getRegisteredTasks()
    const edges = groupEdges(tasks)
    for (let i = 0; i < tasks.length; i++) {
      const { enter, leave } = edges(i)
      await runGroupHooks(tasks[i]!, "before", enter)
      calls.push(tasks[i]!.name)
      await runGroupHooks(tasks[i]!, "after", leave)
    }
    expect(calls).toEqual(["before", "a", "b", "after", "c"])
  })

  test("an outer group's hooks wrap its nested groups once; inner hooks nest inside", async () => {
    const calls: string[] = []
    const hooks = (name: string) => ({
      before: () => void calls.push(`${name}:before`),
      after: () => void calls.push(`${name}:after`),
    })
    group(
      "outer",
      () => {
        task("o1", () => 1)
        group("x", () => task("x1", () => 1), hooks("x"))
        group("y", () => task("y1", () => 1), hooks("y"))
      },
      hooks("outer"),
    )
    const tasks = getRegisteredTasks()
    const edges = groupEdges(tasks)
    for (let i = 0; i < tasks.length; i++) {
      const { enter, leave } = edges(i)
      await runGroupHooks(tasks[i]!, "before", enter)
      calls.push(tasks[i]!.name)
      await runGroupHooks(tasks[i]!, "after", leave)
    }
    expect(calls).toEqual([
      "outer:before",
      "o1",
      "x:before",
      "x1",
      "x:after",
      "y:before",
      "y1",
      "y:after",
      "outer:after",
    ])
  })

  test("runGroupHooks without paths runs every group's hook, outermost first for before", async () => {
    const calls: string[] = []
    group(
      "a",
      () =>
        group("b", () => task("t", () => 1), {
          before: () => void calls.push("b:before"),
          after: () => void calls.push("b:after"),
        }),
      {
        before: () => void calls.push("a:before"),
        after: () => void calls.push("a:after"),
      },
    )
    const [t] = getRegisteredTasks()
    await runGroupHooks(t!, "before")
    await runGroupHooks(t!, "after")
    expect(calls).toEqual(["a:before", "b:before", "b:after", "a:after"])
  })

  test("a task outside any group has no group hooks", async () => {
    task("solo", () => 1)
    const [t] = getRegisteredTasks()
    expect(t!.groupChain).toBeUndefined()
    await runGroupHooks(t!, "before")
    expect(groupEdges([t!])(0)).toEqual({ enter: [], leave: [] })
  })
})

describe("bench/registry - task.skip / task.only / group.skip / group.only", () => {
  beforeEach(() => {
    resetRegistry()
  })

  test("task.skip() registers with skipped: true", () => {
    task.skip("t", () => 1)
    const [t] = getRegisteredTasks()
    expect(t!.skipped).toBe(true)
    expect(t!.only).toBeUndefined()
  })

  test("task.only() registers with only: true", () => {
    task.only("t", () => 1)
    const [t] = getRegisteredTasks()
    expect(t!.only).toBe(true)
    expect(t!.skipped).toBeUndefined()
  })

  test("a plain task() has neither skipped nor only set", () => {
    task("t", () => 1)
    const [t] = getRegisteredTasks()
    expect(t!.skipped).toBeUndefined()
    expect(t!.only).toBeUndefined()
  })

  test("group.skip() marks every task inside as skipped", () => {
    group.skip("g", () => {
      task("a", () => 1)
      task("b", () => 1)
    })
    const tasks = getRegisteredTasks()
    expect(tasks[0]!.skipped).toBe(true)
    expect(tasks[1]!.skipped).toBe(true)
  })

  test("group.only() marks every task inside as only", () => {
    group.only("g", () => {
      task("a", () => 1)
      task("b", () => 1)
    })
    const tasks = getRegisteredTasks()
    expect(tasks[0]!.only).toBe(true)
    expect(tasks[1]!.only).toBe(true)
  })

  test("group.skip() does not leak into a sibling group", () => {
    group.skip("skipped-group", () => {
      task("a", () => 1)
    })
    group("normal-group", () => {
      task("b", () => 1)
    })
    const tasks = getRegisteredTasks()
    expect(tasks[0]!.skipped).toBe(true)
    expect(tasks[1]!.skipped).toBeUndefined()
  })
})

describe("bench/registry - selectTasks", () => {
  beforeEach(() => {
    resetRegistry()
  })

  function captureStderr(run: () => void): string {
    const write = process.stderr.write
    let out = ""
    process.stderr.write = ((chunk: string) => {
      out += chunk
      return true
    }) as typeof process.stderr.write
    try {
      run()
    } finally {
      process.stderr.write = write
    }
    return out
  }

  test(".only narrows to the marked tasks and announces it", () => {
    task("a", () => 1)
    task.only("b", () => 1)
    let selected: string[] = []
    const out = captureStderr(() => {
      selected = selectTasks(getRegisteredTasks(), undefined, "f.ts").map(
        (t) => t.name,
      )
    })
    expect(selected).toEqual(["b"])
    expect(out).toBe("bench: 1 task(s) selected by .only\n")
  })

  test("announce = false selects the same tasks without the notice", () => {
    task("a", () => 1)
    task.only("b", () => 1)
    let selected: string[] = []
    const out = captureStderr(() => {
      selected = selectTasks(
        getRegisteredTasks(),
        undefined,
        "f.ts",
        false,
      ).map((t) => t.name)
    })
    expect(selected).toEqual(["b"])
    expect(out).toBe("")
  })
})
