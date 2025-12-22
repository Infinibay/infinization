/**
 * VMLifecycle - Orchestrates VM lifecycle operations
 *
 * This class coordinates all components required for VM operations:
 * - QemuProcess for QEMU process management
 * - QMPClient for VM control via QMP protocol
 * - TapDeviceManager for network device setup
 * - NftablesService for firewall management
 * - QemuImgService for disk operations
 * - PrismaAdapter for database operations
 * - EventHandler for event monitoring
 *
 * @example
 * ```typescript
 * const lifecycle = new VMLifecycle(prismaAdapter, eventHandler)
 *
 * const result = await lifecycle.create({
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
 * await lifecycle.stop(result.vmId, { graceful: true, timeout: 30000 })
 * ```
 */

import * as fs from 'fs'
import * as path from 'path'
import { QemuProcess } from './QemuProcess'
import { QMPClient } from './QMPClient'
import { QemuCommandBuilder } from './QemuCommandBuilder'
import { TapDeviceManager } from '../network/TapDeviceManager'
import { NftablesService } from '../network/NftablesService'
import { MacAddressGenerator } from '../network/MacAddressGenerator'
import { QemuImgService } from '../storage/QemuImgService'
import { SpiceConfig } from '../display/SpiceConfig'
import { VncConfig } from '../display/VncConfig'
import { SPICE_MIN_PORT, SPICE_MAX_PORT } from '../types/display.types'
import { PrismaAdapter } from '../db/PrismaAdapter'
import { EventHandler } from '../sync/EventHandler'
import { Debugger } from '../utils/debug'
import { sleep } from '../utils/retry'
import {
  VMCreateConfig,
  VMCreateResult,
  VMStartConfig,
  VMStopConfig,
  VMOperationResult,
  VMStatusResult,
  LifecycleError,
  LifecycleErrorCode,
  EventManagerLike,
  DEFAULT_STOP_TIMEOUT,
  DEFAULT_BOOT_TIMEOUT,
  DEFAULT_QMP_CONNECT_TIMEOUT,
  DEFAULT_QMP_SOCKET_DIR,
  DEFAULT_DISK_DIR,
  DEFAULT_PIDFILE_DIR,
  DEFAULT_NETWORK_MODEL,
  DEFAULT_DISK_FORMAT,
  DEFAULT_DISK_BUS,
  DEFAULT_DISK_CACHE,
  RESTART_DELAY_MS,
  PROCESS_EXIT_POLL_INTERVAL,
  RUNTIME_DISK_SIZE_PLACEHOLDER_GB
} from '../types/lifecycle.types'
import { FirewallRuleInput } from '../types/firewall.types'
import { PrismaAdapterError, PrismaAdapterErrorCode } from '../types/db.types'
import { UnattendedInstaller } from '../unattended/UnattendedInstaller'
import { CgroupsManager } from '../system/CgroupsManager'
import { detectOSType, getDriverPreset } from '../config/DriverPresets'

/**
 * Cleanup resources for partial failure recovery
 */
interface CleanupResources {
  tapDevice?: string
  vmId?: string
  diskPaths?: string[]
  qmpSocketPath?: string
  pidFilePath?: string
  qemuProcess?: QemuProcess
  qmpClient?: QMPClient
  /** Path to installation ISO for cleanup */
  installationIsoPath?: string
  /** Path to guest agent socket for cleanup */
  guestAgentSocketPath?: string
  /** Path to infini service socket for cleanup */
  infiniServiceSocketPath?: string
}

/**
 * VMLifecycle orchestrates all VM operations by coordinating
 * QEMU processes, QMP communication, networking, storage, and firewall components.
 */
export class VMLifecycle {
  private readonly debug: Debugger
  private readonly prisma: PrismaAdapter
  private readonly eventHandler: EventHandler
  private readonly eventManager?: EventManagerLike
  private readonly diskDir: string
  private readonly qmpSocketDir: string
  private readonly pidfileDir: string

  // Service instances (created per operation)
  private readonly tapManager: TapDeviceManager
  private readonly nftables: NftablesService
  private readonly qemuImg: QemuImgService
  private readonly cgroupsManager: CgroupsManager

