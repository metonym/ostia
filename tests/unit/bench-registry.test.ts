import { beforeEach, describe, expect, test } from "bun:test"
import {
  filterTasks,
  getRegisteredTasks,
  group,
  resetRegistry,
  task,
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
    task("tuned", () => 1, { timeBudgetMs: 2000, minSamples: 10 })
    const tasks = getRegisteredTasks()
    expect(tasks[0]!.opts).toBeUndefined()
    expect(tasks[1]!.opts).toEqual({ timeBudgetMs: 2000, minSamples: 10 })
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

  test("nested groups restore the outer group's description", () => {
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
    expect(tasks[0]!.groupName).toBe("inner")
    expect(tasks[0]!.groupDescription).toBeUndefined()
    expect(tasks[1]!.groupName).toBe("outer")
    expect(tasks[1]!.groupDescription).toBe("outer desc")
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
