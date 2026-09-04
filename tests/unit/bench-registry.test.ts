import { beforeEach, describe, expect, test } from "bun:test"
import {
  filterTasks,
  getRegisteredTasks,
  group,
  resetRegistry,
  task,
  taskId,
} from "../../src/bench/registry"

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
