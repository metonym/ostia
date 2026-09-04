export interface RegisteredTask {
  groupName?: string
  name: string
  fn: () => unknown | Promise<unknown>
}

const tasks: RegisteredTask[] = []
let currentGroup: string | undefined

export function group(name: string, fn: () => void): void {
  const previous = currentGroup
  currentGroup = name
  try {
    fn()
  } finally {
    currentGroup = previous
  }
}

export function task(name: string, fn: () => unknown | Promise<unknown>): void {
  tasks.push({ groupName: currentGroup, name, fn })
}

export function getRegisteredTasks(): readonly RegisteredTask[] {
  return tasks
}

export function resetRegistry(): void {
  tasks.length = 0
  currentGroup = undefined
}
