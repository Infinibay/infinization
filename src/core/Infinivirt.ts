/**
 * Infinivirt - Main Public API for VM Management
 *
 * This is the primary entry point for the infinivirt library.
 * It manages shared resources (database, event handling, health monitoring)
 * and provides a clean interface for VM lifecycle operations.
 *
 * Note: Pass your application's PrismaClient singleton for connection pooling.
 * Infinivirt does not create or manage its own Prisma instance.
 *
 * @example
 * ```typescript
 * import { PrismaClient } from '@prisma/client'
 * import { Infinivirt } from '@infinibay/infinivirt'
 * import { getEventManager } from '@backend/services/EventManager'
 *
 * // Use your application's Prisma singleton
 * const prisma = new PrismaClient()
 *
 * const infinivirt = new Infinivirt({
 *   prismaClient: prisma,
 *   eventManager: getEventManager(),
 *   healthMonitorInterval: 30000
 * })
 *
 * await infinivirt.initialize()
 *
 * const result = await infinivirt.createVM({
 *   vmId: 'machine-uuid-from-db',
 *   name: 'test-vm',
 *   internalName: 'vm-abc123',
 *   os: 'ubuntu',
 *   cpuCores: 4,
 *   ramGB: 8,
 *   diskSizeGB: 50,
 *   bridge: 'virbr0',
 *   displayType: 'spice',
 *   displayPort: 5901
 * })
 *
 * console.log('VM created:', result.vmId)
 *
 * // Later, cleanup
 * await infinivirt.stopVM(result.vmId)
 * await infinivirt.shutdown()
 * ```
 */

import { VMLifecycle } from './VMLifecycle'
import { PrismaAdapter } from '../db/PrismaAdapter'
import { EventHandler } from '../sync/EventHandler'
import { HealthMonitor } from '../sync/HealthMonitor'
import { NftablesService } from '../network/NftablesService'
import { Debugger } from '../utils/debug'
import {
  InfinivirtConfig,
  VMCreateConfig,
  VMCreateResult,
  VMStartConfig,
  VMStopConfig,
  VMOperationResult,
  VMStatusResult,
  ActiveVMResources,
  EventManagerLike,
  LifecycleError,
  LifecycleErrorCode,
  DEFAULT_QMP_SOCKET_DIR,
  DEFAULT_DISK_DIR,
  DEFAULT_PIDFILE_DIR
} from '../types/lifecycle.types'
import { DEFAULT_HEALTH_CHECK_INTERVAL } from '../types/sync.types'

/**
 * Minimal Prisma client interface for initialization.
 * Uses 'unknown' to allow any Prisma client to be passed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaClientLike = any

/**
 * Infinivirt is the main public API for VM management.
 *
 * It handles:
 * - Automatic nftables initialization
 * - Health monitoring for crash detection
 * - Event emission to backend
 * - Centralized resource management
 * - Clean interface for VM operations
 */
export class Infinivirt {
  private readonly debug: Debugger
  private readonly config: InfinivirtConfig
  private prisma!: PrismaAdapter
  private eventHandler!: EventHandler
  private healthMonitor!: HealthMonitor
  private nftables!: NftablesService
  private eventManager?: EventManagerLike
  private activeVMs: Map<string, ActiveVMResources> = new Map()
  private initialized: boolean = false
  private externalPrisma: boolean = false

  // Configuration directories
  private readonly diskDir: string
  private readonly qmpSocketDir: string
  private readonly pidfileDir: string

  /**
   * Creates a new Infinivirt instance.
   *
   * @param config - Configuration options (prismaClient is required)
   */
  constructor (config: InfinivirtConfig) {
    this.debug = new Debugger('infinivirt')
    this.config = config
    this.eventManager = config.eventManager

    // Configure directories
    this.diskDir = config.diskDir ?? DEFAULT_DISK_DIR
    this.qmpSocketDir = config.qmpSocketDir ?? DEFAULT_QMP_SOCKET_DIR
    this.pidfileDir = config.pidfileDir ?? DEFAULT_PIDFILE_DIR

    this.debug.log('Infinivirt instance created')
  }

  // ===========================================================================
  // Initialization & Lifecycle
  // ===========================================================================

