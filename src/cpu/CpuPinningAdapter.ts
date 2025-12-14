/**
 * CpuPinningAdapter - Adapts CPU pinning strategies for direct QEMU execution
 *
 * This adapter bridges the gap between libvirt-style CPU pinning strategies
 * (which generate XML configurations) and direct QEMU execution. It translates
 * pinning configurations to `numactl` arguments that wrap the QEMU process.
 *
 * Using `numactl` as a wrapper provides:
 * - CPU affinity via --physcpubind (pins vCPU threads to specific cores)
 * - Memory placement via --membind (allocates memory from specific NUMA nodes)
 *
 * This approach is preferred over post-launch pinning (taskset/cgroups) because:
 * - Memory is allocated on the correct NUMA node from the start
 * - Reduces memory migration overhead during VM operation
 * - Better cache locality for memory-intensive workloads
 *
 * @example
 * ```typescript
 * const adapter = new CpuPinningAdapter()
 * const result = adapter.generatePinningCommand(4, 'basic')
 * // result: { wrapperCommand: 'numactl', wrapperArgs: ['--physcpubind=0,1,2,3', '--membind=0'], ... }
 * ```
 */

import * as fs from 'fs'
import * as path from 'path'
import { Debugger } from '../utils/debug'
import { CommandExecutor } from '../utils/commandExecutor'
import {
  calculateBasicPinning,
  calculateHybridPinning,
  normalizeMapTopology,
  NormalizedNumaTopology,
  HybridPinningOptions,
  SeededRandom
} from './SharedAlgorithms'

/**
 * Result of generating CPU pinning command wrapper
 */
export interface CpuPinningResult {
  /** Wrapper command (e.g., 'numactl') or null if no pinning */
  wrapperCommand: string | null
  /** Arguments for the wrapper command */
  wrapperArgs: string[]
  /** Original QEMU command */
  originalCommand: string
  /** Original QEMU arguments */
  originalArgs: string[]
  /** Whether pinning was applied */
  pinningApplied: boolean
  /** CPU cores used for pinning */
  pinnedCores: number[]
  /** NUMA nodes used for memory binding */
  numaNodes: number[]
  /** Seed used for hybrid pinning (for reproducibility logging) */
  hybridSeed?: number
}

/**
 * NUMA topology information for the host system
 */
export interface NumaTopology {
  /** Map of node ID to array of CPU core indices */
  nodes: Map<number, number[]>
  /** Total number of CPUs across all nodes */
  totalCpus: number
  /** Whether the system has multiple NUMA nodes */
  isNumaSystem: boolean
}

/**
 * CPU pinning strategy type
 * - 'basic': Sequential pinning across NUMA nodes with optimal distribution
 * - 'hybrid': Randomized distribution across nodes (better for mixed workloads)
 * - 'none': No pinning applied
 */
export type PinningStrategy = 'basic' | 'hybrid' | 'none'

/**
 * Options for CPU pinning generation
 */
export interface CpuPinningOptions {
  /**
   * Seed for deterministic hybrid pinning.
   * When provided, hybrid pinning will produce the same result for the same inputs.
   * Useful for reproducibility in performance analysis.
   */
  seed?: number
}

/**
 * CpuPinningAdapter translates high-level pinning strategies to numactl commands
 */
export class CpuPinningAdapter {
  private debug: Debugger
  private executor: CommandExecutor
  private numaTopologyCache: NumaTopology | null = null
  private numactlAvailable: boolean | null = null

  constructor () {
    this.debug = new Debugger('cpu-pinning-adapter')
    this.executor = new CommandExecutor()
  }

