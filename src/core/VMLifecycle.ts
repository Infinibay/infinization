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
import { PrismaAdapter } from '../db/PrismaAdapter'
import { EventHandler } from '../sync/EventHandler'
import { Debugger } from '../utils/debug'
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
      pidFilePath: paths.pidFilePath
    }

    try {
      // 1. Ensure directories exist
      await this.ensureDirectories()

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
      this.debug.log(`Creating TAP device for VM: ${vmId}`)
      const tapDevice = await this.tapManager.create(vmId, config.bridge)
      resources.tapDevice = tapDevice
      await this.tapManager.configure(tapDevice, config.bridge)

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

      const qemuConfig = {
        machineType: effectiveMachineType,
        cpuModel: effectiveCpuModel,
        diskBus: effectiveDiskBus,
        diskCacheMode: effectiveDiskCacheMode,
        networkModel: effectiveNetworkModel,
        networkQueues: effectiveNetworkQueues,
        memoryBalloon: effectiveMemoryBalloon,
        uefiFirmware: effectiveUefiFirmware,
        hugepages: effectiveHugepages
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

      // 8a. Apply CPU pinning if configured (best-effort, applyCpuPinning handles errors internally)
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
        graphicPort: config.displayPort,
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
          : null
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
        displayPort: config.displayPort,
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
        await this.prisma.updateMachineStatus(vmId, 'off')
        await this.prisma.clearMachineConfiguration(vmId)
        this.debug.log(`VM ${vmId} was marked running but process dead, resetting`)
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

      resources.diskPaths = diskPaths
      resources.qmpSocketPath = qmpSocketPath
      resources.pidFilePath = pidFilePath

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

      // 8. Get display configuration (use stored or defaults)
      const displayProtocol = (vmConfig.configuration?.graphicProtocol as 'spice' | 'vnc') ?? 'spice'
      const displayPort = vmConfig.configuration?.graphicPort ?? 5900
      const displayPassword = vmConfig.configuration?.graphicPassword ?? undefined
      const displayAddr = vmConfig.configuration?.graphicHost ?? '0.0.0.0'

      // 9. Generate MAC address deterministically from vmId
      const macAddress = MacAddressGenerator.generateFromVmId(vmId)
      this.debug.log(`MAC address: ${macAddress}`)

      // 10. Get network bridge from configuration with fallback to default
      const bridge = vmConfig.configuration?.bridge ?? 'virbr0'

      // 11. Create and configure TAP device
      this.debug.log(`Creating TAP device for VM: ${vmId}`)
      const tapDevice = await this.tapManager.create(vmId, bridge)
      resources.tapDevice = tapDevice
      await this.tapManager.configure(tapDevice, bridge)

      // 12. Setup firewall
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
          hugepages: vmConfig.configuration?.hugepages
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

      // 14a. Apply CPU pinning if configured (best-effort, applyCpuPinning handles errors internally)
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
   * Stops a running VM.
   *
   * Sends graceful shutdown via ACPI, waits for exit, force kills if timeout,
   * cleans up TAP device and firewall, updates database.
   *
   * @param vmId - VM identifier
   * @param config - Stop configuration (default: graceful with 30s timeout and force)
   * @returns VMOperationResult indicating success or failure
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

      // Check if already stopped
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

      // Try graceful shutdown via QMP
      if (stopConfig.graceful && qmpSocketPath && pid) {
        try {
          const qmpClient = new QMPClient(qmpSocketPath, {
            connectTimeout: DEFAULT_QMP_CONNECT_TIMEOUT
          })

          try {
            await qmpClient.connect()
            await qmpClient.powerdown()
            this.debug.log(`Sent powerdown command to VM: ${vmId}`)

            // Wait for process to exit
            const exited = await this.waitForProcessExit(pid, stopConfig.timeout)

            if (!exited && stopConfig.force) {
              this.debug.log(`Graceful shutdown timed out, force killing VM: ${vmId}`)
              await this.forceKillProcess(pid)
              forced = true
            }
          } finally {
            await qmpClient.disconnect()
          }
        } catch (qmpError) {
          // QMP failed, try force kill if enabled
          this.debug.log('warn', `QMP connection failed: ${qmpError instanceof Error ? qmpError.message : String(qmpError)}`)
          if (stopConfig.force && pid && this.isProcessAlive(pid)) {
            this.debug.log(`Force killing VM: ${vmId}`)
            await this.forceKillProcess(pid)
            forced = true
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

      // Clear machine configuration (qmpSocketPath, qemuPid, tapDeviceName)
      // This ensures HealthMonitor won't attempt to check a stale PID
      await this.prisma.clearMachineConfiguration(vmId)

      // Cleanup network resources
      if (tapDevice) {
        try {
          await this.tapManager.destroy(tapDevice)
        } catch (tapError) {
          this.debug.log('warn', `Failed to destroy TAP device: ${tapError instanceof Error ? tapError.message : String(tapError)}`)
        }
      }

      // Remove firewall chain
      try {
        await this.nftables.removeVMChain(vmId)
      } catch (fwError) {
        this.debug.log('warn', `Failed to remove firewall chain: ${fwError instanceof Error ? fwError.message : String(fwError)}`)
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
    const dirs = [this.diskDir, this.qmpSocketDir, this.pidfileDir]
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
      // E.g., /usr/share/OVMF/OVMF_CODE.fd -> /usr/share/OVMF/OVMF_VARS.fd
      const firmwareDir = path.dirname(firmwarePath)
      const templatePaths = [
        path.join(firmwareDir, 'OVMF_VARS.fd'),
        path.join(firmwareDir, 'OVMF_VARS.ms.fd'),
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

    // Display
    if (config.displayType === 'spice') {
      const spiceConfig = new SpiceConfig({
        port: config.displayPort,
        addr: config.displayAddr ?? '0.0.0.0',
        password: config.displayPassword,
        disableTicketing: !config.displayPassword,
        enableAgent: true
      })
      builder.addSpice(spiceConfig)
    } else {
      const vncConfig = new VncConfig({
        display: config.displayPort,
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
        const ALLOWED_ROM_DIR = '/var/lib/infinivirt/roms/'
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
   * Cleans up resources on failure
   */
  private async cleanup (resources: CleanupResources): Promise<void> {
    this.debug.log('Cleaning up resources after failure')

    // Disconnect QMP client
    if (resources.qmpClient) {
      try {
        await (resources.qmpClient as QMPClient).disconnect()
      } catch {
        // Ignore cleanup errors
      }
    }

    // Force kill QEMU process
    if (resources.qemuProcess) {
      try {
        await (resources.qemuProcess as QemuProcess).forceKill()
      } catch {
        // Ignore cleanup errors
      }
    }

    // Destroy TAP device
    if (resources.tapDevice) {
      try {
        await this.tapManager.destroy(resources.tapDevice)
      } catch {
        // Ignore cleanup errors
      }
    }

    // Remove firewall chain
    if (resources.vmId) {
      try {
        await this.nftables.removeVMChain(resources.vmId)
      } catch {
        // Ignore cleanup errors
      }

      // Clear DB configuration
      try {
        await this.prisma.clearMachineConfiguration(resources.vmId)
        await this.prisma.updateMachineStatus(resources.vmId, 'error')
      } catch {
        // Ignore cleanup errors
      }
    }

    // Remove socket file
    if (resources.qmpSocketPath && fs.existsSync(resources.qmpSocketPath)) {
      try {
        fs.unlinkSync(resources.qmpSocketPath)
      } catch {
        // Ignore cleanup errors
      }
    }

    // Remove PID file
    if (resources.pidFilePath && fs.existsSync(resources.pidFilePath)) {
      try {
        fs.unlinkSync(resources.pidFilePath)
      } catch {
        // Ignore cleanup errors
      }
    }

    // Remove installation ISO (temporary file)
    if (resources.installationIsoPath && fs.existsSync(resources.installationIsoPath)) {
      try {
        fs.unlinkSync(resources.installationIsoPath)
        this.debug.log(`Cleaned up installation ISO: ${resources.installationIsoPath}`)
      } catch {
        // Ignore cleanup errors
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
}