  /**
   * Initializes the Infinivirt system.
   *
   * - Creates/configures database adapter
   * - Initializes nftables infrastructure
   * - Starts health monitoring (if enabled)
   *
   * @throws Error if initialization fails
   */
  async initialize (): Promise<void> {
    if (this.initialized) {
      this.debug.log('Already initialized')
      return
    }

    this.debug.log('Initializing Infinivirt')

    try {
      // Initialize Prisma adapter (prismaClient is required)
      if (!this.config.prismaClient) {
        throw new LifecycleError(
          LifecycleErrorCode.INVALID_CONFIG,
          'prismaClient is required in InfinivirtConfig'
        )
      }
      this.prisma = new PrismaAdapter(this.config.prismaClient as PrismaClientLike)
      this.externalPrisma = true
      this.debug.log('Using external Prisma client')

      // Initialize EventHandler
      this.eventHandler = new EventHandler(this.prisma, {
        enableLogging: true,
        emitCustomEvents: true
      })
      this.debug.log('EventHandler initialized')

      // Initialize HealthMonitor
      const healthInterval = this.config.healthMonitorInterval ?? DEFAULT_HEALTH_CHECK_INTERVAL
      this.healthMonitor = new HealthMonitor(this.prisma, {
        checkIntervalMs: healthInterval,
        enableCleanup: true,
        onCrashDetected: async (vmId: string) => {
          this.debug.log(`Crash detected for VM: ${vmId}`)
          this.activeVMs.delete(vmId)
          // Emit crash event to backend
          if (this.eventManager?.emitCRUD) {
            this.eventManager.emitCRUD('machines', 'crash', vmId)
          }
        }
      })
      this.debug.log('HealthMonitor initialized')

      // Initialize nftables infrastructure
      this.nftables = new NftablesService()
      await this.nftables.initialize()
      this.debug.log('Nftables infrastructure initialized')

      // Start health monitoring if enabled
      const autoStart = this.config.autoStartHealthMonitor ?? true
      if (autoStart) {
        await this.healthMonitor.start()
        this.debug.log('HealthMonitor started')
      }

      this.initialized = true
      this.debug.log('Infinivirt initialized successfully')
    } catch (error) {
      this.debug.log('error', `Initialization failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /**
   * Shuts down the Infinivirt system.
   *
   * - Stops health monitoring
   * - Detaches all event handlers
   * - Disconnects all QMP clients
   * - Clears active VMs map
   * - Closes database connection (if owned)
   */
  async shutdown (): Promise<void> {
    this.debug.log('Shutting down Infinivirt')

    // Stop health monitor
    if (this.healthMonitor) {
      await this.healthMonitor.stop()
      this.debug.log('HealthMonitor stopped')
    }

    // Detach all event handlers
    if (this.eventHandler) {
      await this.eventHandler.detachAll()
      this.debug.log('EventHandler detached from all VMs')
    }

    // Clear active VMs
    this.activeVMs.clear()

    // Disconnect Prisma if we own it
    if (!this.externalPrisma && this.prisma) {
      // If we created the Prisma client, we should disconnect it
      // For now, we always use external client so this won't run
    }

    this.initialized = false
    this.debug.log('Infinivirt shutdown complete')
  }

  /**
   * Checks if the system is initialized.
   */
  isInitialized (): boolean {
    return this.initialized
  }

  // ===========================================================================
  // VM Operations
  // ===========================================================================

  /**
   * Creates and starts a new VM.
   *
   * @param config - VM creation configuration
   * @returns VMCreateResult with all created resource details
   * @throws LifecycleError on failure
   */
  async createVM (config: VMCreateConfig): Promise<VMCreateResult> {
    this.ensureInitialized()

    const lifecycle = this.createLifecycle()
    const result = await lifecycle.create(config)

    // Track the VM
    this.trackVM(result.vmId, {
      tapDevice: result.tapDevice,
      createdAt: new Date(),
      internalName: config.internalName
    })

    return result
  }

  /**
   * Starts an existing VM.
   *
   * Reconstructs QEMU process from persisted configuration and starts the VM.
   *
   * @param vmId - VM identifier (database machine.id)
   * @param config - Optional start configuration
   * @returns VMOperationResult indicating success or failure
   */
  async startVM (vmId: string, config?: VMStartConfig): Promise<VMOperationResult> {
    this.ensureInitialized()

    const lifecycle = this.createLifecycle()
    const result = await lifecycle.start(vmId, config)

    if (result.success) {
      // Get internalName from DB for tracking
      const internalName = await this.prisma.getMachineInternalName(vmId)

      // Track or update the VM
      this.trackVM(vmId, {
        createdAt: new Date(),
        internalName: internalName ?? vmId
      })
    }

    return result
  }

  /**
   * Stops a running VM.
   *
   * @param vmId - VM identifier
   * @param config - Stop configuration
   * @returns VMOperationResult indicating success or failure
   */
  async stopVM (vmId: string, config?: VMStopConfig): Promise<VMOperationResult> {
    this.ensureInitialized()

    const lifecycle = this.createLifecycle()
    const result = await lifecycle.stop(vmId, config)

    if (result.success) {
      this.untrackVM(vmId)
    }

    return result
  }

  /**
   * Restarts a VM.
   *
   * @param vmId - VM identifier
   * @returns VMOperationResult indicating success or failure
   */
  async restartVM (vmId: string): Promise<VMOperationResult> {
    this.ensureInitialized()

    const lifecycle = this.createLifecycle()
    return lifecycle.restart(vmId)
  }

  /**
   * Suspends a running VM.
   *
   * @param vmId - VM identifier
   * @returns VMOperationResult indicating success or failure
   */
  async suspendVM (vmId: string): Promise<VMOperationResult> {
    this.ensureInitialized()

    const lifecycle = this.createLifecycle()
    return lifecycle.suspend(vmId)
  }

  /**
   * Resumes a suspended VM.
   *
   * @param vmId - VM identifier
   * @returns VMOperationResult indicating success or failure
   */
  async resumeVM (vmId: string): Promise<VMOperationResult> {
    this.ensureInitialized()

    const lifecycle = this.createLifecycle()
    return lifecycle.resume(vmId)
  }

  /**
   * Resets a VM (hardware reset).
   *
   * @param vmId - VM identifier
   * @returns VMOperationResult indicating success or failure
   */
  async resetVM (vmId: string): Promise<VMOperationResult> {
    this.ensureInitialized()

    const lifecycle = this.createLifecycle()
    return lifecycle.reset(vmId)
  }

  /**
   * Gets detailed status of a VM.
   *
   * @param vmId - VM identifier
   * @returns VMStatusResult with detailed status information
   */
  async getVMStatus (vmId: string): Promise<VMStatusResult> {
    this.ensureInitialized()

    const lifecycle = this.createLifecycle()
    return lifecycle.getStatus(vmId)
  }

  // ===========================================================================
  // Resource Access
  // ===========================================================================

  /**
   * Gets the list of active VM IDs tracked by this instance.
   */
  getActiveVMs (): string[] {
    return Array.from(this.activeVMs.keys())
  }

  /**
   * Gets the HealthMonitor instance.
   */
  getHealthMonitor (): HealthMonitor {
    this.ensureInitialized()
    return this.healthMonitor
  }

  /**
   * Gets the EventHandler instance.
   */
  getEventHandler (): EventHandler {
    this.ensureInitialized()
    return this.eventHandler
  }

  /**
   * Gets the PrismaAdapter instance.
   */
  getPrismaAdapter (): PrismaAdapter {
    this.ensureInitialized()
    return this.prisma
  }

  /**
   * Gets the NftablesService instance.
   */
  getNftablesService (): NftablesService {
    this.ensureInitialized()
    return this.nftables
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Ensures the system is initialized before operations.
   */
  private ensureInitialized (): void {
    if (!this.initialized) {
      throw new LifecycleError(
        LifecycleErrorCode.INVALID_STATE,
        'Infinivirt not initialized. Call initialize() first.'
      )
    }
  }

  /**
   * Creates a VMLifecycle instance with current dependencies.
   */
  private createLifecycle (): VMLifecycle {
    return new VMLifecycle(
      this.prisma,
      this.eventHandler,
      this.eventManager,
      {
        diskDir: this.diskDir,
        qmpSocketDir: this.qmpSocketDir,
        pidfileDir: this.pidfileDir
      }
    )
  }

  /**
   * Tracks a VM in the active VMs map.
   */
  private trackVM (vmId: string, resources: Omit<ActiveVMResources, 'createdAt'> & { createdAt?: Date }): void {
    this.activeVMs.set(vmId, {
      ...resources,
      createdAt: resources.createdAt ?? new Date()
    })
    this.debug.log(`Tracking VM: ${vmId}`)
  }

  /**
   * Removes a VM from the active VMs map.
   */
  private untrackVM (vmId: string): void {
    this.activeVMs.delete(vmId)
    this.debug.log(`Untracking VM: ${vmId}`)
  }
}