  /**
   * Generates a CPU pinning command wrapper for QEMU
   *
   * @param vcpuCount - Number of virtual CPUs for the VM
   * @param strategy - Pinning strategy to use
   * @param originalCommand - Original QEMU command (e.g., 'qemu-system-x86_64')
   * @param originalArgs - Original QEMU arguments
   * @param options - Optional configuration for pinning behavior
   * @returns CpuPinningResult with wrapper command and arguments
   */
  async generatePinningCommand (
    vcpuCount: number,
    strategy: PinningStrategy,
    originalCommand: string,
    originalArgs: string[],
    options?: CpuPinningOptions
  ): Promise<CpuPinningResult> {
    // Early return if no pinning requested
    if (strategy === 'none' || vcpuCount <= 0) {
      return {
        wrapperCommand: null,
        wrapperArgs: [],
        originalCommand,
        originalArgs,
        pinningApplied: false,
        pinnedCores: [],
        numaNodes: []
      }
    }

    // Check if numactl is available
    if (!await this.isNumactlAvailable()) {
      this.debug.log('warn', 'numactl not available, CPU pinning will be skipped')
      return {
        wrapperCommand: null,
        wrapperArgs: [],
        originalCommand,
        originalArgs,
        pinningApplied: false,
        pinnedCores: [],
        numaNodes: []
      }
    }

    // Get NUMA topology
    const topology = await this.getNumaTopology()
    if (topology.totalCpus === 0) {
      this.debug.log('warn', 'No CPUs detected in NUMA topology, skipping pinning')
      return {
        wrapperCommand: null,
        wrapperArgs: [],
        originalCommand,
        originalArgs,
        pinningApplied: false,
        pinnedCores: [],
        numaNodes: []
      }
    }

    // Calculate pinning based on strategy using shared algorithms
    const normalized = normalizeMapTopology(topology.nodes)
    let pinning: { cores: number[]; nodes: number[] }
    let hybridSeed: number | undefined

    if (strategy === 'hybrid') {
      const hybridOptions: HybridPinningOptions = {}
      if (options?.seed !== undefined) {
        hybridOptions.seed = options.seed
        hybridSeed = options.seed
        this.debug.log('info', `Using deterministic hybrid pinning with seed: ${options.seed}`)
      } else {
        // Generate and log seed for reproducibility
        const rng = new SeededRandom()
        hybridSeed = rng.getSeed()
        hybridOptions.seed = hybridSeed
        this.debug.log('info', `Hybrid pinning using auto-generated seed: ${hybridSeed}`)
      }

      const allocation = calculateHybridPinning(vcpuCount, normalized, hybridOptions)
      pinning = {
        cores: allocation.selectedCores,
        nodes: allocation.usedNodes
      }
    } else {
      const allocation = calculateBasicPinning(vcpuCount, normalized)
      pinning = {
        cores: allocation.selectedCores,
        nodes: allocation.usedNodes
      }
    }

    // Generate numactl arguments
    const wrapperArgs = this.generateNumactlArgs(pinning.cores, pinning.nodes)

    this.debug.log(`CPU pinning: ${vcpuCount} vCPUs -> cores [${pinning.cores.join(',')}], NUMA nodes [${pinning.nodes.join(',')}]`)

    return {
      wrapperCommand: 'numactl',
      wrapperArgs,
      originalCommand,
      originalArgs,
      pinningApplied: true,
      pinnedCores: pinning.cores,
      numaNodes: pinning.nodes,
      hybridSeed
    }
  }

  /**
   * Generates numactl arguments from pinning configuration
   *
   * @param cores - Array of CPU core indices to pin to
   * @param nodes - Array of NUMA node IDs for memory binding
   * @returns Array of numactl arguments
   */
  generateNumactlArgs (cores: number[], nodes: number[]): string[] {
    const args: string[] = []

    if (cores.length > 0) {
      // --physcpubind pins the process to specific physical CPUs
      args.push(`--physcpubind=${cores.join(',')}`)
    }

    if (nodes.length > 0) {
      // --membind allocates memory only from specified NUMA nodes
      args.push(`--membind=${nodes.join(',')}`)
    }

    return args
  }

