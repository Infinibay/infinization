/**
 * CgroupsManager - Manages cgroups v2 operations for VM CPU pinning
 *
 * This service provides CPU affinity control by using Linux cgroups v2 to pin
 * QEMU processes to specific CPU cores. CPU pinning can improve performance by
 * reducing cache misses and ensuring consistent CPU allocation.
 *
 * **Host Requirements:**
 * - Linux kernel with cgroups v2 support (kernel 4.5+, typically enabled by default)
 * - Mounted cgroups v2 unified hierarchy at /sys/fs/cgroup/
 * - Sufficient permissions to create cgroups and move processes
 *
 * @example
 * ```typescript
 * const cgroupsManager = new CgroupsManager()
 * await cgroupsManager.applyCpuPinning(12345, [0, 1, 2])
 * ```
 */

import * as fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import * as path from 'path'
import { CommandExecutor } from '../utils/commandExecutor'
import { Debugger } from '../utils/debug'

/** Base path for cgroups v2 unified hierarchy */
const CGROUPS_V2_BASE = '/sys/fs/cgroup'

/** Controller file that indicates cgroups v2 is active */
const CGROUPS_V2_CONTROLLERS = '/sys/fs/cgroup/cgroup.controllers'

/** Path for Infinization's cgroup slice */
const INFINIZATION_SLICE = '/sys/fs/cgroup/infinization.slice'

/** Outcome of an applyCpuPinning() attempt. `applied` reflects REALITY so the
 *  caller never records requested-but-unhonored cores as if they were honored. */
export interface CpuPinningApplyResult {
  applied: boolean
  reason?: string
}

/**
 * CgroupsManager manages cgroup operations for VM CPU pinning.
 * Uses cgroups v2 API to create scopes and apply CPU affinity.
 */
export class CgroupsManager {
  private executor: CommandExecutor
  private debug: Debugger
  private cgroupsV2Available: boolean | null = null

  constructor () {
    this.executor = new CommandExecutor()
    this.debug = new Debugger('cgroups-manager')
  }

