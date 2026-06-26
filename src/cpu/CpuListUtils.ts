/**
 * CpuListUtils - Shared helpers for reading and parsing Linux CPU-list strings.
 *
 * The kernel exposes CPU sets as comma-separated range lists (e.g. "0-3,8,10-11")
 * in several sysfs files. Two consumers need identical parsing + the same notion
 * of which CPUs are actually ONLINE:
 *   - CgroupsManager (post-launch cpuset pinning) — already hardened.
 *   - CpuPinningAdapter (numactl --physcpubind wrapper) — historically NOT, which
 *     let an offline/hot-unplugged core be emitted to numactl, making the whole
 *     VM start hard-fail (numactl exits non-zero on an offline --physcpubind id).
 *
 * Centralizing the logic here keeps the two paths symmetric: both validate
 * against /sys/devices/system/cpu/online rather than against merely-PRESENT cpus.
 *
 * @module CpuListUtils
 */

import * as fs from 'fs/promises'

/** Path that lists the host's ONLINE CPU ids (cpu-list format). */
export const ONLINE_CPUS_PATH = '/sys/devices/system/cpu/online'

/**
 * Parses a Linux CPU-list string ("0-3,8,10-11") into a Set of ids.
 * Tolerant of empty fields, surrounding whitespace, and malformed ranges
 * (those are skipped rather than throwing).
 */
export function parseCpuList (list: string): Set<number> {
  const result = new Set<number>()
  for (const part of list.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(n => parseInt(n, 10))
      if (!isNaN(start) && !isNaN(end) && start <= end) {
        for (let i = start; i <= end; i++) result.add(i)
      }
    } else {
      const n = parseInt(trimmed, 10)
      if (!isNaN(n)) result.add(n)
    }
  }
  return result
}

/**
 * Reads the set of ONLINE CPU ids from `onlinePath`
 * (default /sys/devices/system/cpu/online), e.g. "0-3,8-11" -> {0..3,8..11}.
 * Returns null if the file is unreadable (so callers can fall back to a
 * present-CPU / count-based check rather than failing closed).
 */
export async function getOnlineCpus (onlinePath: string = ONLINE_CPUS_PATH): Promise<Set<number> | null> {
  try {
    const raw = await fs.readFile(onlinePath, 'utf8')
    return parseCpuList(raw.trim())
  } catch {
    return null
  }
}