  /**
   * Creates a new VMLifecycle instance
   *
   * @param prisma - PrismaAdapter for database operations
   * @param eventHandler - EventHandler for QMP event monitoring
   * @param eventManager - Optional backend EventManager for event emission
   * @param options - Optional configuration overrides
   */
  constructor (
    prisma: PrismaAdapter,
    eventHandler: EventHandler,
    eventManager?: EventManagerLike,
    options?: {
      diskDir?: string
      qmpSocketDir?: string
      pidfileDir?: string
    }
  ) {
    this.debug = new Debugger('vm-lifecycle')
    this.prisma = prisma
    this.eventHandler = eventHandler
    this.eventManager = eventManager

    // Configure directories
    this.diskDir = options?.diskDir ?? DEFAULT_DISK_DIR
    this.qmpSocketDir = options?.qmpSocketDir ?? DEFAULT_QMP_SOCKET_DIR
    this.pidfileDir = options?.pidfileDir ?? DEFAULT_PIDFILE_DIR

    // Initialize service instances
    this.tapManager = new TapDeviceManager()
    this.nftables = new NftablesService()
    this.qemuImg = new QemuImgService()
    this.cgroupsManager = new CgroupsManager()

    this.debug.log('VMLifecycle initialized')
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Creates and starts a new VM.
   *
   * Creates disk image, TAP device, firewall chain, QEMU process,
   * connects QMP, updates database, and attaches event handler.
   *
   * Unattended installation is configured via the `unattendedInstall` field
   * in the config object. When provided, a custom ISO will be generated
   * with automated installation configuration.
   *
   * @param config - VM creation configuration (includes optional unattendedInstall)
   * @returns VMCreateResult with all created resource details
   * @throws LifecycleError on failure (with automatic cleanup)
   *
   * @example
   * ```typescript
   * // Without unattended installation
   * await lifecycle.create({ vmId: '...', name: 'vm1', ... })
   *
   * // With unattended installation
   * await lifecycle.create({
   *   vmId: '...',
   *   name: 'vm1',
   *   os: 'ubuntu',
   *   // ... other config
   *   unattendedInstall: {
   *     vmId: '...',
   *     os: 'ubuntu',  // Must match config.os
   *     username: 'admin',
   *     password: 'secure123'
   *   }
   * })
   * ```
   */
  async create (config: VMCreateConfig): Promise<VMCreateResult> {
    this.debug.log(`Creating VM: ${config.name} (${config.internalName}) [DB ID: ${config.vmId}]`)

    // Validate configuration
    this.validateCreateConfig(config)

    // Validate CPU pinning if provided (early validation before resource allocation)
    if (config.cpuPinning && config.cpuPinning.length > 0) {
      try {
        await this.cgroupsManager.validateCores(config.cpuPinning)
      } catch (error) {
        throw new LifecycleError(
          LifecycleErrorCode.INVALID_CONFIG,
          error instanceof Error ? error.message : String(error),
          config.vmId,
          { requestedCores: config.cpuPinning }
        )
      }
    }

    // vmId is the database machine.id, internalName is used for resource naming
    const vmId = config.vmId

    // Generate paths using internalName (not vmId) for filesystem resources
    const paths = this.generatePaths(config.internalName, config.disks.length)

    // Track resources for cleanup on failure
    const resources: CleanupResources = {
      vmId,
      diskPaths: paths.diskPaths,
      qmpSocketPath: paths.qmpSocketPath,
      pidFilePath: paths.pidFilePath,
      guestAgentSocketPath: config.guestAgentSocketPath,
      infiniServiceSocketPath: config.infiniServiceSocketPath
    }

    try {
      // 1. Ensure directories exist
      await this.ensureDirectories()

      // 1a. Clean up orphan resources if they exist (from previous failed create or crash)
      // This handles cases where a VM with the same internalName was partially created
      if (fs.existsSync(paths.qmpSocketPath)) {
        this.debug.log('warn', `Found existing QMP socket: ${paths.qmpSocketPath}, removing orphan socket`)
        try {
          fs.unlinkSync(paths.qmpSocketPath)
          this.debug.log('info', `Removed orphan QMP socket: ${paths.qmpSocketPath}`)
        } catch (unlinkError) {
          this.debug.log('error', `Failed to remove orphan QMP socket: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`)
        }
      }

      if (fs.existsSync(paths.pidFilePath)) {
        this.debug.log('warn', `Found existing PID file: ${paths.pidFilePath}, checking if process is alive`)
        try {
          const pidContent = fs.readFileSync(paths.pidFilePath, 'utf8').trim()
          const existingPid = parseInt(pidContent, 10)

          if (!isNaN(existingPid) && existingPid > 0) {
            try {
              process.kill(existingPid, 0)
              // Process is alive - conflict
              throw new LifecycleError(
                LifecycleErrorCode.CREATE_FAILED,
                `A QEMU process (PID ${existingPid}) is already running with internalName '${config.internalName}'. ` +
                `This may indicate a duplicate VM or orphaned process. ` +
                `If you are sure no QEMU process should be running, manually remove: ${paths.pidFilePath}`,
                vmId,
                { existingPid, pidFilePath: paths.pidFilePath, internalName: config.internalName }
              )
            } catch (killError) {
              if ((killError as NodeJS.ErrnoException).code === 'ESRCH') {
                this.debug.log('info', `Process ${existingPid} is dead, removing orphan PID file`)
                fs.unlinkSync(paths.pidFilePath)
                this.debug.log('info', `Removed orphan PID file: ${paths.pidFilePath}`)
              } else {
                throw killError
              }
            }
          } else {
            this.debug.log('warn', `PID file contains invalid content: "${pidContent}", removing`)
            fs.unlinkSync(paths.pidFilePath)
          }
        } catch (readError) {
          if (readError instanceof LifecycleError) {
            throw readError
          }
          this.debug.log('warn', `Error reading PID file: ${readError instanceof Error ? readError.message : String(readError)}`)
          try {
            fs.unlinkSync(paths.pidFilePath)
            this.debug.log('info', `Removed unreadable PID file: ${paths.pidFilePath}`)
          } catch (unlinkError) {
            this.debug.log('error', `Failed to remove orphan PID file: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`)
          }
        }
      }

      // 2. Create disk images
      this.debug.log(`Creating ${config.disks.length} disk image(s)`)
      for (let i = 0; i < config.disks.length; i++) {
        const diskConfig = config.disks[i]
        const diskPath = paths.diskPaths[i]

        this.debug.log(`Creating disk ${i}: ${diskPath} (${diskConfig.sizeGB}GB)`)
        await this.qemuImg.createImage({
          path: diskPath,
          sizeGB: diskConfig.sizeGB,
          format: diskConfig.format ?? DEFAULT_DISK_FORMAT,
          preallocation: 'metadata'
        })
      }

      // 3. Generate MAC address if not provided
      const macAddress = config.macAddress ?? MacAddressGenerator.generateFromVmId(vmId)
      this.debug.log(`MAC address: ${macAddress}`)

      // 4. Create and configure TAP device
      // Note: tapManager.create() proactively cleans up orphaned TAP devices (persist on + no carrier)
      // before creating the new device, preventing network connectivity issues from stale devices
      this.debug.log(`Preparing network resources for VM: ${vmId}`)
      const tapDevice = await this.tapManager.create(vmId, config.bridge)
      resources.tapDevice = tapDevice
      await this.tapManager.configure(tapDevice, config.bridge)
      this.debug.log(`TAP device ${tapDevice} configured successfully for VM: ${vmId}`)

      // 5. Fetch and apply firewall rules
      this.debug.log(`Configuring firewall for VM: ${vmId}`)
      await this.nftables.createVMChain(vmId, tapDevice)
      const firewallRules = await this.fetchFirewallRules(vmId)
      if (firewallRules.department.length > 0 || firewallRules.vm.length > 0) {
        await this.nftables.applyRules(
          vmId,
          tapDevice,
          firewallRules.department,
          firewallRules.vm
        )
      }

      // 6. Handle unattended installation ISO generation (if configured)
      let installationIsoPath: string | undefined
      let unattendedInstaller: UnattendedInstaller | undefined

      if (config.unattendedInstall) {
        // Validate that unattendedInstall.os matches config.os
        // This prevents generating the wrong ISO (e.g., Ubuntu ISO for a Windows VM)
        const vmOs = config.os.toLowerCase()
        const unattendedOs = config.unattendedInstall.os.toLowerCase()

        // Map VM OS names to unattended OS types for comparison
        const osMatches = (
          (vmOs === unattendedOs) ||
          (vmOs.includes('ubuntu') && unattendedOs === 'ubuntu') ||
          (vmOs.includes('windows') && (unattendedOs === 'windows10' || unattendedOs === 'windows11')) ||
          (vmOs.includes('fedora') && unattendedOs === 'fedora') ||
          ((vmOs.includes('redhat') || vmOs.includes('rhel')) && unattendedOs === 'fedora')
        )

        if (!osMatches) {
          throw new LifecycleError(
            LifecycleErrorCode.INVALID_CONFIG,
            `Unattended installation OS mismatch: VM os='${config.os}' but unattendedInstall.os='${config.unattendedInstall.os}'. ` +
            `These must match to ensure the correct installation ISO is generated.`,
            vmId,
            { vmOs: config.os, unattendedOs: config.unattendedInstall.os }
          )
        }

        this.debug.log('Generating unattended installation ISO')

        // Ensure the unattendedInstall config has the correct vmId
        const unattendedConfig = {
          ...config.unattendedInstall,
          vmId: config.unattendedInstall.vmId || vmId
        }

        unattendedInstaller = new UnattendedInstaller(unattendedConfig)
        installationIsoPath = await unattendedInstaller.generateInstallationISO()
        resources.installationIsoPath = installationIsoPath

        this.debug.log(`Installation ISO generated: ${installationIsoPath}`)
      }

      // 7. Apply OS-specific driver presets and build QEMU command
      // Detect OS type and apply driver preset with fallback chain:
      // explicit config → OS preset → hardcoded default
      //
      // Note: Presets apply to disk and network MODEL configuration only.
      // networkQueues uses CPU-based auto-calculation (not preset values).
      // displayProtocol in presets is advisory-only (displayType is required in config).
      const osType = detectOSType(config.os)
      const preset = getDriverPreset(osType)
      this.debug.log(`Applying driver preset for OS type: ${osType}`)

      // Apply preset values with fallback chain (disk/network model only)
      const presetMachineType = config.machineType ?? 'q35'
      const presetCpuModel = config.cpuModel ?? 'host'
      const presetDiskBus = config.diskBus ?? preset.diskBus
      const presetDiskCacheMode = config.diskCacheMode ?? preset.diskCacheMode
      const presetNetworkModel = config.networkModel ?? preset.networkModel
      // networkQueues: pass through explicit config or null for CPU-based auto-calculation
      // Preset networkQueues values are advisory-only and not applied automatically
      const presetNetworkQueues = config.networkQueues ?? null

      // Compute effective values using validation methods (same as start() does for restarts)
      const effectiveMachineType = this.validateMachineType(presetMachineType)
      const effectiveCpuModel = presetCpuModel
      const effectiveDiskBus = this.validateDiskBus(presetDiskBus)
      const effectiveDiskCacheMode = this.validateDiskCacheMode(presetDiskCacheMode)
      const effectiveNetworkModel = this.validateNetworkModel(presetNetworkModel)
      // Calculate network queues: explicit config takes precedence, otherwise auto-calculate from CPU cores
      const effectiveNetworkQueues = this.calculateNetworkQueues(config.cpuCores, presetNetworkQueues)
      const effectiveMemoryBalloon = config.memoryBalloon ?? false

      // Validate UEFI firmware at creation time - coerce invalid paths to BIOS mode (null)
      // This ensures the database always reflects the actual boot mode that will be used
      const effectiveUefiFirmware = this.validateUefiFirmware(config.uefiFirmware)

      // Validate hugepages at creation time - check availability and coerce to false if unavailable
      const effectiveHugepages = this.validateHugepages(config.hugepages)

      // Validate display port at creation time - ensure it's within valid range and available
      const validatedDisplayPort = this.validateDisplayPort(config.displayPort)
      const effectiveDisplayPort = await this.findAvailableDisplayPort(validatedDisplayPort)

      const qemuConfig = {
        machineType: effectiveMachineType,
        cpuModel: effectiveCpuModel,
        diskBus: effectiveDiskBus,
        diskCacheMode: effectiveDiskCacheMode,
        networkModel: effectiveNetworkModel,
        networkQueues: effectiveNetworkQueues,
        memoryBalloon: effectiveMemoryBalloon,
        uefiFirmware: effectiveUefiFirmware,
        hugepages: effectiveHugepages,
        displayPort: effectiveDisplayPort,
        enableNumaCtlPinning: config.enableNumaCtlPinning,
        cpuPinningStrategy: config.cpuPinningStrategy
      }

      const commandBuilder = this.buildQemuCommand(
        config,
        paths.diskPaths,
        paths.qmpSocketPath,
        paths.pidFilePath,
        tapDevice,
        macAddress,
        qemuConfig
      )

      // 7a. Mount installation ISO if unattended installation is configured
      if (unattendedInstaller && installationIsoPath) {
        unattendedInstaller.mountInstallationMedia(commandBuilder, installationIsoPath)
        this.debug.log('Installation media mounted in QEMU command')
      }

      // 8. Create and start QEMU process
      this.debug.log(`Starting QEMU process for VM: ${vmId}`)
      const qemuProcess = new QemuProcess(vmId, commandBuilder)
      qemuProcess.setQmpSocketPath(paths.qmpSocketPath)
      qemuProcess.setPidFilePath(paths.pidFilePath)
      resources.qemuProcess = qemuProcess
      await qemuProcess.start()

      const pid = qemuProcess.getPid()
      if (!pid) {
        throw new LifecycleError(
          LifecycleErrorCode.PROCESS_ERROR,
          'QEMU process started but PID not available',
          vmId
        )
      }
      this.debug.log(`QEMU process started with PID: ${pid}`)

      // 8a. Verify TAP device connection (QEMU should have attached to the TAP device)
      this.debug.log(`Verifying TAP device connection: ${tapDevice}`)
      await this.verifyTapConnection(tapDevice, vmId, pid, config.bridge)
      this.debug.log(`TAP device ${tapDevice} has carrier - QEMU connected successfully`)

      // 8b. Apply CPU pinning if configured (best-effort, applyCpuPinning handles errors internally)
      if (config.cpuPinning && config.cpuPinning.length > 0) {
        this.debug.log(`Applying CPU pinning for VM ${vmId}: cores ${config.cpuPinning.join(',')}`)
        await this.cgroupsManager.applyCpuPinning(pid, config.cpuPinning)
      }

      // 9. Wait for QMP socket and connect
      this.debug.log(`Connecting to QMP socket: ${paths.qmpSocketPath}`)
      await this.waitForSocket(paths.qmpSocketPath)
      const qmpClient = new QMPClient(paths.qmpSocketPath, {
        connectTimeout: DEFAULT_QMP_CONNECT_TIMEOUT,
        reconnect: true,
        maxReconnectAttempts: 3
      })
      resources.qmpClient = qmpClient
      await qmpClient.connect()

      // 9. Verify VM status via QMP
      const status = await qmpClient.queryStatus()
      this.debug.log(`QMP status: ${status.status}`)

      // 10. Update database configuration
      await this.prisma.updateMachineConfiguration(vmId, {
        qmpSocketPath: paths.qmpSocketPath,
        qemuPid: pid,
        tapDeviceName: tapDevice,
        graphicProtocol: config.displayType,
        graphicPort: effectiveDisplayPort,
        graphicPassword: config.displayPassword ?? null,
        graphicHost: config.displayAddr ?? '0.0.0.0',
        // Store effective QEMU driver configuration (validated values, matching runtime behavior)
        bridge: config.bridge,
        machineType: effectiveMachineType,
        cpuModel: effectiveCpuModel,
        diskBus: effectiveDiskBus,
        diskCacheMode: effectiveDiskCacheMode,
        networkModel: effectiveNetworkModel,
        networkQueues: effectiveNetworkQueues,
        memoryBalloon: effectiveMemoryBalloon,
        // Store disk paths for multi-disk support
        diskPaths: paths.diskPaths,
        // Store validated UEFI firmware (null if invalid/missing, normalized path if valid)
        uefiFirmware: effectiveUefiFirmware,
        // Store hugepages configuration (validated - true only if available on host)
        hugepages: effectiveHugepages,
        // Store CPU pinning configuration
        cpuPinning: config.cpuPinning && config.cpuPinning.length > 0
          ? { cores: config.cpuPinning }
          : null,
        // Store advanced device configuration
        tpmSocketPath: config.tpmSocketPath ?? null,
        guestAgentSocketPath: config.guestAgentSocketPath ?? null,
        infiniServiceSocketPath: config.infiniServiceSocketPath ?? null,
        virtioDriversIso: config.virtioDriversIso ?? null,
        enableAudio: config.enableAudio ?? false,
        enableUsbTablet: config.enableUsbTablet ?? config.os.toLowerCase().includes('windows')
      })

      // 11. Update database status
      await this.prisma.updateMachineStatus(vmId, 'running')

      // 12. Attach event handler for monitoring
      await this.eventHandler.attachToVM(vmId, qmpClient)

      // 13. Emit event to backend
      this.emitEvent('machines', 'create', vmId, { pid, tapDevice })

      // 14. Start unattended installation monitoring (if configured)
      const isInstallingOS = !!(unattendedInstaller && installationIsoPath)
      if (unattendedInstaller && installationIsoPath && qmpClient) {
        this.debug.log('Starting unattended installation monitoring')

        // Monitor installation in background (don't await, let VM creation complete)
        // The caller can track installation via events or status checks
        unattendedInstaller.monitorInstallation(qmpClient, installationIsoPath)
          .then((result) => {
            if (result.success) {
              this.debug.log(`Unattended installation completed successfully for VM: ${vmId}`)
              this.emitEvent('machines', 'update', vmId, {
                type: 'installation_complete',
                duration: result.duration
              })
            } else {
              this.debug.log('error', `Unattended installation failed for VM: ${vmId}`)
              this.emitEvent('machines', 'update', vmId, {
                type: 'installation_failed',
                error: result.error?.message
              })
            }
          })
          .catch((err) => {
            this.debug.log('error', `Unattended installation monitoring error: ${err instanceof Error ? err.message : String(err)}`)
          })
      }

      this.debug.log(`VM created successfully: ${vmId}`)

      return {
        vmId,
        tapDevice,
        qmpSocketPath: paths.qmpSocketPath,
        displayPort: effectiveDisplayPort,
        pid,
        diskPaths: paths.diskPaths,
        pidFilePath: paths.pidFilePath,
        success: true,
        installationIsoPath,
        installingOS: isInstallingOS
      }
    } catch (error) {
      this.debug.log('error', `Failed to create VM: ${error instanceof Error ? error.message : String(error)}`)
      await this.cleanup(resources)
      throw this.wrapError(error, LifecycleErrorCode.CREATE_FAILED, vmId)
    }
  }

  /**
   * Starts an existing VM.
   *
   * Reconstructs QEMU command from persisted configuration,
   * spawns QEMU process, connects QMP, and updates database.
   *
   * @param vmId - VM identifier (database machine.id)
   * @param config - Optional start configuration
   * @returns VMOperationResult indicating success or failure
   */
  async start (vmId: string, _config?: VMStartConfig): Promise<VMOperationResult> {
    this.debug.log(`Starting VM: ${vmId}`)
    const timestamp = new Date()

    // Track resources for cleanup on failure
    const resources: CleanupResources = { vmId }

    try {
      // 1. Fetch VM configuration from database (initial check)
      const initialVmConfig = await this.prisma.findMachineWithConfig(vmId)
      if (!initialVmConfig) {
        throw new LifecycleError(
          LifecycleErrorCode.VM_NOT_FOUND,
          `VM not found: ${vmId}`,
          vmId
        )
      }

      // 2. Check if already running
      if (initialVmConfig.status === 'running') {
        const pid = initialVmConfig.configuration?.qemuPid
        if (pid && this.isProcessAlive(pid)) {
          return {
            success: true,
            message: `VM ${vmId} is already running`,
            vmId,
            timestamp
          }
        }
        // Process is dead but DB says running - update status and continue
        // Use volatile clear to preserve tapDeviceName for potential reuse
        await this.prisma.updateMachineStatus(vmId, 'off')
        await this.prisma.clearVolatileMachineConfiguration(vmId)
        this.debug.log(`VM ${vmId} was marked running but process dead, resetting (TAP preserved)`)
      }

      // 3. Atomically transition status from 'off' to 'starting' with optimistic locking
      // This prevents duplicate QEMU processes if multiple start requests arrive simultaneously
      let vmConfig = initialVmConfig
      const expectedStatus = initialVmConfig.status === 'running' ? 'off' : initialVmConfig.status
      if (expectedStatus === 'off') {
        try {
          const transitionResult = await this.prisma.transitionVMStatus(
            vmId,
            'off',
            'starting',
            initialVmConfig.version
          )
          vmConfig = transitionResult.vmConfig
          this.debug.log(`VM ${vmId} status transitioned to 'starting' (version: ${transitionResult.newVersion})`)
        } catch (error) {
          // Handle concurrent modification - another process is already starting this VM
          if (error instanceof PrismaAdapterError && error.code === PrismaAdapterErrorCode.VERSION_CONFLICT) {
            this.debug.log('warn', `VM ${vmId} start request rejected: concurrent modification detected`)
            throw new LifecycleError(
              LifecycleErrorCode.CONCURRENT_MODIFICATION,
              `VM ${vmId} is being started by another process`,
              vmId,
              { originalError: error.message }
            )
          }
          throw error
        }
      }

      // 4. Validate required hardware configuration exists
      if (!vmConfig.cpuCores || !vmConfig.ramGB || !vmConfig.internalName) {
        throw new LifecycleError(
          LifecycleErrorCode.INVALID_CONFIG,
          `VM ${vmId} missing required hardware configuration (cpuCores, ramGB, or internalName)`,
          vmId,
          { cpuCores: vmConfig.cpuCores, ramGB: vmConfig.ramGB, internalName: vmConfig.internalName }
        )
      }

      // 5. Get disk paths from database or generate from internalName (backward compatibility)
      let diskPaths: string[]
      if (vmConfig.configuration?.diskPaths && Array.isArray(vmConfig.configuration.diskPaths) && vmConfig.configuration.diskPaths.length > 0) {
        // Use stored disk paths (multi-disk VMs)
        diskPaths = vmConfig.configuration.diskPaths
        this.debug.log(`Using stored disk paths: ${diskPaths.join(', ')}`)
      } else {
        // Legacy single-disk VM - compute path from internalName
        const legacyPaths = this.generatePaths(vmConfig.internalName, 1)
        diskPaths = legacyPaths.diskPaths
        this.debug.log(`Using legacy single-disk path: ${diskPaths[0]}`)

        // Migrate legacy VM by persisting computed disk paths to database
        // This ensures future starts use the stored paths directly
        try {
          await this.prisma.updateMachineConfiguration(vmId, { diskPaths })
          this.debug.log(`Migrated legacy VM ${vmId}: stored disk paths in database`)
        } catch (migrationError) {
          // Log warning but don't block VM start if migration write fails
          this.debug.log('warn', `Failed to migrate legacy VM disk paths for ${vmId}: ${migrationError instanceof Error ? migrationError.message : String(migrationError)}`)
        }
      }

      const qmpSocketPath = path.join(this.qmpSocketDir, `${vmConfig.internalName}.sock`)
      const pidFilePath = path.join(this.pidfileDir, `${vmConfig.internalName}.pid`)

      // 5a. Clean up orphan QMP socket if exists (from crashed QEMU or unclean shutdown)
      // This prevents QEMU from failing to start or connection issues
      if (fs.existsSync(qmpSocketPath)) {
        this.debug.log('warn', `Found existing QMP socket: ${qmpSocketPath}, removing orphan socket`)
        try {
          fs.unlinkSync(qmpSocketPath)
          this.debug.log('info', `Removed orphan QMP socket: ${qmpSocketPath}`)
        } catch (unlinkError) {
          this.debug.log('error', `Failed to remove orphan QMP socket: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`)
        }
      }

      // 5b. Clean up orphan PID file if exists (from crashed QEMU or unclean shutdown)
      // QEMU uses flock() on the PID file, so if a previous process crashed, the lock
      // is released but the file may remain. If a process is still alive, we should not
      // attempt to start a duplicate VM.
      if (fs.existsSync(pidFilePath)) {
        this.debug.log('warn', `Found existing PID file: ${pidFilePath}, checking if process is alive`)
        try {
          const pidContent = fs.readFileSync(pidFilePath, 'utf8').trim()
          const existingPid = parseInt(pidContent, 10)

          if (!isNaN(existingPid) && existingPid > 0) {
            // Check if process with this PID is still alive
            try {
              process.kill(existingPid, 0) // Signal 0 = just check if process exists
              // Process is alive - this is a real conflict
              throw new LifecycleError(
                LifecycleErrorCode.START_FAILED,
                `VM ${vmId} appears to have a running QEMU process (PID ${existingPid}) that is not tracked. ` +
                `This may indicate a previous crash or unclean shutdown. ` +
                `If you are sure no QEMU process is running for this VM, manually remove: ${pidFilePath}`,
                vmId,
                { existingPid, pidFilePath }
              )
            } catch (killError) {
              if ((killError as NodeJS.ErrnoException).code === 'ESRCH') {
                // Process not found (ESRCH) - safe to remove orphan PID file
                this.debug.log('info', `Process ${existingPid} is dead, removing orphan PID file`)
                fs.unlinkSync(pidFilePath)
                this.debug.log('info', `Removed orphan PID file: ${pidFilePath}`)
              } else {
                // Re-throw LifecycleError or other errors
                throw killError
              }
            }
          } else {
            // Invalid PID content - safe to remove
            this.debug.log('warn', `PID file contains invalid content: "${pidContent}", removing`)
            fs.unlinkSync(pidFilePath)
          }
        } catch (readError) {
          if (readError instanceof LifecycleError) {
            throw readError
          }
          // Error reading PID file - try to remove it anyway
          this.debug.log('warn', `Error reading PID file: ${readError instanceof Error ? readError.message : String(readError)}`)
          try {
            fs.unlinkSync(pidFilePath)
            this.debug.log('info', `Removed unreadable PID file: ${pidFilePath}`)
          } catch (unlinkError) {
            this.debug.log('error', `Failed to remove orphan PID file: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`)
          }
        }
      }

      resources.diskPaths = diskPaths
      resources.qmpSocketPath = qmpSocketPath
      resources.pidFilePath = pidFilePath
      resources.guestAgentSocketPath = vmConfig.configuration?.guestAgentSocketPath ?? undefined

      // 5c. Ensure InfiniService socket path exists (generate if not in database)
      // This handles VMs created before the InfiniService socket feature was added,
      // or VMs where the socket path was cleared by the migration script.
      let infiniServiceSocketPath = vmConfig.configuration?.infiniServiceSocketPath
      if (!infiniServiceSocketPath) {
        infiniServiceSocketPath = path.join(this.qmpSocketDir, `${vmId}.socket`)
        this.debug.log('info', `Generated InfiniService socket path for VM ${vmId}: ${infiniServiceSocketPath}`)
        // Persist the generated path so future restarts use the same path
        await this.prisma.updateMachineConfiguration(vmId, { infiniServiceSocketPath })
      }
      resources.infiniServiceSocketPath = infiniServiceSocketPath

      // 6. Ensure directories exist
      await this.ensureDirectories()

      // 7. Verify all disks exist
      for (let i = 0; i < diskPaths.length; i++) {
        if (!fs.existsSync(diskPaths[i])) {
          throw new LifecycleError(
            LifecycleErrorCode.DISK_ERROR,
            `Disk image ${i} not found: ${diskPaths[i]}`,
            vmId,
            { diskPath: diskPaths[i], diskIndex: i }
          )
        }
      }

      // 8. Get display configuration
      const displayProtocol = (vmConfig.configuration?.graphicProtocol as 'spice' | 'vnc') ?? 'spice'
      const displayPassword = vmConfig.configuration?.graphicPassword ?? undefined
      const displayAddr = vmConfig.configuration?.graphicHost ?? '0.0.0.0'

      // 8a. Find an available display port (always start from SPICE_MIN_PORT)
      const displayPort = await this.findAvailableDisplayPort(SPICE_MIN_PORT)

      // 8b. Update database with allocated port (for UI display)
      this.debug.log('info', `Allocated display port: ${displayPort}`)
      await this.prisma.updateMachineConfiguration(vmId, { graphicPort: displayPort })

      // 9. Generate MAC address deterministically from vmId
      const macAddress = MacAddressGenerator.generateFromVmId(vmId)
      this.debug.log(`MAC address: ${macAddress}`)

      // 10. Get network bridge from configuration with fallback to default
      const bridge = vmConfig.configuration?.bridge ?? 'virbr0'

      // 11. Create or reuse TAP device (persistent TAP support)
      // Check if a TAP device was preserved from a previous stop (persistent lifecycle)
      let tapDevice: string
      const existingTapDevice = vmConfig.configuration?.tapDeviceName

      if (existingTapDevice && await this.tapManager.exists(existingTapDevice)) {
        // Reuse existing TAP device - just reattach to bridge
        this.debug.log(`Reattaching TAP device ${existingTapDevice} for VM: ${vmId}`)

        // Check if TAP already has carrier (unexpected in start - could indicate stale QEMU)
        const hasCarrierBefore = await this.tapManager.hasCarrier(existingTapDevice)
        if (hasCarrierBefore) {
          this.debug.log('warn', `TAP device ${existingTapDevice} already has carrier, possible stale QEMU process`)
        }

        tapDevice = existingTapDevice
        await this.tapManager.attachToBridge(tapDevice, bridge)
        this.debug.log(`TAP device ${tapDevice} reattached to bridge ${bridge}`)
      } else {
        // Create new TAP device (first start or after host reboot)
        // Note: tapManager.create() proactively cleans up orphaned TAP devices
        this.debug.log(`Creating new TAP device for VM: ${vmId}`)
        tapDevice = await this.tapManager.create(vmId, bridge)
        await this.tapManager.configure(tapDevice, bridge)
        this.debug.log(`TAP device ${tapDevice} created and configured for VM: ${vmId}`)

        // Store TAP device name for persistence across stop/start cycles
        await this.prisma.updateMachineConfiguration(vmId, { tapDeviceName: tapDevice })
      }
      resources.tapDevice = tapDevice

      // 12. Setup firewall (persistent chain support)
      // Chain persists across stop/start - only jump rules are attached/detached
      this.debug.log(`Configuring firewall for VM: ${vmId}`)
      await this.nftables.ensureVMChain(vmId) // Idempotent - creates chain if not exists
      await this.nftables.attachJumpRules(vmId, tapDevice) // Connect TAP to persistent chain

      const firewallRules = await this.fetchFirewallRules(vmId)
      if (firewallRules.department.length > 0 || firewallRules.vm.length > 0) {
        // Use applyRulesIfChanged for optimization - skips re-apply if rules unchanged
        const { changed } = await this.nftables.applyRulesIfChanged(
          vmId,
          tapDevice,
          firewallRules.department,
          firewallRules.vm
        )
        if (!changed) {
          this.debug.log(`Firewall rules unchanged for VM ${vmId}, skipped re-apply`)
        }
      }

      // 13. Build QEMU command from stored configuration
      // Create disk configs for each disk path. During start, disk size is not used for
      // actual operations (disks already exist), but must be positive for type consistency.
      // Use RUNTIME_DISK_SIZE_PLACEHOLDER_GB for all disks as a valid placeholder value.
      const diskConfigs = diskPaths.map(() => ({
        sizeGB: RUNTIME_DISK_SIZE_PLACEHOLDER_GB,
        format: 'qcow2' as const,
        bus: vmConfig.configuration?.diskBus ?? undefined,
        cache: vmConfig.configuration?.diskCacheMode ?? undefined
      }))

      const createConfig: VMCreateConfig = {
        vmId,
        name: vmConfig.name,
        internalName: vmConfig.internalName,
        os: vmConfig.os,
        cpuCores: vmConfig.cpuCores,
        ramGB: vmConfig.ramGB,
        disks: diskConfigs,
        bridge,
        macAddress,
        displayType: displayProtocol,
        displayPort,
        displayPassword,
        displayAddr,
        gpuPciAddress: vmConfig.gpuPciAddress ?? undefined
        // Note: ISO not included for start - VM should boot from disk
      }

      // 13a. Compute effective QEMU configuration values (validated with defaults)
      const effectiveMachineType = this.validateMachineType(vmConfig.configuration?.machineType)
      const effectiveCpuModel = vmConfig.configuration?.cpuModel ?? 'host'
      const effectiveDiskBus = this.validateDiskBus(vmConfig.configuration?.diskBus)
      const effectiveDiskCacheMode = this.validateDiskCacheMode(vmConfig.configuration?.diskCacheMode)
      const effectiveNetworkModel = this.validateNetworkModel(vmConfig.configuration?.networkModel)
      const effectiveMemoryBalloon = vmConfig.configuration?.memoryBalloon ?? false

      const commandBuilder = this.buildQemuCommand(
        createConfig,
        diskPaths,
        qmpSocketPath,
        pidFilePath,
        tapDevice,
        macAddress,
        {
          machineType: effectiveMachineType,
          cpuModel: effectiveCpuModel,
          diskBus: effectiveDiskBus,
          diskCacheMode: effectiveDiskCacheMode,
          networkModel: effectiveNetworkModel,
          networkQueues: vmConfig.configuration?.networkQueues,
          memoryBalloon: effectiveMemoryBalloon,
          uefiFirmware: vmConfig.configuration?.uefiFirmware,
          hugepages: vmConfig.configuration?.hugepages,
          displayPort, // Already validated above
          // Advanced device configuration from database
          tpmSocketPath: vmConfig.configuration?.tpmSocketPath,
          guestAgentSocketPath: vmConfig.configuration?.guestAgentSocketPath,
          // Use locally generated/stored infiniServiceSocketPath (includes fallback generation)
          infiniServiceSocketPath,
          virtioDriversIso: vmConfig.configuration?.virtioDriversIso,
          enableAudio: vmConfig.configuration?.enableAudio,
          enableUsbTablet: vmConfig.configuration?.enableUsbTablet,
          // CPU pinning configuration
          enableNumaCtlPinning: vmConfig.configuration?.enableNumaCtlPinning,
          cpuPinningStrategy: this.validateCpuPinningStrategy(vmConfig.configuration?.cpuPinningStrategy)
        }
      )

      // 14. Create and start QEMU process
      this.debug.log(`Starting QEMU process for VM: ${vmId}`)
      const qemuProcess = new QemuProcess(vmId, commandBuilder)
      qemuProcess.setQmpSocketPath(qmpSocketPath)
      qemuProcess.setPidFilePath(pidFilePath)
      resources.qemuProcess = qemuProcess
      await qemuProcess.start()

      const pid = qemuProcess.getPid()
      if (!pid) {
        throw new LifecycleError(
          LifecycleErrorCode.PROCESS_ERROR,
          'QEMU process started but PID not available',
          vmId
        )
      }
      this.debug.log(`QEMU process started with PID: ${pid}`)

      // 14a. Verify TAP device connection (QEMU should have attached to the TAP device)
      this.debug.log(`Verifying TAP device connection: ${tapDevice}`)
      await this.verifyTapConnection(tapDevice, vmId, pid, bridge)
      this.debug.log(`TAP device ${tapDevice} has carrier - QEMU connected successfully`)

      // 14b. Apply CPU pinning if configured (best-effort, applyCpuPinning handles errors internally)
      if (vmConfig.configuration?.cpuPinning?.cores && vmConfig.configuration.cpuPinning.cores.length > 0) {
        this.debug.log(`Applying CPU pinning for VM ${vmId}: cores ${vmConfig.configuration.cpuPinning.cores.join(',')}`)
        await this.cgroupsManager.applyCpuPinning(pid, vmConfig.configuration.cpuPinning.cores)
      }

      // 15. Wait for QMP socket and connect
      this.debug.log(`Connecting to QMP socket: ${qmpSocketPath}`)
      await this.waitForSocket(qmpSocketPath)
      const qmpClient = new QMPClient(qmpSocketPath, {
        connectTimeout: DEFAULT_QMP_CONNECT_TIMEOUT,
        reconnect: true,
        maxReconnectAttempts: 3
      })
      resources.qmpClient = qmpClient
      await qmpClient.connect()

      // 16. Verify VM status via QMP
      const status = await qmpClient.queryStatus()
      this.debug.log(`QMP status: ${status.status}`)

      // 17. Update database configuration with runtime values
      await this.prisma.updateMachineConfiguration(vmId, {
        qmpSocketPath,
        qemuPid: pid,
        tapDeviceName: tapDevice,
        graphicProtocol: displayProtocol,
        graphicPort: displayPort,
        graphicPassword: displayPassword ?? null,
        graphicHost: displayAddr,
        // Persist effective QEMU configuration used for this boot
        bridge,
        machineType: effectiveMachineType,
        cpuModel: effectiveCpuModel,
        diskBus: effectiveDiskBus,
        diskCacheMode: effectiveDiskCacheMode,
        networkModel: effectiveNetworkModel,
        networkQueues: vmConfig.configuration?.networkQueues ?? null,
        memoryBalloon: effectiveMemoryBalloon,
        // Store disk paths for multi-disk support (also migrates legacy VMs)
        diskPaths,
        // Preserve existing CPU pinning configuration (don't overwrite with null)
        cpuPinning: vmConfig.configuration?.cpuPinning?.cores && vmConfig.configuration.cpuPinning.cores.length > 0
          ? { cores: vmConfig.configuration.cpuPinning.cores }
          : vmConfig.configuration?.cpuPinning ?? null
      })

      // 18. Update database status to 'running'
      await this.prisma.updateMachineStatus(vmId, 'running')

      // 19. Attach event handler for monitoring
      await this.eventHandler.attachToVM(vmId, qmpClient)

      // 20. Emit event to backend
      this.emitEvent('machines', 'power_on', vmId, { pid, tapDevice })

      this.debug.log(`VM started successfully: ${vmId}`)

      return {
        success: true,
        message: `VM ${vmId} started successfully`,
        vmId,
        timestamp
      }
    } catch (error) {
      this.debug.log('error', `Failed to start VM: ${error instanceof Error ? error.message : String(error)}`)
      await this.cleanup(resources)
      if (error instanceof LifecycleError) {
        throw error
      }
      throw this.wrapError(error, LifecycleErrorCode.START_FAILED, vmId)
    }
  }

  /**
   * Stops a running VM using ACPI graceful shutdown.
   *
   * ## ACPI Shutdown Flow
   *
   * This method implements graceful VM shutdown using the ACPI powerdown mechanism:
   *
   * 1. **Host sends system_powerdown via QMP** - The `powerdown()` command sends an
   *    ACPI power button press event to the guest OS
   * 2. **Guest OS receives ACPI event** - The guest initiates its normal shutdown
   *    sequence (running shutdown scripts, flushing buffers, closing applications)
   * 3. **Guest completes shutdown** - After the guest finishes, it signals completion
   * 4. **QEMU exits automatically** - Because our QEMU instances are NOT started with
   *    the `-no-shutdown` flag, QEMU automatically exits when the guest shuts down
   * 5. **VMLifecycle monitors process exit** - We poll the QEMU process status until
   *    it exits or the timeout expires
   * 6. **Force kill on timeout** - If the timeout expires and `force: true` (default),
   *    we send SIGKILL to terminate QEMU immediately
   * 7. **Resource cleanup** - Detach EventHandler, update DB, clear volatile config,
   *    detach TAP from bridge, detach firewall jump rules, cleanup cgroup scopes
   *
   * ## Why quit() is Never Called
   *
   * The QMP `quit` command is intentionally NOT used during normal shutdown because:
   *
   * - **ACPI shutdowns are graceful**: The guest OS can flush disk buffers, close files,
   *   run shutdown scripts (e.g., systemd services), and unmount filesystems safely
   * - **quit() is immediate**: It terminates QEMU instantly without guest cooperation,
   *   which can cause data loss or filesystem corruption
   * - **QEMU auto-exits**: After ACPI shutdown completes, QEMU exits naturally since
   *   we don't use the `-no-shutdown` flag - making `quit()` redundant
   * - **Socket race condition**: By the time we'd call quit(), the QMP socket may
   *   already be closed as QEMU is shutting down
   *
   * The `quit()` method exists in QMPClient for emergency scenarios but is not used
   * in the standard shutdown flow.
   *
   * ## Guest-Initiated vs Host-Initiated Shutdowns
   *
   * **Host-initiated** (this method):
   * - Triggered by user clicking PowerOff in UI, calling stopVM mutation
   * - VMLifecycle.stop() handles entire flow including cleanup
   * - Configurable timeout (default 30s, backend typically uses 120s)
   *
   * **Guest-initiated** (handled by EventHandler):
   * - Triggered by user shutting down from inside the VM
   * - EventHandler.terminateQEMUProcess() monitors exit and cleans up
   * - Fixed 30s monitoring timeout (no force-kill, investigation warranted)
   *
   * Both flows produce identical QEMU behavior (ACPI shutdown → auto-exit) and
   * perform the same resource cleanup. The EventHandler cleanup ensures VMs shut
   * down cleanly even when the user initiates shutdown from inside the guest OS.
   *
   * ## Timeout Behavior
   *
   * The timeout applies to waiting for QEMU process exit after ACPI powerdown:
   * - **Default**: 30 seconds (DEFAULT_STOP_TIMEOUT)
   * - **Backend override**: Typically 120 seconds for user-initiated operations
   * - **EventHandler monitoring**: Fixed 30 seconds for guest-initiated shutdowns
   *
   * If timeout expires and `force: true`:
   * - SIGKILL is sent to QEMU process
   * - VM is marked as stopped in database
   * - Cleanup proceeds normally
   * - Result includes `forced: true` flag
   *
   * ## PID Invariant
   *
   * **INVARIANT**: For running VMs, `qemuPid` must be present in the database.
   * This method relies on the stored PID to terminate QEMU processes. If `qemuPid`
   * is missing from the database but a QEMU process is actually running (stray process),
   * `stop()` cannot terminate it since we have no way to identify which process belongs
   * to this VM. Such stray processes may occur due to:
   * - Incomplete cleanup after a crash
   * - Database corruption or rollback
   * - Manual process manipulation outside the system
   *
   * Use `getStatus()` to detect and diagnose PID/process inconsistencies.
   *
   * @param vmId - VM identifier
   * @param config - Stop configuration (default: graceful with 30s timeout and force)
   * @returns VMOperationResult indicating success or failure
   *
   * @see QMPClient.powerdown() for the ACPI shutdown command
   * @see EventHandler.terminateQEMUProcess() for guest-initiated shutdown handling
   * @see destroyResources() for permanent VM deletion with resource destruction
   *
   * @example
   * ```typescript
   * // Graceful shutdown with 2 minute timeout (recommended for user-facing operations)
   * await lifecycle.stop(vmId, { graceful: true, timeout: 120000, force: true })
   *
   * // Quick shutdown for tests or automation
   * await lifecycle.stop(vmId, { graceful: true, timeout: 5000, force: true })
   *
   * // Force kill without attempting graceful (emergency use only)
   * await lifecycle.stop(vmId, { graceful: false, force: true })
   * ```
   */
  async stop (vmId: string, config?: VMStopConfig): Promise<VMOperationResult> {
    const stopConfig: Required<VMStopConfig> = {
      graceful: config?.graceful ?? true,
      timeout: config?.timeout ?? DEFAULT_STOP_TIMEOUT,
      force: config?.force ?? true
    }

    this.debug.log(`Stopping VM: ${vmId} (graceful: ${stopConfig.graceful}, timeout: ${stopConfig.timeout}ms)`)
    const timestamp = new Date()
    let forced = false

    try {
      // Fetch VM configuration
      const vmConfig = await this.prisma.findMachineWithConfig(vmId)
      if (!vmConfig) {
        throw new LifecycleError(
          LifecycleErrorCode.VM_NOT_FOUND,
          `VM not found: ${vmId}`,
          vmId
        )
      }

      const qmpSocketPath = vmConfig.configuration?.qmpSocketPath
      const pid = vmConfig.configuration?.qemuPid
      const tapDevice = vmConfig.configuration?.tapDeviceName

      // Log diagnostic info for debugging graceful shutdown issues
      this.debug.log('info', `Stop attempt - graceful: ${stopConfig.graceful}, qmpSocketPath: ${qmpSocketPath ?? 'NULL'}, pid: ${pid ?? 'NULL'}`)

      if (stopConfig.graceful && !qmpSocketPath) {
        this.debug.log('warn', `VM ${vmId}: No QMP socket path in DB - graceful shutdown will not be attempted`)
      }

      // Check if already stopped
      // NOTE: When !pid, we assume the VM is already off or in an inconsistent state where
      // the PID was never recorded. We cannot detect or terminate stray QEMU processes
      // without a known PID. If a QEMU process is actually running but the PID is missing
      // from the database (due to crash, corruption, or manual intervention), this method
      // will report success but the stray process will remain. Use getStatus() to detect
      // such inconsistencies by checking for processes without corresponding DB PIDs.
      if (vmConfig.status === 'off') {
        if (!pid || !this.isProcessAlive(pid)) {
          return {
            success: true,
            message: `VM ${vmId} is already stopped`,
            vmId,
            timestamp
          }
        }
        // Process is alive but DB says off - continue with stop
      }

      // Early check: If process is already dead, skip QMP operations entirely
      // This handles the case where guest-initiated shutdown has already completed
      if (pid && !this.isProcessAlive(pid)) {
        this.debug.log('info', `QEMU process (PID ${pid}) already terminated for VM ${vmId} - skipping QMP operations`)
        // Process is dead, jump directly to cleanup (no graceful shutdown needed)
        // This path is reached when guest initiated shutdown and QEMU exited before stop() was called
      } else if (stopConfig.graceful && qmpSocketPath && pid) {
        // Process is alive, try graceful shutdown via QMP
        // Verify socket exists before attempting connection
        const socketExists = fs.existsSync(qmpSocketPath)
        this.debug.log('info', `QMP socket ${qmpSocketPath} exists: ${socketExists}`)

        if (!socketExists) {
          this.debug.log('warn', `QMP socket ${qmpSocketPath} does not exist - cannot send ACPI powerdown`)
          // Fall through to force kill if enabled
          if (stopConfig.force && this.isProcessAlive(pid)) {
            this.debug.log('warn', `Falling back to force kill for VM ${vmId} (socket missing)`)
            await this.forceKillProcess(pid)
            forced = true
          } else {
            throw new LifecycleError(
              LifecycleErrorCode.STOP_FAILED,
              `QMP socket ${qmpSocketPath} does not exist and force is disabled`,
              vmId
            )
          }
        } else {
          // Socket exists, attempt graceful shutdown
          // Try to use existing QMP connection from EventHandler first (QEMU only accepts one connection)
          const existingQmpClient = this.eventHandler.getQMPClient(vmId)

          if (existingQmpClient) {
            // Use existing connection
            this.debug.log('info', `Using existing QMP connection for VM ${vmId}`)
            try {
              // ACPI powerdown - guest will shutdown gracefully, QEMU exits automatically
              await existingQmpClient.powerdown()
              this.debug.log('info', `Sent system_powerdown (ACPI) to VM ${vmId} - waiting for guest OS to shutdown and QEMU to exit automatically`)

              // Wait for natural QEMU exit (no quit command needed - see class documentation)
              // QEMU will automatically exit when guest completes shutdown (no -no-shutdown flag).
              // Timeout protects against hung guests or ACPI-unsupported OSes.
              this.debug.log('info', `Waiting up to ${stopConfig.timeout}ms for QEMU process ${pid} to exit after ACPI shutdown`)
              const exited = await this.waitForProcessExit(pid, stopConfig.timeout)

              if (!exited && stopConfig.force) {
                // Timeout protection: guest may not support ACPI or be hung
                this.debug.log('warn', `ACPI shutdown timed out after ${stopConfig.timeout}ms - guest may not support ACPI or is hung. Force killing VM ${vmId}`)
                await this.forceKillProcess(pid)
                forced = true
              }
            } catch (qmpError) {
              const errorMsg = qmpError instanceof Error ? qmpError.message : String(qmpError)
              this.debug.log('error', `QMP powerdown failed for VM ${vmId}: ${errorMsg}`)
              if (stopConfig.force && pid && this.isProcessAlive(pid)) {
                this.debug.log('warn', `Falling back to force kill for VM ${vmId}`)
                await this.forceKillProcess(pid)
                forced = true
              }
            }
          } else {
            // No existing connection, create a new one
            this.debug.log('info', `No existing QMP connection for VM ${vmId}, creating new connection`)
            try {
              const qmpClient = new QMPClient(qmpSocketPath, {
                connectTimeout: DEFAULT_QMP_CONNECT_TIMEOUT
              })

              try {
                await qmpClient.connect()
                // ACPI powerdown - guest will shutdown gracefully, QEMU exits automatically
                this.debug.log('info', `QMP connected to ${qmpSocketPath}, sending system_powerdown (ACPI)`)
                await qmpClient.powerdown()
                this.debug.log('info', `Sent system_powerdown (ACPI) to VM ${vmId} - waiting for guest OS to shutdown and QEMU to exit automatically`)

                // Wait for natural QEMU exit (no quit command needed - see class documentation)
                // QEMU will automatically exit when guest completes shutdown (no -no-shutdown flag).
                // Timeout protects against hung guests or ACPI-unsupported OSes.
                this.debug.log('info', `Waiting up to ${stopConfig.timeout}ms for QEMU process ${pid} to exit after ACPI shutdown`)
                const exited = await this.waitForProcessExit(pid, stopConfig.timeout)

                if (!exited && stopConfig.force) {
                  // Timeout protection: guest may not support ACPI or be hung
                  this.debug.log('warn', `ACPI shutdown timed out after ${stopConfig.timeout}ms - guest may not support ACPI or is hung. Force killing VM ${vmId}`)
                  await this.forceKillProcess(pid)
                  forced = true
                }
              } finally {
                await qmpClient.disconnect()
              }
            } catch (qmpError) {
              // QMP failed, try force kill if enabled
              const errorMsg = qmpError instanceof Error ? qmpError.message : String(qmpError)
              this.debug.log('error', `QMP powerdown failed for VM ${vmId}: ${errorMsg}`)
              if (stopConfig.force && pid && this.isProcessAlive(pid)) {
                this.debug.log('warn', `Falling back to force kill for VM ${vmId}`)
                await this.forceKillProcess(pid)
                forced = true
              }
            }
          }
        }
      } else if (pid && this.isProcessAlive(pid)) {
        // No graceful shutdown, just force kill
        if (stopConfig.force) {
          await this.forceKillProcess(pid)
          forced = true
        } else {
          throw new LifecycleError(
            LifecycleErrorCode.STOP_FAILED,
            'Cannot stop VM without graceful or force option',
            vmId
          )
        }
      }

      // Detach event handler before DB updates
      // This stops QMP event processing so that any late events don't trigger
      // StateSync updates after we've manually set the status to 'off'
      await this.eventHandler.detachFromVM(vmId)

      // Update database status to 'off'
      // NOTE ON STATE SYNC: By setting status to 'off' and clearing configuration,
      // HealthMonitor will ignore this VM since:
      // 1. findRunningVMs() only returns VMs with status='running'
      // 2. clearMachineConfiguration() removes qemuPid, so even if status update
      //    is delayed, HealthMonitor won't find a PID to check
      // EventHandler is detached above, so no QMP events will trigger status changes.
      await this.prisma.updateMachineStatus(vmId, 'off')

      // Clear volatile machine configuration (qmpSocketPath, qemuPid)
      // Note: tapDeviceName is preserved for persistent TAP device reuse on restart
      // This ensures HealthMonitor won't attempt to check a stale PID
      await this.prisma.clearVolatileMachineConfiguration(vmId)

      // Detach TAP device from bridge (persistent - not destroyed)
      // The TAP device persists for reuse when VM restarts
      if (tapDevice) {
        try {
          await this.tapManager.detachFromBridge(tapDevice)
        } catch (tapError) {
          this.debug.log('warn', `Failed to detach TAP device: ${tapError instanceof Error ? tapError.message : String(tapError)}`)
        }
      }

      // Detach jump rules from nftables (chain and rules persist)
      // Only the routing from TAP to chain is removed; firewall rules survive stop/start
      try {
        await this.nftables.detachJumpRules(vmId)
      } catch (fwError) {
        this.debug.log('warn', `Failed to detach firewall jump rules: ${fwError instanceof Error ? fwError.message : String(fwError)}`)
      }

      // Cleanup empty cgroup scopes if CPU pinning was used
      // Note: Scopes are named by PID, so we do opportunistic cleanup of any empty scopes
      if (vmConfig.configuration?.cpuPinning?.cores) {
        try {
          const cleanedCount = await this.cgroupsManager.cleanupEmptyScopes()
          if (cleanedCount > 0) {
            this.debug.log(`Cleaned up ${cleanedCount} empty cgroup scope(s)`)
          }
        } catch (error) {
          // Log but don't fail stop operation
          this.debug.log('warn', `Failed to cleanup cgroup scopes: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // Emit event
      this.emitEvent('machines', 'power_off', vmId, { forced })

      this.debug.log(`VM stopped: ${vmId}${forced ? ' (forced)' : ''}`)

      return {
        success: true,
        message: `VM ${vmId} stopped successfully${forced ? ' (forced)' : ''}`,
        vmId,
        timestamp,
        forced
      }
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw error
      }
      throw this.wrapError(error, LifecycleErrorCode.STOP_FAILED, vmId)
    }
  }

  /**
   * Permanently destroys VM network resources (TAP device and firewall chain).
   * Call this when deleting a VM completely, NOT during normal stop/start cycles.
   *
   * This method:
   * 1. Stops the VM if running (with force)
   * 2. Destroys the TAP device permanently
   * 3. Removes the nftables firewall chain and all rules
   * 4. Clears all machine configuration from database (including tapDeviceName)
   *
   * @param vmId - VM identifier
   * @returns VMOperationResult indicating success or failure
   */
  async destroyResources (vmId: string): Promise<VMOperationResult> {
    this.debug.log(`Destroying resources for VM: ${vmId}`)
    const timestamp = new Date()

    try {
      // Fetch VM configuration
      const vmConfig = await this.prisma.findMachineWithConfig(vmId)
      if (!vmConfig) {
        // VM doesn't exist in DB, just return success
        return {
          success: true,
          message: `VM ${vmId} not found, nothing to destroy`,
          vmId,
          timestamp
        }
      }

      // Stop VM if running
      if (vmConfig.status === 'running') {
        this.debug.log(`VM ${vmId} is running, stopping first`)
        await this.stop(vmId, { graceful: false, timeout: 5000, force: true })
      }

      const tapDevice = vmConfig.configuration?.tapDeviceName

      // Destroy TAP device permanently
      if (tapDevice) {
        try {
          await this.tapManager.destroy(tapDevice)
          this.debug.log(`TAP device destroyed: ${tapDevice}`)
        } catch (tapError) {
          this.debug.log('warn', `Failed to destroy TAP device: ${tapError instanceof Error ? tapError.message : String(tapError)}`)
        }
      }

      // Remove firewall chain permanently (including all rules)
      try {
        await this.nftables.removeVMChain(vmId)
        this.debug.log(`Firewall chain removed for VM: ${vmId}`)
      } catch (fwError) {
        this.debug.log('warn', `Failed to remove firewall chain: ${fwError instanceof Error ? fwError.message : String(fwError)}`)
      }

      // Clear ALL machine configuration (including tapDeviceName)
      await this.prisma.clearMachineConfiguration(vmId)

      this.debug.log(`Resources destroyed for VM: ${vmId}`)

      return {
        success: true,
        message: `VM ${vmId} resources destroyed successfully`,
        vmId,
        timestamp
      }
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw error
      }
      throw this.wrapError(error, LifecycleErrorCode.STOP_FAILED, vmId)
    }
  }

  /**
   * Restarts a VM by stopping and starting it.
   *
   * @param vmId - VM identifier
   * @returns VMOperationResult indicating success or failure
   */
  async restart (vmId: string): Promise<VMOperationResult> {
    this.debug.log(`Restarting VM: ${vmId}`)
    const timestamp = new Date()

    try {
      // Stop the VM
      const stopResult = await this.stop(vmId, {
        graceful: true,
        timeout: DEFAULT_STOP_TIMEOUT,
        force: true
      })

      if (!stopResult.success) {
        return {
          success: false,
          message: `Failed to stop VM during restart: ${stopResult.error}`,
          error: stopResult.error,
          vmId,
          timestamp
        }
      }

      // Wait before starting
      await this.sleep(RESTART_DELAY_MS)

      // Start the VM
      const startResult = await this.start(vmId)

      if (!startResult.success) {
        return {
          success: false,
          message: `VM stopped but failed to start: ${startResult.error}`,
          error: startResult.error,
          vmId,
          timestamp
        }
      }

      return {
        success: true,
        message: `VM ${vmId} restarted successfully`,
        vmId,
        timestamp
      }
    } catch (error) {
      throw this.wrapError(error, LifecycleErrorCode.STOP_FAILED, vmId)
    }
  }

  /**
   * Suspends (pauses) a running VM.
   *
   * @param vmId - VM identifier
   * @returns VMOperationResult indicating success or failure
   */
  async suspend (vmId: string): Promise<VMOperationResult> {
    this.debug.log(`Suspending VM: ${vmId}`)
    const timestamp = new Date()

    try {
      const vmConfig = await this.prisma.findMachineWithConfig(vmId)
      if (!vmConfig) {
        throw new LifecycleError(
          LifecycleErrorCode.VM_NOT_FOUND,
          `VM not found: ${vmId}`,
          vmId
        )
      }

      if (vmConfig.status !== 'running') {
        throw new LifecycleError(
          LifecycleErrorCode.INVALID_STATE,
          `Cannot suspend VM in state: ${vmConfig.status}`,
          vmId
        )
      }

      const qmpSocketPath = vmConfig.configuration?.qmpSocketPath
      if (!qmpSocketPath) {
        throw new LifecycleError(
          LifecycleErrorCode.QMP_ERROR,
          'QMP socket path not found',
          vmId
        )
      }

      const qmpClient = new QMPClient(qmpSocketPath, {
        connectTimeout: DEFAULT_QMP_CONNECT_TIMEOUT
      })

      try {
        await qmpClient.connect()
        await qmpClient.stop()
        await this.prisma.updateMachineStatus(vmId, 'suspended')
        this.emitEvent('machines', 'suspend', vmId)
      } finally {
        await qmpClient.disconnect()
      }

      return {
        success: true,
        message: `VM ${vmId} suspended`,
        vmId,
        timestamp
      }
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw error
      }
      throw this.wrapError(error, LifecycleErrorCode.QMP_ERROR, vmId)
    }
  }

  /**
   * Resumes a suspended VM.
   *
   * @param vmId - VM identifier
   * @returns VMOperationResult indicating success or failure
   */
  async resume (vmId: string): Promise<VMOperationResult> {
    this.debug.log(`Resuming VM: ${vmId}`)
    const timestamp = new Date()

    try {
      const vmConfig = await this.prisma.findMachineWithConfig(vmId)
      if (!vmConfig) {
        throw new LifecycleError(
          LifecycleErrorCode.VM_NOT_FOUND,
          `VM not found: ${vmId}`,
          vmId
        )
      }

      if (vmConfig.status !== 'suspended' && vmConfig.status !== 'paused') {
        throw new LifecycleError(
          LifecycleErrorCode.INVALID_STATE,
          `Cannot resume VM in state: ${vmConfig.status}`,
          vmId
        )
      }

      const qmpSocketPath = vmConfig.configuration?.qmpSocketPath
      if (!qmpSocketPath) {
        throw new LifecycleError(
          LifecycleErrorCode.QMP_ERROR,
          'QMP socket path not found',
          vmId
        )
      }

      const qmpClient = new QMPClient(qmpSocketPath, {
        connectTimeout: DEFAULT_QMP_CONNECT_TIMEOUT
      })

      try {
        await qmpClient.connect()
        await qmpClient.cont()
        await this.prisma.updateMachineStatus(vmId, 'running')
        this.emitEvent('machines', 'resume', vmId)
      } finally {
        await qmpClient.disconnect()
      }

      return {
        success: true,
        message: `VM ${vmId} resumed`,
        vmId,
        timestamp
      }
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw error
      }
      throw this.wrapError(error, LifecycleErrorCode.QMP_ERROR, vmId)
    }
  }

  /**
   * Resets a VM (hardware reset).
   *
   * @param vmId - VM identifier
   * @returns VMOperationResult indicating success or failure
   */
  async reset (vmId: string): Promise<VMOperationResult> {
    this.debug.log(`Resetting VM: ${vmId}`)
    const timestamp = new Date()

    try {
      const vmConfig = await this.prisma.findMachineWithConfig(vmId)
      if (!vmConfig) {
        throw new LifecycleError(
          LifecycleErrorCode.VM_NOT_FOUND,
          `VM not found: ${vmId}`,
          vmId
        )
      }

      if (vmConfig.status !== 'running') {
        throw new LifecycleError(
          LifecycleErrorCode.INVALID_STATE,
          `Cannot reset VM in state: ${vmConfig.status}`,
          vmId
        )
      }

      const qmpSocketPath = vmConfig.configuration?.qmpSocketPath
      if (!qmpSocketPath) {
        throw new LifecycleError(
          LifecycleErrorCode.QMP_ERROR,
          'QMP socket path not found',
          vmId
        )
      }

      const qmpClient = new QMPClient(qmpSocketPath, {
        connectTimeout: DEFAULT_QMP_CONNECT_TIMEOUT
      })

      try {
        await qmpClient.connect()
        await qmpClient.reset()
        this.emitEvent('machines', 'update', vmId, { type: 'hardware' })
      } finally {
        await qmpClient.disconnect()
      }

      return {
        success: true,
        message: `VM ${vmId} reset`,
        vmId,
        timestamp
      }
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw error
      }
      throw this.wrapError(error, LifecycleErrorCode.QMP_ERROR, vmId)
    }
  }

  /**
   * Gets detailed status of a VM.
   *
   * @param vmId - VM identifier
   * @returns VMStatusResult with detailed status information
   */
  async getStatus (vmId: string): Promise<VMStatusResult> {
    this.debug.log(`Getting status for VM: ${vmId}`)

    try {
      const vmConfig = await this.prisma.findMachineWithConfig(vmId)
      if (!vmConfig) {
        throw new LifecycleError(
          LifecycleErrorCode.VM_NOT_FOUND,
          `VM not found: ${vmId}`,
          vmId
        )
      }

      const pid = vmConfig.configuration?.qemuPid ?? null
      const processAlive = pid ? this.isProcessAlive(pid) : false
      const qmpSocketPath = vmConfig.configuration?.qmpSocketPath ?? null
      const tapDevice = vmConfig.configuration?.tapDeviceName ?? null

      // Determine consistency
      const dbSaysRunning = vmConfig.status === 'running'
      const consistent = dbSaysRunning === processAlive

      // Warn about potential stray QEMU process: DB says VM is running but no PID is stored.
      // This indicates the PID was never recorded or was lost (crash, corruption, manual intervention).
      // A QEMU process may be running without our ability to track or terminate it via stop().
      // This is a diagnostic aid - the system cannot automatically recover from this state.
      if (dbSaysRunning && !pid) {
        this.debug.log('warn', `VM ${vmId}: Database shows status='running' but no qemuPid stored. ` +
          `A stray QEMU process may exist that cannot be tracked or terminated via stop(). ` +
          `Manual intervention may be required (check for orphaned qemu-system-* processes).`)
      }

      // Warn about inconsistent state where DB says running but process is dead
      if (!consistent && dbSaysRunning && pid && !processAlive) {
        this.debug.log('warn', `VM ${vmId}: Database shows status='running' with PID ${pid} but process is not alive. ` +
          `State inconsistency detected - VM may have crashed or been terminated externally.`)
      }

      let qmpStatus: string | null = null
      let uptime: number | null = null

      // Query QMP status if process is alive
      if (processAlive && qmpSocketPath) {
        try {
          const qmpClient = new QMPClient(qmpSocketPath, {
            connectTimeout: DEFAULT_QMP_CONNECT_TIMEOUT
          })

          try {
            await qmpClient.connect()
            const status = await qmpClient.queryStatus()
            qmpStatus = status.status

            // Calculate uptime if running
            // QMP doesn't provide direct uptime, would need to track start time
          } finally {
            await qmpClient.disconnect()
          }
        } catch {
          // QMP connection failed, but process is alive
          this.debug.log('warn', `Failed to query QMP status for VM: ${vmId}`)
        }
      }

      return {
        vmId,
        status: vmConfig.status,
        qmpStatus,
        pid,
        uptime,
        processAlive,
        consistent,
        tapDevice,
        qmpSocketPath
      }
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw error
      }
      throw this.wrapError(error, LifecycleErrorCode.DATABASE_ERROR, vmId)
    }
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Validates VM creation configuration
   */
  private validateCreateConfig (config: VMCreateConfig): void {
    const errors: string[] = []

    if (!config.vmId || config.vmId.trim().length === 0) {
      errors.push('VM database ID (vmId) is required')
    }
    if (!config.name || config.name.trim().length === 0) {
      errors.push('VM name is required')
    }
    if (!config.internalName || config.internalName.trim().length === 0) {
      errors.push('VM internal name is required')
    }
    if (!config.os || config.os.trim().length === 0) {
      errors.push('OS type is required')
    }
    if (!config.cpuCores || config.cpuCores < 1) {
      errors.push('CPU cores must be at least 1')
    }
    if (!config.ramGB || config.ramGB < 0.5) {
      errors.push('RAM must be at least 0.5 GB')
    }
    // Validate disks array
    if (!config.disks || !Array.isArray(config.disks) || config.disks.length === 0) {
      errors.push('At least one disk configuration is required')
    } else {
      config.disks.forEach((disk, index) => {
        if (!disk.sizeGB || disk.sizeGB < 1) {
          errors.push(`Disk ${index}: size must be at least 1 GB`)
        }
      })
    }
    if (!config.bridge || config.bridge.trim().length === 0) {
      errors.push('Network bridge is required')
    }
    if (!config.displayType || !['spice', 'vnc'].includes(config.displayType)) {
      errors.push('Display type must be "spice" or "vnc"')
    }
    if (config.displayPort === undefined || config.displayPort < 0) {
      errors.push('Display port is required and must be non-negative')
    }

    // Validate CPU pinning strategy if provided
    if (config.cpuPinningStrategy !== undefined) {
      const validStrategies = ['basic', 'hybrid'] as const
      if (!validStrategies.includes(config.cpuPinningStrategy)) {
        errors.push(`Invalid cpuPinningStrategy: '${config.cpuPinningStrategy}'. Must be 'basic' or 'hybrid'`)
      }
    }

    if (errors.length > 0) {
      throw new LifecycleError(
        LifecycleErrorCode.INVALID_CONFIG,
        `Invalid VM configuration: ${errors.join(', ')}`,
        config.vmId,
        { errors }
      )
    }
  }

  /**
   * Generates file paths for VM resources
   *
   * @param internalName - VM internal name
   * @param diskCount - Number of disks (default: 1)
   * @returns Object with disk paths array, QMP socket path, and PID file path
   */
  private generatePaths (internalName: string, diskCount: number = 1): {
    diskPaths: string[]
    qmpSocketPath: string
    pidFilePath: string
  } {
    const diskPaths: string[] = []
    for (let i = 0; i < diskCount; i++) {
      // First disk has no suffix, subsequent disks have -disk1, -disk2, etc.
      const suffix = i === 0 ? '' : `-disk${i}`
      diskPaths.push(path.join(this.diskDir, `${internalName}${suffix}.qcow2`))
    }

    return {
      diskPaths,
      qmpSocketPath: path.join(this.qmpSocketDir, `${internalName}.sock`),
      pidFilePath: path.join(this.pidfileDir, `${internalName}.pid`)
    }
  }

  /**
   * Ensures required directories exist
   */
  private async ensureDirectories (): Promise<void> {
    const dirs = [
      this.diskDir,
      this.qmpSocketDir,
      this.pidfileDir
    ]
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        this.debug.log(`Created directory: ${dir}`)
      }
    }
  }

  /**
   * Fetches firewall rules for a VM
   */
  private async fetchFirewallRules (vmId: string): Promise<{
    department: FirewallRuleInput[]
    vm: FirewallRuleInput[]
  }> {
    try {
      const rules = await this.prisma.getFirewallRules(vmId)
      // Split rules into department and VM rules based on source
      // For now, return all rules as department rules
      // TODO: Properly split once we have source information
      return {
        department: rules,
        vm: []
      }
    } catch {
      // No rules or error - return empty
      return { department: [], vm: [] }
    }
  }

  // ===========================================================================
  // QEMU Configuration Validation Helpers
  // ===========================================================================

  /** Allowed machine types for QEMU */
  private static readonly VALID_MACHINE_TYPES = ['q35', 'pc'] as const
  /** Allowed disk bus types */
  private static readonly VALID_DISK_BUS_TYPES = ['virtio', 'scsi', 'ide', 'sata'] as const
  /** Allowed disk cache modes */
  private static readonly VALID_DISK_CACHE_MODES = ['writeback', 'writethrough', 'none', 'unsafe'] as const
  /** Allowed network models */
  private static readonly VALID_NETWORK_MODELS = ['virtio-net-pci', 'e1000'] as const
  /** Allowed CPU pinning strategies */
  private static readonly VALID_CPU_PINNING_STRATEGIES = ['basic', 'hybrid'] as const

  /**
   * Validates machine type and returns a valid value, logging a warning if invalid.
   */
  private validateMachineType (value: string | null | undefined): 'q35' | 'pc' {
    const defaultValue: 'q35' | 'pc' = 'q35'
    if (!value) return defaultValue

    if (VMLifecycle.VALID_MACHINE_TYPES.includes(value as typeof VMLifecycle.VALID_MACHINE_TYPES[number])) {
      return value as 'q35' | 'pc'
    }

    this.debug.log('warn', `Invalid machineType '${value}', using default '${defaultValue}'`)
    return defaultValue
  }

  /**
   * Validates disk bus type and returns a valid value, logging a warning if invalid.
   */
  private validateDiskBus (value: string | null | undefined): 'virtio' | 'scsi' | 'ide' | 'sata' {
    const defaultValue = DEFAULT_DISK_BUS as 'virtio' | 'scsi' | 'ide' | 'sata'
    if (!value) return defaultValue

    if (VMLifecycle.VALID_DISK_BUS_TYPES.includes(value as typeof VMLifecycle.VALID_DISK_BUS_TYPES[number])) {
      return value as 'virtio' | 'scsi' | 'ide' | 'sata'
    }

    this.debug.log('warn', `Invalid diskBus '${value}', using default '${defaultValue}'`)
    return defaultValue
  }

  /**
   * Validates disk cache mode and returns a valid value, logging a warning if invalid.
   */
  private validateDiskCacheMode (value: string | null | undefined): 'writeback' | 'writethrough' | 'none' | 'unsafe' {
    const defaultValue = DEFAULT_DISK_CACHE as 'writeback' | 'writethrough' | 'none' | 'unsafe'
    if (!value) return defaultValue

    if (VMLifecycle.VALID_DISK_CACHE_MODES.includes(value as typeof VMLifecycle.VALID_DISK_CACHE_MODES[number])) {
      return value as 'writeback' | 'writethrough' | 'none' | 'unsafe'
    }

    this.debug.log('warn', `Invalid diskCacheMode '${value}', using default '${defaultValue}'`)
    return defaultValue
  }

  /**
   * Validates network model and returns a valid value, logging a warning if invalid.
   */
  private validateNetworkModel (value: string | null | undefined): 'virtio-net-pci' | 'e1000' {
    const defaultValue = DEFAULT_NETWORK_MODEL as 'virtio-net-pci' | 'e1000'
    if (!value) return defaultValue

    if (VMLifecycle.VALID_NETWORK_MODELS.includes(value as typeof VMLifecycle.VALID_NETWORK_MODELS[number])) {
      return value as 'virtio-net-pci' | 'e1000'
    }

    this.debug.log('warn', `Invalid networkModel '${value}', using default '${defaultValue}'`)
    return defaultValue
  }

  /**
   * Validates CPU pinning strategy and returns a valid value, logging a warning if invalid.
   *
   * @remarks
   * This method provides defensive validation against corrupt database values.
   * If the stored strategy is not 'basic' or 'hybrid', it returns 'basic' as the default.
   */
  private validateCpuPinningStrategy (value: string | null | undefined): 'basic' | 'hybrid' | undefined {
    if (value === null || value === undefined) return undefined

    if (VMLifecycle.VALID_CPU_PINNING_STRATEGIES.includes(value as typeof VMLifecycle.VALID_CPU_PINNING_STRATEGIES[number])) {
      return value as 'basic' | 'hybrid'
    }

    this.debug.log('warn', `Invalid cpuPinningStrategy '${value}', using default 'basic'`)
    return 'basic'
  }

  /**
   * Validates display port and returns a valid value, logging a warning if invalid.
   *
   * @param port - The port to validate (from database or config)
   * @returns A valid port number within SPICE_MIN_PORT-SPICE_MAX_PORT range, or SPICE_MIN_PORT as default
   *
   * @remarks
   * This method provides defensive validation against corrupt database values.
   * If the stored port is NULL, undefined, not an integer, or outside the valid
   * range (5900-65535), it returns the default port (5900) and logs a warning.
   */
  private validateDisplayPort (port: number | null | undefined): number {
    const defaultPort = SPICE_MIN_PORT

    // Handle NULL or undefined
    if (port === null || port === undefined) {
      return defaultPort
    }

    // Check if it's a valid integer
    if (!Number.isInteger(port)) {
      this.debug.log('warn', `Invalid displayPort '${port}' (not an integer), using default '${defaultPort}'`)
      return defaultPort
    }

    // Check if it's within valid range
    if (port < SPICE_MIN_PORT || port > SPICE_MAX_PORT) {
      this.debug.log('warn', `Invalid displayPort '${port}' (out of range ${SPICE_MIN_PORT}-${SPICE_MAX_PORT}), using default '${defaultPort}'`)
      return defaultPort
    }

    return port
  }

  /**
   * Checks if a TCP port is available for binding.
   *
   * @param port - The port number to check
   * @returns Promise resolving to true if port is available, false if in use
   *
   * @remarks
   * Creates a temporary TCP server to test port availability.
   * This is more reliable than checking /proc/net/tcp as it accounts
   * for ports in TIME_WAIT state and handles race conditions better.
   */
  private isPortAvailable (port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net')
      const server = net.createServer()

      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          resolve(false)
        } else {
          // Other errors (e.g., network issues) - assume port is unavailable
          this.debug.log('warn', `Port availability check failed for ${port}: ${err.message}`)
          resolve(false)
        }
      })

      server.once('listening', () => {
        server.close(() => {
          resolve(true)
        })
      })

      // Try to bind to all interfaces (0.0.0.0) to match SPICE/VNC behavior
      server.listen(port, '0.0.0.0')
    })
  }

  /**
   * Finds an available display port starting from the given port.
   *
   * @param startPort - The port to start searching from (default: SPICE_MIN_PORT)
   * @param maxAttempts - Maximum number of ports to try (default: 100)
   * @returns Promise resolving to an available port number
   * @throws LifecycleError if no available port is found within the range
   *
   * @remarks
   * Searches sequentially from startPort up to startPort + maxAttempts.
   * This is used during VM creation and start to find a free display port
   * when the preferred port is already in use by another VM or process.
   */
  private async findAvailableDisplayPort (startPort: number = SPICE_MIN_PORT, maxAttempts: number = 100): Promise<number> {
    const endPort = Math.min(startPort + maxAttempts, SPICE_MAX_PORT)

    for (let port = startPort; port <= endPort; port++) {
      if (await this.isPortAvailable(port)) {
        if (port !== startPort) {
          this.debug.log('info', `Display port ${startPort} was in use, allocated port ${port} instead`)
        }
        return port
      }
    }

    throw new LifecycleError(
      LifecycleErrorCode.RESOURCE_UNAVAILABLE,
      `No available display ports in range ${startPort}-${endPort}. All ports are in use.`,
      undefined,
      { startPort, endPort, attemptsChecked: maxAttempts }
    )
  }

  /** Maximum supported network queues */
  private static readonly MAX_NETWORK_QUEUES = 4

  /**
   * Calculates optimal network queue count based on CPU cores.
   * Multi-queue networking improves performance by parallelizing packet processing.
   *
   * @param cpuCores - Number of VM CPU cores
   * @param configuredQueues - Explicitly configured queue count (nullable)
   * @returns Queue count (1-4, where 1 = single queue, >1 = multi-queue with vhost)
   *
   * @remarks
   * **Behavior:**
   * - If `configuredQueues` is explicitly set (non-null), use that value (clamped to 1-4)
   * - Otherwise, auto-calculate as `min(cpuCores, 4)`
   * - Returns 1 for single-core VMs (no multi-queue benefit)
   * - Caps at 4 queues to avoid excessive overhead
   *
   * **Note on OS Presets:**
   * Network queue count is NOT derived from OS driver presets. While presets define
   * recommended queue counts for documentation purposes, this method always uses
   * CPU-based auto-calculation when no explicit value is provided. This ensures
   * optimal queue distribution based on the VM's actual hardware allocation.
   */
  private calculateNetworkQueues (cpuCores: number, configuredQueues: number | null | undefined): number {
    // Explicit configuration takes precedence
    if (configuredQueues !== null && configuredQueues !== undefined) {
      // Warn if configured value exceeds maximum
      if (configuredQueues > VMLifecycle.MAX_NETWORK_QUEUES) {
        this.debug.log('warn', `Configured networkQueues (${configuredQueues}) exceeds maximum (${VMLifecycle.MAX_NETWORK_QUEUES}), clamping to ${VMLifecycle.MAX_NETWORK_QUEUES}`)
      }
      // Clamp to valid range: 1 to MAX_NETWORK_QUEUES
      return Math.max(1, Math.min(configuredQueues, VMLifecycle.MAX_NETWORK_QUEUES))
    }

    // Auto-calculate: min(cpuCores, 4)
    return Math.min(cpuCores, VMLifecycle.MAX_NETWORK_QUEUES)
  }

  /**
   * Validates UEFI firmware path and checks file existence.
   * Returns the validated path or null if firmware should not be used.
   */
  private validateUefiFirmware (firmwarePath: string | null | undefined): string | null {
    if (!firmwarePath) return null

    // Normalize path
    const normalizedPath = path.resolve(firmwarePath)

    // Check if file exists
    if (!fs.existsSync(normalizedPath)) {
      this.debug.log('warn', `UEFI firmware file not found: ${normalizedPath}. Falling back to BIOS boot.`)
      return null
    }

    // Validate it's a readable file
    try {
      fs.accessSync(normalizedPath, fs.constants.R_OK)
    } catch {
      this.debug.log('warn', `UEFI firmware file not readable: ${normalizedPath}. Falling back to BIOS boot.`)
      return null
    }

    return normalizedPath
  }

  /**
   * Validates that hugepages are available on the host system.
   * Checks if /dev/hugepages is mounted as hugetlbfs and accessible.
   *
   * @param enabled - Whether hugepages should be enabled
   * @returns true if hugepages should be used, false otherwise
   *
   * @remarks
   * - Returns false if enabled is false/null/undefined
   * - Checks if /dev/hugepages directory exists
   * - Verifies directory is readable/writable
   * - Verifies /dev/hugepages is actually mounted as hugetlbfs via /proc/mounts
   * - Logs warning and returns false on validation failure (graceful degradation)
   * - Does not throw errors to avoid blocking VM start
   */
  private validateHugepages (enabled: boolean | null | undefined): boolean {
    if (!enabled) return false

    const hugepagesPath = '/dev/hugepages'

    // Check if directory exists
    if (!fs.existsSync(hugepagesPath)) {
      this.debug.log('warn', `Hugepages requested but ${hugepagesPath} does not exist. Ensure hugepages are configured in kernel. Falling back to standard memory.`)
      return false
    }

    // Check if directory is accessible (readable and writable)
    try {
      fs.accessSync(hugepagesPath, fs.constants.R_OK | fs.constants.W_OK)
    } catch {
      this.debug.log('warn', `Hugepages requested but ${hugepagesPath} is not accessible. Check permissions and mount status. Falling back to standard memory.`)
      return false
    }

    // Verify that /dev/hugepages is actually mounted as hugetlbfs
    // by reading /proc/mounts and checking for a matching entry
    try {
      const mounts = fs.readFileSync('/proc/mounts', 'utf8')
      // Each line in /proc/mounts: device mountpoint fstype options dump pass
      // We look for a line where mountpoint is /dev/hugepages and fstype is hugetlbfs
      const isHugetlbfsMounted = mounts.split('\n').some(line => {
        const parts = line.split(/\s+/)
        // parts[1] = mountpoint, parts[2] = filesystem type
        return parts[1] === hugepagesPath && parts[2] === 'hugetlbfs'
      })

      if (!isHugetlbfsMounted) {
        this.debug.log('warn', `Hugepages requested but ${hugepagesPath} is not mounted as hugetlbfs. Run 'mount -t hugetlbfs hugetlbfs ${hugepagesPath}' or add to /etc/fstab. Falling back to standard memory.`)
        return false
      }
    } catch {
      this.debug.log('warn', `Hugepages requested but unable to read /proc/mounts to verify hugetlbfs mount. Falling back to standard memory.`)
      return false
    }

    // Validation passed
    return true
  }

  /**
   * Sets up per-VM UEFI variables file
   *
   * Creates a copy of the OVMF_VARS template file for each VM to store
   * persistent UEFI settings (boot entries, secure boot state, etc.).
   *
   * @param vmId - The VM identifier used for naming the vars file
   * @param firmwarePath - Path to OVMF_CODE firmware (used to find matching OVMF_VARS)
   * @returns Path to the VM-specific vars file, or null if setup failed
   *
   * @remarks
   * Common OVMF_VARS locations:
   * - /usr/share/OVMF/OVMF_VARS.fd (Debian/Ubuntu)
   * - /usr/share/edk2/ovmf/OVMF_VARS.fd (Fedora/RHEL)
   * - /usr/share/OVMF/OVMF_VARS.ms.fd (Microsoft-signed for Secure Boot)
   */
  private setupUefiVars (vmId: string, firmwarePath: string): string | null {
    try {
      // Determine the OVMF_VARS template path based on the OVMF_CODE path
      // E.g., /usr/share/OVMF/OVMF_CODE_4M.fd -> /usr/share/OVMF/OVMF_VARS_4M.fd
      const firmwareDir = path.dirname(firmwarePath)
      const firmwareBasename = path.basename(firmwarePath)

      // Build template paths based on firmware variant (4M or legacy)
      const is4M = firmwareBasename.includes('_4M')
      const varsSuffix = is4M ? '_4M' : ''

      const templatePaths = [
        path.join(firmwareDir, `OVMF_VARS${varsSuffix}.fd`),
        path.join(firmwareDir, `OVMF_VARS${varsSuffix}.ms.fd`),
        `/usr/share/OVMF/OVMF_VARS${varsSuffix}.fd`,
        `/usr/share/edk2/ovmf/OVMF_VARS${varsSuffix}.fd`,
        // Fallback to legacy paths if 4M variant not found
        path.join(firmwareDir, 'OVMF_VARS.fd'),
        '/usr/share/OVMF/OVMF_VARS.fd',
        '/usr/share/edk2/ovmf/OVMF_VARS.fd'
      ]

      // Find the first existing template
      let templatePath: string | null = null
      for (const candidate of templatePaths) {
        if (fs.existsSync(candidate)) {
          templatePath = candidate
          break
        }
      }

      if (!templatePath) {
        this.debug.log('warn', 'UEFI vars template not found. UEFI settings will not persist between reboots.')
        return null
      }

      // Create the per-VM vars file path
      const varsFilename = `uefi-vars-${vmId}.fd`
      const varsPath = path.join(this.diskDir, varsFilename)

      // Copy template if vars file doesn't exist
      if (!fs.existsSync(varsPath)) {
        this.debug.log('info', `Creating UEFI vars file from template: ${templatePath}`)
        fs.copyFileSync(templatePath, varsPath)
        // Ensure the vars file is writable
        fs.chmodSync(varsPath, 0o644)
      }

      return varsPath
    } catch (error) {
      this.debug.log('warn', `Failed to setup UEFI vars file: ${error}. UEFI settings will not persist.`)
      return null
    }
  }

  /**
   * Builds QEMU command line
   *
   * @param config - VM creation configuration
   * @param diskPaths - Array of disk image paths
   * @param qmpSocketPath - QMP socket path
   * @param pidFilePath - PID file path
   * @param tapDevice - TAP network device name
   * @param macAddress - VM MAC address
   * @param qemuConfig - Optional QEMU configuration overrides from database
   */
  private buildQemuCommand (
    config: VMCreateConfig,
    diskPaths: string[],
    qmpSocketPath: string,
    pidFilePath: string,
    tapDevice: string,
    macAddress: string,
    qemuConfig?: {
      machineType?: string | null
      cpuModel?: string | null
      diskBus?: string | null
      diskCacheMode?: string | null
      networkModel?: string | null
      networkQueues?: number | null
      memoryBalloon?: boolean | null
      uefiFirmware?: string | null
      hugepages?: boolean | null
      displayPort?: number | null
      tpmSocketPath?: string | null
      guestAgentSocketPath?: string | null
      infiniServiceSocketPath?: string | null
      virtioDriversIso?: string | null
      enableAudio?: boolean | null
      enableUsbTablet?: boolean | null
      enableNumaCtlPinning?: boolean | null
      cpuPinningStrategy?: 'basic' | 'hybrid' | null
    }
  ): QemuCommandBuilder {
    const builder = new QemuCommandBuilder()

    // Validate and get effective configuration values
    const effectiveMachineType = this.validateMachineType(qemuConfig?.machineType)
    const effectiveCpuModel = qemuConfig?.cpuModel ?? 'host'
    const effectiveDiskBus = this.validateDiskBus(qemuConfig?.diskBus)
    const effectiveDiskCacheMode = this.validateDiskCacheMode(qemuConfig?.diskCacheMode)
    const effectiveNetworkModel = this.validateNetworkModel(qemuConfig?.networkModel)
    const effectiveNetworkQueues = this.calculateNetworkQueues(
      config.cpuCores,
      qemuConfig?.networkQueues
    )

    // Base configuration
    builder
      .enableKvm()
      .setMachine(effectiveMachineType)
      .setCpu(effectiveCpuModel, config.cpuCores)
      .setMemory(config.ramGB)

    // Validate diskPaths and disks array lengths match
    if (diskPaths.length !== config.disks.length) {
      throw new LifecycleError(
        LifecycleErrorCode.INVALID_CONFIG,
        `Disk paths count (${diskPaths.length}) does not match disk configs count (${config.disks.length})`,
        config.vmId,
        { diskPathsLength: diskPaths.length, disksLength: config.disks.length }
      )
    }

    // Disks - build DiskOptions array from config and paths
    const diskOptions = config.disks.map((diskConfig, index) => ({
      path: diskPaths[index],
      format: (diskConfig.format ?? DEFAULT_DISK_FORMAT) as 'qcow2' | 'raw',
      bus: (diskConfig.bus ?? effectiveDiskBus) as 'virtio' | 'scsi' | 'ide' | 'sata',
      cache: (diskConfig.cache ?? effectiveDiskCacheMode) as 'writeback' | 'writethrough' | 'none' | 'unsafe',
      discard: diskConfig.discard ?? true
    }))
    builder.addDisks(diskOptions)

    // Network
    builder.addNetwork({
      tapName: tapDevice,
      mac: macAddress,
      model: effectiveNetworkModel,
      queues: effectiveNetworkQueues
    })

    // Memory balloon for dynamic memory management
    if (qemuConfig?.memoryBalloon === true) {
      builder.addMemoryBalloon()
    }

    // UEFI firmware configuration
    const validatedFirmware = this.validateUefiFirmware(qemuConfig?.uefiFirmware)
    if (validatedFirmware) {
      builder.setFirmware(validatedFirmware)
      this.debug.log('info', `UEFI firmware enabled: ${validatedFirmware}`)

      // Create per-VM UEFI vars file for persistent UEFI settings
      const uefiVarsPath = this.setupUefiVars(config.vmId, validatedFirmware)
      if (uefiVarsPath) {
        builder.setUefiVars(uefiVarsPath)
        this.debug.log('info', `UEFI vars file: ${uefiVarsPath}`)
      }
    }
    // If no firmware specified or validation failed, QEMU defaults to BIOS boot

    // Hugepages configuration for improved memory performance
    const shouldUseHugepages = this.validateHugepages(qemuConfig?.hugepages)
    if (shouldUseHugepages) {
      builder.enableHugepages()
      this.debug.log('info', 'Hugepages enabled for VM memory allocation')
    }
    // If hugepages not enabled or validation failed, QEMU uses standard memory allocation

    // Display configuration with optimizations
    // Disable SPICE agent (vdagent) if Guest Agent is configured, as Guest Agent provides
    // superior functionality and both share the virtio-serial controller
    const hasGuestAgent = !!(config.guestAgentSocketPath ?? qemuConfig?.guestAgentSocketPath)
    // Use validated display port from qemuConfig if available, otherwise validate from config
    const effectiveDisplayPort = this.validateDisplayPort(qemuConfig?.displayPort ?? config.displayPort)

    if (config.displayType === 'spice') {
      const spiceConfig = new SpiceConfig({
        port: effectiveDisplayPort,
        addr: config.displayAddr ?? '0.0.0.0',
        password: config.displayPassword,
        disableTicketing: !config.displayPassword,
        enableAgent: !hasGuestAgent,

        // ===== Performance Optimizations =====
        // Use auto_glz for best compression/performance balance
        imageCompression: 'auto_glz',
        // Auto JPEG compression for WAN scenarios
        jpegWanCompression: 'auto',
        // Auto zlib-glz compression for WAN scenarios
        zlibGlzWanCompression: 'auto',
        // Smart video streaming detection (filter mode)
        streamingVideo: 'filter',
        // Enable playback compression (CELT algorithm)
        playbackCompression: 'on',

        // GL acceleration disabled by default (requires recent QEMU/SPICE)
        // Can be enabled via qemuConfig if needed
        gl: false,

        // Agent features enabled by default
        disableCopyPaste: false,
        disableAgentFileXfer: false,
        seamlessMigration: false
      })

      // Determine QXL memory based on expected resolution
      // Default 16MB for standard resolutions, can be overridden via config
      const qxlMemoryMB = 16

      builder.addSpice(spiceConfig, qxlMemoryMB)
      this.debug.log(`SPICE display configured with optimizations: compression=auto_glz, streaming=filter, qxl_mem=${qxlMemoryMB}MB`)
    } else {
      const vncConfig = new VncConfig({
        display: effectiveDisplayPort,
        addr: config.displayAddr ?? '0.0.0.0',
        password: !!config.displayPassword
      })
      builder.addVnc(vncConfig)
    }

    // QMP socket
    builder.addQmp(qmpSocketPath)

    // ISO if provided
    if (config.isoPath) {
      builder.addCdrom(config.isoPath)
      builder.setBootOrder(['d', 'c']) // CD-ROM first, then disk
    } else {
      builder.setBootOrder(['c']) // Disk only
    }

    // GPU passthrough if configured
    if (config.gpuPciAddress) {
      // Validate ROM file path early to provide clear error message
      if (config.gpuRomfile) {
        const ALLOWED_ROM_DIR = '/var/lib/infinization/roms/'
        const normalizedRomPath = path.resolve(config.gpuRomfile)
        if (!normalizedRomPath.startsWith(ALLOWED_ROM_DIR)) {
          throw new LifecycleError(
            LifecycleErrorCode.INVALID_CONFIG,
            `GPU ROM file must be located in ${ALLOWED_ROM_DIR}. ` +
            `Configured path '${config.gpuRomfile}' resolves to '${normalizedRomPath}' which is outside the allowed directory.`
          )
        }
      }
      builder.addGpuPassthrough(config.gpuPciAddress, config.gpuRomfile)
    }

    // ===========================================================================
    // Advanced Device Configuration
    // ===========================================================================

    // TPM 2.0 device (required for Windows 11)
    const tpmSocketPath = config.tpmSocketPath ?? qemuConfig?.tpmSocketPath
    if (tpmSocketPath) {
      if (fs.existsSync(tpmSocketPath) || this.isSocketListening(tpmSocketPath)) {
        builder.addTPM(tpmSocketPath)
        this.debug.log('info', `TPM 2.0 enabled via socket: ${tpmSocketPath}`)
      } else {
        this.debug.log('warn', `TPM socket not found: ${tpmSocketPath}. TPM will not be available.`)
      }
    }

    // QEMU Guest Agent channel
    const guestAgentSocketPath = config.guestAgentSocketPath ?? qemuConfig?.guestAgentSocketPath
    if (guestAgentSocketPath) {
      builder.addGuestAgentChannel(guestAgentSocketPath)
      this.debug.log('info', `Guest Agent channel enabled: ${guestAgentSocketPath}`)
    }

    // InfiniService custom channel
    const infiniServiceSocketPath = config.infiniServiceSocketPath ?? qemuConfig?.infiniServiceSocketPath
    if (infiniServiceSocketPath) {
      builder.addInfiniServiceChannel(infiniServiceSocketPath)
      this.debug.log('info', `InfiniService channel enabled: ${infiniServiceSocketPath}`)
    }

    // VirtIO drivers ISO (secondary CD-ROM for Windows)
    const virtioDriversIso = config.virtioDriversIso ?? qemuConfig?.virtioDriversIso
    if (virtioDriversIso) {
      if (fs.existsSync(virtioDriversIso)) {
        builder.addSecondCdrom(virtioDriversIso)
        this.debug.log('info', `VirtIO drivers ISO mounted: ${virtioDriversIso}`)
      } else {
        this.debug.log('warn', `VirtIO drivers ISO not found: ${virtioDriversIso}`)
      }
    }

    // Audio device (Intel HDA)
    const enableAudio = config.enableAudio ?? qemuConfig?.enableAudio ?? false
    if (enableAudio) {
      builder.addAudioDevice()
      this.debug.log('info', 'Intel HDA audio device enabled')
    }

    // USB tablet for absolute mouse positioning
    // Default to true for Windows VMs
    const isWindowsOS = config.os.toLowerCase().includes('windows')
    const enableUsbTablet = config.enableUsbTablet ?? qemuConfig?.enableUsbTablet ?? isWindowsOS
    if (enableUsbTablet) {
      builder.addUsbTablet()
      this.debug.log('info', 'USB tablet device enabled for absolute mouse positioning')
    }

    // ===========================================================================
    // CPU Pinning (numactl wrapper)
    // ===========================================================================

    // Enable NUMA-aware CPU pinning if configured
    // This wraps the QEMU process with numactl for CPU affinity and memory binding
    const enableNumaCtlPinning = config.enableNumaCtlPinning ?? qemuConfig?.enableNumaCtlPinning ?? false
    if (enableNumaCtlPinning) {
      const pinningStrategy = config.cpuPinningStrategy ?? qemuConfig?.cpuPinningStrategy ?? 'basic'
      builder.enableCpuPinning(pinningStrategy, config.cpuCores)
      this.debug.log(`NUMA-aware CPU pinning enabled: strategy=${pinningStrategy}, vCPUs=${config.cpuCores}`)
    }

    // Process options
    builder.setProcessOptions({
      vmId: config.internalName,
      name: config.name,
      uuid: config.uuid,
      daemonize: true,
      pidfile: pidFilePath
    })

    return builder
  }

  /**
   * Waits for a socket file to appear
   */
  private async waitForSocket (socketPath: string, timeout: number = 5000): Promise<void> {
    const startTime = Date.now()
    const pollInterval = 100

    while (Date.now() - startTime < timeout) {
      if (fs.existsSync(socketPath)) {
        return
      }
      await this.sleep(pollInterval)
    }

    throw new LifecycleError(
      LifecycleErrorCode.TIMEOUT,
      `Socket not available after ${timeout}ms: ${socketPath}`
    )
  }

  /**
   * Waits for a process to exit
   */
  private async waitForProcessExit (pid: number, timeout: number): Promise<boolean> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      if (!this.isProcessAlive(pid)) {
        return true
      }
      await this.sleep(PROCESS_EXIT_POLL_INTERVAL)
    }

    return false
  }

  /**
   * Checks if a process is alive
   */
  private isProcessAlive (pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Checks if a socket file exists and is likely a valid socket
   * (useful for checking if swtpm has created a TPM socket)
   */
  private isSocketListening (socketPath: string): boolean {
    try {
      const stats = fs.statSync(socketPath)
      return stats.isSocket()
    } catch {
      return false
    }
  }

  /**
   * Force kills a process
   */
  private async forceKillProcess (pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGKILL')
      // Wait a bit for the process to terminate
      await this.waitForProcessExit(pid, 5000)
    } catch (error) {
      // Process might already be dead
      this.debug.log('warn', `Force kill failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Cleans up resources on failure.
   *
   * The cleanup sequence is carefully ordered to handle "Device or resource busy" errors:
   *
   * 1. Disconnect QMP client (stops VM control communication)
   * 2. Force kill QEMU process (releases VM resources)
   * 3. Wait 500ms for QEMU to fully release network/device resources
   * 4. Bring down TAP device (deactivates network interface)
   * 5. Wait 200ms for kernel to process interface state change
   * 6. Remove firewall chain (must happen BEFORE TAP deletion to avoid busy errors)
   * 7. Wait 200ms for nftables to release TAP device references
   * 8. Destroy TAP device (can now be deleted safely)
   * 9. Clear DB configuration and update status
   * 10. Remove socket files and temporary files
   *
   * Key insight: nftables chains reference TAP devices by name (iifname/oifname).
   * If we try to delete the TAP device while nftables still has active rules
   * referencing it, the kernel returns "Device or resource busy".
   */
  private async cleanup (resources: CleanupResources): Promise<void> {
    this.debug.log('Cleaning up resources after failure')

    // Step 1: Disconnect QMP client
    if (resources.qmpClient) {
      try {
        this.debug.log('Disconnecting QMP client')
        await (resources.qmpClient as QMPClient).disconnect()
        this.debug.log('QMP client disconnected')
      } catch (error) {
        this.debug.log('warn', `Failed to disconnect QMP client: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Step 2: Force kill QEMU process
    if (resources.qemuProcess) {
      try {
        this.debug.log('Force killing QEMU process')
        await (resources.qemuProcess as QemuProcess).forceKill()
        this.debug.log('QEMU process killed')
      } catch (error) {
        this.debug.log('warn', `Failed to kill QEMU process: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Step 3: Wait for QEMU to fully release resources
    // QEMU may still be cleaning up network devices, virtio queues, etc.
    this.debug.log('Waiting 500ms for QEMU resource release')
    await sleep(500)

    // Step 4: Bring down TAP device (if exists)
    // This deactivates the interface before we try to remove firewall rules
    if (resources.tapDevice) {
      try {
        this.debug.log(`Bringing down TAP device: ${resources.tapDevice}`)
        await this.tapManager.bringDown(resources.tapDevice)
        this.debug.log(`TAP device ${resources.tapDevice} is down`)
      } catch (error) {
        this.debug.log('warn', `Failed to bring down TAP device: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Step 5: Wait for kernel to process interface state change
    this.debug.log('Waiting 200ms for interface state change')
    await sleep(200)

    // Step 6: Remove firewall chain BEFORE destroying TAP device
    // This is critical: nftables rules reference the TAP device name.
    // If we delete the TAP first, nftables may have stale references that
    // cause "Device or resource busy" errors on the chain deletion.
    // By removing the chain first, we ensure no firewall rules reference the TAP.
    if (resources.vmId) {
      try {
        this.debug.log(`Removing firewall chain for VM: ${resources.vmId}`)
        await this.nftables.removeVMChain(resources.vmId)
        this.debug.log(`Firewall chain removed for VM: ${resources.vmId}`)
      } catch (error) {
        this.debug.log('warn', `Failed to remove firewall chain: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Step 7: Wait for nftables to release TAP device references
    this.debug.log('Waiting 200ms for nftables resource release')
    await sleep(200)

    // Step 8: Destroy TAP device (now safe to delete)
    if (resources.tapDevice) {
      try {
        this.debug.log(`Destroying TAP device: ${resources.tapDevice}`)
        await this.tapManager.destroy(resources.tapDevice)
        this.debug.log(`TAP device ${resources.tapDevice} destroyed`)
      } catch (error) {
        this.debug.log('warn', `Failed to destroy TAP device: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Step 9: Clear DB configuration
    if (resources.vmId) {
      try {
        this.debug.log(`Clearing DB configuration for VM: ${resources.vmId}`)
        await this.prisma.clearMachineConfiguration(resources.vmId)
        await this.prisma.updateMachineStatus(resources.vmId, 'error')
        this.debug.log(`DB configuration cleared for VM: ${resources.vmId}`)
      } catch (error) {
        this.debug.log('warn', `Failed to clear DB configuration: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Step 10: Remove socket files
    if (resources.qmpSocketPath && fs.existsSync(resources.qmpSocketPath)) {
      try {
        fs.unlinkSync(resources.qmpSocketPath)
        this.debug.log(`Removed QMP socket: ${resources.qmpSocketPath}`)
      } catch (error) {
        this.debug.log('warn', `Failed to remove QMP socket: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Remove guest agent socket
    if (resources.guestAgentSocketPath && fs.existsSync(resources.guestAgentSocketPath)) {
      try {
        fs.unlinkSync(resources.guestAgentSocketPath)
        this.debug.log(`Removed guest agent socket: ${resources.guestAgentSocketPath}`)
      } catch (error) {
        this.debug.log('warn', `Failed to remove guest agent socket: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Remove infini service socket
    if (resources.infiniServiceSocketPath && fs.existsSync(resources.infiniServiceSocketPath)) {
      try {
        fs.unlinkSync(resources.infiniServiceSocketPath)
        this.debug.log(`Removed infini service socket: ${resources.infiniServiceSocketPath}`)
      } catch (error) {
        this.debug.log('warn', `Failed to remove infini service socket: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Remove PID file
    if (resources.pidFilePath && fs.existsSync(resources.pidFilePath)) {
      try {
        fs.unlinkSync(resources.pidFilePath)
        this.debug.log(`Removed PID file: ${resources.pidFilePath}`)
      } catch (error) {
        this.debug.log('warn', `Failed to remove PID file: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Remove installation ISO (temporary file)
    if (resources.installationIsoPath && fs.existsSync(resources.installationIsoPath)) {
      try {
        fs.unlinkSync(resources.installationIsoPath)
        this.debug.log(`Cleaned up installation ISO: ${resources.installationIsoPath}`)
      } catch (error) {
        this.debug.log('warn', `Failed to remove installation ISO: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Note: We don't delete the disk image on failure as it might contain user data
    // The disk cleanup is left to explicit user action

    this.debug.log('Cleanup completed')
  }

  /**
   * Emits an event to the backend EventManager
   */
  private emitEvent (resource: string, action: string, id: string, data?: unknown): void {
    if (this.eventManager?.emitCRUD) {
      try {
        this.eventManager.emitCRUD(resource, action, id, data)
      } catch {
        // Ignore event emission errors
      }
    }
  }

  /**
   * Wraps an error in a LifecycleError
   */
  private wrapError (error: unknown, code: LifecycleErrorCode, vmId?: string): LifecycleError {
    if (error instanceof LifecycleError) {
      return error
    }

    const message = error instanceof Error ? error.message : String(error)
    return new LifecycleError(code, message, vmId)
  }

  /**
   * Sleep utility
   */
  private sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Verifies that QEMU successfully connected to the TAP device.
   * Checks carrier state with retries to allow time for QEMU to attach.
   *
   * When QEMU starts with a TAP device, it should open the TAP file descriptor
   * which brings the carrier up. If the TAP remains in NO-CARRIER state,
   * it indicates QEMU failed to connect (permissions issue, config mismatch, etc.).
   *
   * @param tapDevice - TAP device name to verify
   * @param vmId - VM identifier for error context
   * @param pid - QEMU process PID for diagnostics
   * @param bridge - Bridge name for diagnostics
   * @throws LifecycleError if TAP has no carrier after timeout
   */
  private async verifyTapConnection (
    tapDevice: string,
    vmId: string,
    pid: number,
    bridge: string
  ): Promise<void> {
    const MAX_RETRIES = 10
    const RETRY_DELAY_MS = 500 // Total timeout: 5 seconds

    this.debug.log(`Verifying TAP device connection for ${tapDevice} (VM: ${vmId})`)

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const hasCarrier = await this.tapManager.hasCarrier(tapDevice)

      if (hasCarrier) {
        this.debug.log(`TAP device ${tapDevice} has carrier - QEMU connected successfully (attempt ${attempt}/${MAX_RETRIES})`)
        return
      }

      if (attempt < MAX_RETRIES) {
        this.debug.log(`TAP device ${tapDevice} has no carrier yet, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRIES})`)
        await this.sleep(RETRY_DELAY_MS)
      }
    }

    // Verification failed - collect diagnostic information
    this.debug.log('error', `TAP device ${tapDevice} has no carrier after ${MAX_RETRIES} retries`)

    // Get TAP device state for diagnostics
    const tapState = await this.tapManager.getDeviceState(tapDevice)

    // Get bridge state for diagnostics (reuse tapManager.getDeviceState which uses safe command execution)
    const bridgeState = await this.tapManager.getDeviceState(bridge)

    // Check if QEMU process is still alive
    const processAlive = this.isProcessAlive(pid)

    const errorMessage = [
      `QEMU failed to connect to TAP device ${tapDevice}.`,
      'The TAP device has no carrier, indicating QEMU did not attach to it.',
      'This may be caused by:',
      '  (1) QEMU permissions issue accessing /dev/net/tun',
      '  (2) TAP device configuration error',
      '  (3) QEMU network configuration mismatch',
      '',
      `Diagnostics:`,
      `  - TAP Device: ${tapDevice}`,
      `  - Bridge: ${bridge}`,
      `  - QEMU PID: ${pid}`,
      `  - Process Alive: ${processAlive}`,
      `  - TAP State: ${tapState}`,
      `  - Bridge State: ${bridgeState}`
    ].join('\n')

    throw new LifecycleError(
      LifecycleErrorCode.NETWORK_ERROR,
      errorMessage,
      vmId
    )
  }
}