  /**
   * Applies CPU pinning for a process by creating a cgroup and setting CPU affinity.
   *
   * This method is best-effort: if cgroups v2 is unavailable or cgroup operations fail,
   * it logs a warning and returns without throwing. Callers should pre-validate cores
   * using validateCores() if strict validation is required before VM creation.
   *
   * @param pid - Process ID to pin
   * @param cores - Array of CPU core indices (0-based)
   */
  async applyCpuPinning (pid: number, cores: number[]): Promise<CpuPinningApplyResult> {
    this.debug.log(`Applying CPU pinning for PID ${pid} to cores: ${cores.join(',')}`)

    // Check if cgroups v2 is available first
    if (!await this.isCgroupsV2Available()) {
      this.debug.log('warn', 'Cgroups v2 not available, skipping CPU pinning')
      return { applied: false, reason: 'cgroups v2 unavailable' }
    }

    // Validate cores - if invalid, log warning and skip (best-effort)
    try {
      await this.validateCores(cores)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.debug.log('warn', `Invalid CPU cores, skipping pinning: ${reason}`)
      return { applied: false, reason }
    }

    // Create unique scope name for this VM process
    const scopeName = `qemu-${pid}.scope`
    const scopePath = path.join(INFINIZATION_SLICE, scopeName)

    try {
      // Ensure the infinization slice exists
      await this.ensureInfinizationSlice()

      // Create the cgroup scope for this VM
      await this.createCgroupScope(scopePath)

      // Enable cpuset controller in the scope
      await this.enableCpusetController()

      // Set CPU affinity
      await this.setCpuAffinity(scopePath, cores)

      // Move the PID to this cgroup
      await this.movePidToCgroup(scopePath, pid)

      this.debug.log(`CPU pinning applied successfully: PID ${pid} -> cores ${cores.join(',')}`)
      return { applied: true }
    } catch (error) {
      // Clean up on failure, but don't throw - CPU pinning is best-effort. The
      // caller gets applied=false so it can surface the divergence instead of
      // recording the requested cores as if they were honored.
      try {
        await this.removeCgroupScope(scopePath)
      } catch {
        // Ignore cleanup errors
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.debug.log('warn', `Failed to apply CPU pinning: ${reason}`)
      return { applied: false, reason }
    }
  }

  /**
   * Performs opportunistic cleanup of empty cgroup scopes.
   *
   * Since cgroup scopes are named by PID (qemu-{pid}.scope) rather than VM ID,
   * this method scans all scopes under the infinization slice and removes any
   * that have no active processes. This is safe to call at any time as it
   * only removes empty scopes.
   *
   * @returns Number of scopes cleaned up
   */
  async cleanupEmptyScopes (): Promise<number> {
    this.debug.log('Cleaning up empty cgroup scopes')

    if (!await this.isCgroupsV2Available()) {
      return 0
    }

    let cleanedCount = 0

    try {
      if (!await this.pathExists(INFINIZATION_SLICE)) {
        return 0
      }

      const entries = await fs.readdir(INFINIZATION_SLICE)
      for (const entry of entries) {
        if (entry.startsWith('qemu-') && entry.endsWith('.scope')) {
          const scopePath = path.join(INFINIZATION_SLICE, entry)
          // Check if this scope has any active processes
          const procsPath = path.join(scopePath, 'cgroup.procs')
          if (await this.pathExists(procsPath)) {
            const procs = (await fs.readFile(procsPath, 'utf8')).trim()
            if (!procs) {
              // Empty scope, safe to remove
              await this.removeCgroupScope(scopePath)
              cleanedCount++
            }
          }
        }
      }

      if (cleanedCount > 0) {
        this.debug.log(`Cleaned up ${cleanedCount} empty cgroup scope(s)`)
      }
    } catch (error) {
      this.debug.log('warn', `Failed to cleanup empty cgroup scopes: ${error instanceof Error ? error.message : String(error)}`)
    }

    return cleanedCount
  }

  /**
   * Gets the host CPU count.
   *
   * @returns Number of CPUs on the host system
   */
  async getHostCpuCount (): Promise<number> {
    try {
      // Use nproc for reliable CPU count
      const result = await this.executor.execute('nproc', [])
      const count = parseInt(result.trim(), 10)
      if (isNaN(count) || count < 1) {
        throw new Error(`Invalid CPU count from nproc: ${result}`)
      }
      return count
    } catch {
      // Fallback to reading /proc/cpuinfo
      try {
        const cpuinfo = await fs.readFile('/proc/cpuinfo', 'utf8')
        const processors = cpuinfo.match(/^processor\s*:/gm)
        return processors ? processors.length : 1
      } catch {
        this.debug.log('warn', 'Failed to determine host CPU count, defaulting to 1')
        return 1
      }
    }
  }

  /**
   * Validates that all requested cores exist on the host.
   *
   * @param cores - Array of CPU core indices to validate
   * @throws Error if any cores are invalid
   */
  async validateCores (cores: number[]): Promise<void> {
    if (!cores || cores.length === 0) {
      return
    }

    // Remove duplicates and sort
    const uniqueCores = Array.from(new Set(cores)).sort((a, b) => a - b)

    // Check for negative values
    const negativeCores = uniqueCores.filter(c => c < 0)
    if (negativeCores.length > 0) {
      throw new Error(`Invalid negative CPU core indices: ${negativeCores.join(',')}`)
    }

    // Validate against the ONLINE CPU id set, not a bare count. On hosts with
    // offline or sparse CPUs (e.g. ids 0-3,8-11), a count-based check wrongly
    // accepts/rejects ids. Fall back to a 0..count-1 range only if the online set
    // can't be read.
    const onlineCpus = await this.getOnlineCpus()
    if (onlineCpus) {
      const invalidCores = uniqueCores.filter(c => !onlineCpus.has(c))
      if (invalidCores.length > 0) {
        throw new Error(
          `Invalid CPU cores for pinning: ${invalidCores.join(',')}. ` +
          `Online CPUs: ${Array.from(onlineCpus).sort((a, b) => a - b).join(',')}`
        )
      }
    } else {
      const hostCpuCount = await this.getHostCpuCount()
      const invalidCores = uniqueCores.filter(c => c >= hostCpuCount)
      if (invalidCores.length > 0) {
        throw new Error(
          `Invalid CPU cores for pinning: ${invalidCores.join(',')}. ` +
          `Host has ${hostCpuCount} cores (valid range: 0-${hostCpuCount - 1})`
        )
      }
    }
  }

  /**
   * Reads the set of ONLINE CPU ids from /sys/devices/system/cpu/online
   * (e.g. "0-3,8-11" -> {0,1,2,3,8,9,10,11}). Returns null if unreadable.
   */
  private async getOnlineCpus (): Promise<Set<number> | null> {
    try {
      const raw = await fs.readFile('/sys/devices/system/cpu/online', 'utf8')
      return this.parseCpuList(raw.trim())
    } catch {
      return null
    }
  }

  /** Parses a Linux CPU-list string ("0-3,8,10-11") into a Set of ids. */
  private parseCpuList (list: string): Set<number> {
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
   * Returns the NUMA memory node ids that own the given cores, by scanning each
   * node's cpulist under /sys/devices/system/node. Used to set cpuset.mems
   * correctly instead of hardcoding node 0 (which forces all-remote memory for
   * cores on other nodes). Returns ['0'] as a safe fallback when unreadable.
   */
  private async getMemoryNodesForCores (cores: number[]): Promise<string[]> {
    try {
      const nodeDirs = (await fs.readdir('/sys/devices/system/node'))
        .filter(d => /^node\d+$/.test(d))
      const nodes = new Set<number>()
      for (const dir of nodeDirs) {
        const nodeId = parseInt(dir.replace('node', ''), 10)
        try {
          const cpulist = await fs.readFile(`/sys/devices/system/node/${dir}/cpulist`, 'utf8')
          const nodeCpus = this.parseCpuList(cpulist.trim())
          if (cores.some(c => nodeCpus.has(c))) nodes.add(nodeId)
        } catch { /* skip unreadable node */ }
      }
      if (nodes.size > 0) {
        return Array.from(nodes).sort((a, b) => a - b).map(String)
      }
    } catch { /* fall through to fallback */ }
    return ['0']
  }

  /**
   * Helper to check if a path exists using async fs.access.
   */
  private async pathExists (filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Checks if cgroups v2 is available on the system.
   *
   * @returns true if cgroups v2 is mounted and usable
   */
  private async isCgroupsV2Available (): Promise<boolean> {
    // Cache the result to avoid repeated filesystem checks
    if (this.cgroupsV2Available !== null) {
      return this.cgroupsV2Available
    }

    // Check if the cgroups v2 controller file exists
    // This file only exists when cgroups v2 unified hierarchy is active
    if (!await this.pathExists(CGROUPS_V2_CONTROLLERS)) {
      this.debug.log('info', `Cgroups v2 not detected: ${CGROUPS_V2_CONTROLLERS} does not exist`)
      this.cgroupsV2Available = false
      return false
    }

    // Check if cpuset controller is available
    try {
      const controllers = await fs.readFile(CGROUPS_V2_CONTROLLERS, 'utf8')
      if (!controllers.includes('cpuset')) {
        this.debug.log('warn', 'Cgroups v2 available but cpuset controller not enabled')
        this.cgroupsV2Available = false
        return false
      }
    } catch {
      this.debug.log('warn', 'Failed to read cgroups v2 controllers')
      this.cgroupsV2Available = false
      return false
    }

    // Verify we can write to the cgroups hierarchy
    try {
      await fs.access(CGROUPS_V2_BASE, fsConstants.W_OK)
    } catch {
      this.debug.log('warn', `No write access to ${CGROUPS_V2_BASE}`)
      this.cgroupsV2Available = false
      return false
    }

    this.debug.log('info', 'Cgroups v2 available with cpuset controller')
    this.cgroupsV2Available = true
    return true
  }

  /**
   * Ensures the infinization slice directory exists.
   */
  private async ensureInfinizationSlice (): Promise<void> {
    if (await this.pathExists(INFINIZATION_SLICE)) {
      return
    }

    try {
      await fs.mkdir(INFINIZATION_SLICE, { recursive: true })
      this.debug.log(`Created infinization slice: ${INFINIZATION_SLICE}`)

      // Enable cpuset controller for the slice
      await this.enableCpusetInParent()
    } catch (error) {
      throw new Error(`Failed to create infinization slice: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Enables cpuset controller in the parent cgroup.
   * This is required before we can use cpuset in child cgroups.
   */
  private async enableCpusetInParent (): Promise<void> {
    const subtreeControlPath = path.join(CGROUPS_V2_BASE, 'cgroup.subtree_control')
    try {
      // Read current enabled controllers
      const current = await fs.readFile(subtreeControlPath, 'utf8')
      if (current.includes('cpuset')) {
        return // Already enabled
      }

      // Enable cpuset controller
      await fs.writeFile(subtreeControlPath, '+cpuset')
      this.debug.log('Enabled cpuset controller in root cgroup')
    } catch (error) {
      this.debug.log('warn', `Failed to enable cpuset in parent: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Creates a cgroup scope directory.
   *
   * @param scopePath - Full path to the cgroup scope
   */
  private async createCgroupScope (scopePath: string): Promise<void> {
    if (await this.pathExists(scopePath)) {
      this.debug.log(`Cgroup scope already exists: ${scopePath}`)
      return
    }

    try {
      await fs.mkdir(scopePath, { recursive: true })
      this.debug.log(`Created cgroup scope: ${scopePath}`)
    } catch (error) {
      throw new Error(`Failed to create cgroup scope: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Enables the cpuset controller for the infinization slice.
   */
  private async enableCpusetController (): Promise<void> {
    // Enable cpuset in the infinization slice's subtree_control
    const sliceSubtreeControl = path.join(INFINIZATION_SLICE, 'cgroup.subtree_control')
    try {
      const current = await fs.readFile(sliceSubtreeControl, 'utf8')
      if (!current.includes('cpuset')) {
        await fs.writeFile(sliceSubtreeControl, '+cpuset')
        this.debug.log('Enabled cpuset controller in infinization slice')
      }
    } catch (error) {
      this.debug.log('warn', `Failed to enable cpuset in slice: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Sets CPU affinity for a cgroup by writing to cpuset.cpus.
   *
   * @param scopePath - Full path to the cgroup scope
   * @param cores - Array of CPU core indices
   */
  private async setCpuAffinity (scopePath: string, cores: number[]): Promise<void> {
    // Remove duplicates and sort
    const uniqueCores = Array.from(new Set(cores)).sort((a, b) => a - b)

    // Format as comma-separated list (e.g., "0,1,2")
    // Could also use ranges like "0-3" but comma format is clearer
    const cpuList = uniqueCores.join(',')

    const cpusetPath = path.join(scopePath, 'cpuset.cpus')

    try {
      await fs.writeFile(cpusetPath, cpuList)
      this.debug.log(`Set cpuset.cpus=${cpuList} for ${scopePath}`)
    } catch (error) {
      throw new Error(`Failed to set CPU affinity: ${error instanceof Error ? error.message : String(error)}`)
    }

    // cpuset.mems is REQUIRED whenever cpuset.cpus is set. Derive the correct
    // NUMA node(s) for the pinned cores instead of hardcoding '0' — otherwise a
    // VM pinned to non-node-0 cores is forced onto all-remote memory. If the file
    // exists, a failure to write it is fatal for this scope (not swallowed).
    const memsPath = path.join(scopePath, 'cpuset.mems')
    if (await this.pathExists(memsPath)) {
      const mems = (await this.getMemoryNodesForCores(uniqueCores)).join(',')
      try {
        await fs.writeFile(memsPath, mems)
        this.debug.log(`Set cpuset.mems=${mems} for ${scopePath}`)
      } catch (error) {
        throw new Error(`Failed to set cpuset.mems=${mems} (required with cpuset.cpus): ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      this.debug.log('info', 'cpuset.mems not present in this cgroup; skipping')
    }
  }

  /**
   * Moves a process to a cgroup by writing its PID to cgroup.procs.
   *
   * @param scopePath - Full path to the cgroup scope
   * @param pid - Process ID to move
   */
  private async movePidToCgroup (scopePath: string, pid: number): Promise<void> {
    const procsPath = path.join(scopePath, 'cgroup.procs')

    try {
      await fs.writeFile(procsPath, String(pid))
      this.debug.log(`Moved PID ${pid} to cgroup ${scopePath}`)
    } catch (error) {
      throw new Error(`Failed to move process to cgroup: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Removes a cgroup scope directory.
   * The cgroup must be empty (no processes) to be removed.
   *
   * @param scopePath - Full path to the cgroup scope
   */
  private async removeCgroupScope (scopePath: string): Promise<void> {
    if (!await this.pathExists(scopePath)) {
      return
    }

    try {
      // Cgroup directories must be removed with rmdir, not rm -rf
      // They can only be removed when empty
      await fs.rmdir(scopePath)
      this.debug.log(`Removed cgroup scope: ${scopePath}`)
    } catch (error) {
      this.debug.log('warn', `Failed to remove cgroup scope ${scopePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