  /**
   * Gets the NUMA topology of the host system
   *
   * @returns NumaTopology object
   */
  async getNumaTopology (): Promise<NumaTopology> {
    // Return cached topology if available
    if (this.numaTopologyCache !== null) {
      return this.numaTopologyCache
    }

    const topology: NumaTopology = {
      nodes: new Map(),
      totalCpus: 0,
      isNumaSystem: false
    }

    const nodesDir = '/sys/devices/system/node/'

    try {
      // Check if NUMA directory exists
      if (!fs.existsSync(nodesDir)) {
        this.debug.log('info', 'NUMA sysfs not found, assuming single node system')
        // Fall back to /proc/cpuinfo for CPU count
        const cpuCount = await this.getCpuCountFromProc()
        topology.nodes.set(0, Array.from({ length: cpuCount }, (_, i) => i))
        topology.totalCpus = cpuCount
        topology.isNumaSystem = false
        this.numaTopologyCache = topology
        return topology
      }

      // Read NUMA node directories
      const nodeDirs = fs.readdirSync(nodesDir).filter(dir => dir.startsWith('node'))

      if (nodeDirs.length === 0) {
        this.debug.log('warn', 'No NUMA nodes found in sysfs')
        this.numaTopologyCache = topology
        return topology
      }

      topology.isNumaSystem = nodeDirs.length > 1

      for (const nodeDir of nodeDirs) {
        const nodeId = parseInt(nodeDir.replace('node', ''), 10)
        if (isNaN(nodeId)) continue

        const cpuListPath = path.join(nodesDir, nodeDir, 'cpulist')
        if (!fs.existsSync(cpuListPath)) continue

        const cpuList = fs.readFileSync(cpuListPath, 'utf8').trim()
        const cpus = this.expandCpuList(cpuList)

        topology.nodes.set(nodeId, cpus)
        topology.totalCpus += cpus.length
      }

      this.debug.log(`NUMA topology: ${topology.nodes.size} node(s), ${topology.totalCpus} total CPUs`)
      topology.nodes.forEach((cpus, nodeId) => {
        this.debug.log(`  Node ${nodeId}: CPUs [${cpus.join(',')}]`)
      })

      this.numaTopologyCache = topology
      return topology
    } catch (error) {
      this.debug.log('error', `Failed to read NUMA topology: ${error instanceof Error ? error.message : String(error)}`)
      this.numaTopologyCache = topology
      return topology
    }
  }

  /**
   * Expands a CPU list string (e.g., "0-3,5,7-9") into an array of CPU indices
   *
   * @param cpuList - CPU list string from sysfs
   * @returns Array of CPU indices
   */
  private expandCpuList (cpuList: string): number[] {
    if (!cpuList || cpuList.trim() === '') return []

    const cpus: number[] = []
    const ranges = cpuList.split(',')

    for (const range of ranges) {
      const trimmed = range.trim()
      if (trimmed.includes('-')) {
        const [startStr, endStr] = trimmed.split('-')
        const start = parseInt(startStr, 10)
        const end = parseInt(endStr, 10)
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            cpus.push(i)
          }
        }
      } else {
        const cpu = parseInt(trimmed, 10)
        if (!isNaN(cpu)) {
          cpus.push(cpu)
        }
      }
    }

    return cpus
  }

  /**
   * Gets CPU count from /proc/cpuinfo as fallback
   */
  private async getCpuCountFromProc (): Promise<number> {
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8')
      const processors = cpuinfo.match(/^processor\s*:/gm)
      return processors ? processors.length : 1
    } catch {
      this.debug.log('warn', 'Failed to read /proc/cpuinfo, defaulting to 1 CPU')
      return 1
    }
  }

  /**
   * Checks if numactl is available on the system
   *
   * @returns true if numactl is available
   */
  async isNumactlAvailable (): Promise<boolean> {
    if (this.numactlAvailable !== null) {
      return this.numactlAvailable
    }

    try {
      await this.executor.execute('which', ['numactl'])
      this.debug.log('info', 'numactl is available')
      this.numactlAvailable = true
      return true
    } catch {
      this.debug.log('warn', 'numactl is not installed. Install with: apt install numactl')
      this.numactlAvailable = false
      return false
    }
  }

  /**
   * Validates that requested cores exist on the host
   *
   * @param cores - Array of CPU core indices to validate
   * @throws Error if any cores are invalid
   */
  async validateCores (cores: number[]): Promise<void> {
    if (!cores || cores.length === 0) return

    const topology = await this.getNumaTopology()
    const allCores: Set<number> = new Set()
    topology.nodes.forEach(nodeCores => {
      nodeCores.forEach(core => allCores.add(core))
    })

    const invalidCores = cores.filter(c => !allCores.has(c))
    if (invalidCores.length > 0) {
      throw new Error(
        `Invalid CPU cores: ${invalidCores.join(',')}. ` +
        `Valid cores: ${Array.from(allCores).sort((a, b) => a - b).join(',')}`
      )
    }
  }

  /**
   * Clears cached NUMA topology (useful for testing or system changes)
   */
  clearCache (): void {
    this.numaTopologyCache = null
    this.numactlAvailable = null
  }
}
