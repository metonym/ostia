import { dlopen, FFIType, ptr, read } from "bun:ffi"

/** Reads how many instructions the calling thread has retired in user mode.
 * Only differences between two reads mean anything. */
type InstructionReader = () => number

export type InstructionCounter =
  | { read: InstructionReader; unavailable?: undefined }
  /** Why this machine can't count instructions, for an error message. */
  | { read?: undefined; unavailable: string }

let counter: InstructionCounter | undefined

/** The calling thread's retired-instruction counter: steadier than wall time
 * on a loaded machine, since another process taking the CPU doesn't change
 * what this thread executes. Per thread, user mode only, so neither the
 * kernel's work for a system call nor any other thread's (JIT compiler, GC
 * helpers, I/O pool) counts. Reads the hardware counter through
 * `thread_selfcounts` on macOS and `perf_event_open` on Linux. */
export function instructionCounter(): InstructionCounter {
  counter ??= openCounter()
  return counter
}

function openCounter(): InstructionCounter {
  try {
    if (process.platform === "darwin") return darwinCounter()
    if (process.platform === "linux") return linuxCounter()
  } catch (err) {
    return { unavailable: (err as Error).message }
  }
  return { unavailable: `not supported on ${process.platform}` }
}

// thread_selfcounts(1, ...) fills { instructions, cycles } for the calling
// thread: what `/usr/bin/time -l` totals over a process, read per thread.
function darwinCounter(): InstructionCounter {
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
    thread_selfcounts: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  })
  const counts = new BigUint64Array(2)
  const at = ptr(counts)
  if (symbols.thread_selfcounts(1, at, 16) !== 0 || counts[0] === 0n) {
    return {
      unavailable:
        "thread_selfcounts can't read this Mac's instruction counter (in a VM?)",
    }
  }
  return {
    read: () => {
      symbols.thread_selfcounts(1, at, 16)
      return Number(counts[0])
    },
  }
}

const PERF_EVENT_OPEN: Partial<Record<string, number>> = {
  x64: 298,
  arm64: 241,
}
const PERF_TYPE_HARDWARE = 0
const PERF_COUNT_HW_INSTRUCTIONS = 1
// perf_event_attr's first version, which every kernel since takes.
const PERF_ATTR_SIZE_VER0 = 64
// exclude_kernel | exclude_hv: what `perf_event_paranoid` 2 still allows.
const PERF_USER_ONLY = (1n << 5n) | (1n << 6n)

// An event opened with pid 0 and cpu -1 counts the calling thread, on any
// CPU, from the moment it's opened.
function linuxCounter(): InstructionCounter {
  const nr = PERF_EVENT_OPEN[process.arch]
  if (nr === undefined) {
    return { unavailable: `not supported on linux/${process.arch}` }
  }
  const { symbols } = dlopen("libc.so.6", {
    syscall: {
      args: [
        FFIType.i64,
        FFIType.ptr,
        FFIType.i64,
        FFIType.i64,
        FFIType.i64,
        FFIType.i64,
      ],
      returns: FFIType.i64,
    },
    read: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    __errno_location: { args: [], returns: FFIType.ptr },
  })
  const attr = new BigUint64Array(PERF_ATTR_SIZE_VER0 / 8)
  const head = new Uint32Array(attr.buffer, 0, 2)
  head[0] = PERF_TYPE_HARDWARE
  head[1] = PERF_ATTR_SIZE_VER0
  attr[1] = BigInt(PERF_COUNT_HW_INSTRUCTIONS)
  attr[5] = PERF_USER_ONLY
  const fd = Number(symbols.syscall(nr, ptr(attr), 0, -1, -1, 0))
  if (fd < 0) {
    const errno = read.i32(symbols.__errno_location()!)
    return { unavailable: perfError(errno) }
  }
  const count = new BigUint64Array(1)
  const at = ptr(count)
  if (Number(symbols.read(fd, at, 8)) !== 8) {
    return { unavailable: "perf_event_open's counter couldn't be read" }
  }
  return {
    read: () => {
      symbols.read(fd, at, 8)
      return Number(count[0])
    },
  }
}

function perfError(errno: number): string {
  const base = `perf_event_open failed (errno ${errno})`
  // EACCES, EPERM
  if (errno === 13 || errno === 1) {
    return `${base}: not permitted; set /proc/sys/kernel/perf_event_paranoid to 2 or lower (a container may also need CAP_PERFMON or a seccomp profile that allows it)`
  }
  // ENOENT, ENODEV, EOPNOTSUPP
  if (errno === 2 || errno === 19 || errno === 95) {
    return `${base}: this machine exposes no instruction counter (many VMs and containers don't)`
  }
  return base
}
