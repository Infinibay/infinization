/**
 * UnattendedInstaller - Orchestrates automated OS installation
 *
 * This class coordinates unattended OS installations by:
 * - Importing and instantiating backend unattended managers
 * - Generating custom ISOs with automated installation configurations
 * - Mounting installation media in QEMU
 * - Monitoring installation progress via QMP events
 * - Cleaning up temporary files after installation
 *
 * @example
 * ```typescript
 * const installer = new UnattendedInstaller({
 *   vmId: 'vm-123',
 *   os: 'ubuntu',
 *   username: 'admin',
 *   password: 'secure123',
 *   applications: [firefoxApp, chromeApp]
 * })
 *
 * const isoPath = await installer.generateInstallationISO()
 * installer.mountInstallationMedia(commandBuilder, isoPath)
 *
 * // After VM starts...
 * await installer.monitorInstallation(qmpClient, isoPath)
 * ```
 */

import * as path from 'path'
import { promises as fsPromises } from 'fs'
import { QemuCommandBuilder } from '../core/QemuCommandBuilder'
import { QMPClient } from '../core/QMPClient'
import { Debugger } from '../utils/debug'
import { InstallationMonitor } from './InstallationMonitor'
import {
  OSType,
  UnattendedInstallConfig,
  UnattendedApplication,
  ScriptExecutionConfig,
  InstallationResult,
  MonitorConfig,
  UnattendedError,
  UnattendedErrorCode,
  CDROM_DEVICE_NAME,
  ISO_BOOT_ORDER,
  DEFAULT_MAX_RESETS,
  DEFAULT_CHECK_INTERVAL,
  getInstallationTimeout,
  isUnattendedError
} from '../types/unattended.types'

/**
 * Interface for backend unattended managers.
 * All managers share this common interface for ISO generation.
 */
interface UnattendedManagerInterface {
  generateNewImage (): Promise<string>
}

/**
 * Manager constructor signature
 */
type ManagerConstructor = new (
  username: string,
  password: string,
  applications: UnattendedApplication[],
  vmId?: string,
  scripts?: ScriptExecutionConfig[]
) => UnattendedManagerInterface

/**
 * Configuration options for UnattendedInstaller
 */
export interface UnattendedInstallerOptions {
  /** Path to the backend services directory containing unattended managers */
  backendServicesPath?: string
  /** Monitoring configuration */
  monitorConfig?: Partial<MonitorConfig>
}

/**
 * Default path to backend services (relative to this file)
 * Can be overridden via INFINIBAY_BACKEND_SERVICES_PATH environment variable
 * or via constructor options
 */
const DEFAULT_BACKEND_SERVICES_PATH = path.resolve(__dirname, '../../../backend/app/services')

/**
 * UnattendedInstaller orchestrates the entire unattended installation process.
 */
export class UnattendedInstaller {
  private readonly debug: Debugger
  private readonly config: UnattendedInstallConfig
  private readonly monitorConfig: MonitorConfig
  private readonly backendServicesPath: string
  private manager: UnattendedManagerInterface | null = null

  /**
   * Creates a new UnattendedInstaller instance
   *
   * @param config - Unattended installation configuration
   * @param options - Optional installer options (backendServicesPath, monitorConfig)
   *
   * @remarks
   * The backend services path can be configured in three ways (in order of precedence):
   * 1. Via the `options.backendServicesPath` parameter
   * 2. Via the `INFINIBAY_BACKEND_SERVICES_PATH` environment variable
   * 3. Default: Relative path to `../../../backend/app/services` from this module
   */
  constructor (config: UnattendedInstallConfig, options?: UnattendedInstallerOptions) {
    this.debug = new Debugger('unattended-installer')
    this.config = config

    // Determine backend services path
    this.backendServicesPath = options?.backendServicesPath ??
      process.env.INFINIBAY_BACKEND_SERVICES_PATH ??
      DEFAULT_BACKEND_SERVICES_PATH

    // Use OS-specific timeout if not explicitly provided
    const osTimeout = getInstallationTimeout(config.os)
    this.monitorConfig = {
      timeout: options?.monitorConfig?.timeout ?? osTimeout,
      maxResets: options?.monitorConfig?.maxResets ?? DEFAULT_MAX_RESETS,
      checkInterval: options?.monitorConfig?.checkInterval ?? DEFAULT_CHECK_INTERVAL
    }
    this.debug.log(`Using installation timeout: ${this.monitorConfig.timeout}ms (${Math.round(this.monitorConfig.timeout / 60000)} minutes) for ${config.os}`)

    this.debug.log(`Backend services path: ${this.backendServicesPath}`)
    this.validateConfig()
  }

  /**
   * Generates a custom installation ISO with automated configuration
   *
   * @returns Promise resolving to the path of the generated ISO
   * @throws UnattendedError if ISO generation fails
   */
  public async generateInstallationISO (): Promise<string> {
    this.debug.log(`Generating installation ISO for ${this.config.os}`)

    try {
      // Get the appropriate manager for the OS
      const manager = await this.getManagerForOS(this.config.os)
      this.manager = manager

      // Generate the custom ISO
      const isoPath = await manager.generateNewImage()

      this.debug.log(`Installation ISO generated: ${isoPath}`)
      return isoPath
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new UnattendedError(
        UnattendedErrorCode.ISO_GENERATION_FAILED,
        `Failed to generate installation ISO: ${message}`,
        error instanceof Error ? error : undefined,
        this.config.vmId
      )
    }
  }

  /**
   * Mounts the installation ISO as a CD-ROM in the QEMU command builder
   *
   * @param builder - QemuCommandBuilder instance
   * @param isoPath - Path to the installation ISO
   */
  public mountInstallationMedia (builder: QemuCommandBuilder, isoPath: string): void {
    this.debug.log(`Mounting installation media: ${isoPath}`)

    try {
      // Add CD-ROM with the installation ISO
      builder.addCdrom(isoPath)

      // Set boot order to boot from CD-ROM first, then disk
      builder.setBootOrder(ISO_BOOT_ORDER)

      this.debug.log('Installation media mounted successfully')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new UnattendedError(
        UnattendedErrorCode.MOUNT_FAILED,
        `Failed to mount installation media: ${message}`,
        error instanceof Error ? error : undefined,
        this.config.vmId
      )
    }
  }

  /**
   * Monitors the installation progress via QMP events
   *
   * This method attaches to QMP events and monitors the installation
   * until completion or failure. It automatically handles cleanup.
   *
   * @param qmpClient - Connected QMPClient instance
   * @param isoPath - Path to the installation ISO (for cleanup)
   * @returns Promise resolving to the installation result
   */
  public async monitorInstallation (
    qmpClient: QMPClient,
    isoPath: string
  ): Promise<InstallationResult> {
    this.debug.log('Starting installation monitoring')

    const monitor = new InstallationMonitor(qmpClient, this.monitorConfig)

    // Forward progress events
    monitor.on('progress', (progress) => {
      this.debug.log(`Installation progress: ${progress.phase} - ${progress.message}`)
    })

    try {
      // Start monitoring
      const result = await monitor.start()

      // Update the ISO path in the result
      result.isoPath = isoPath

      // If successful, perform cleanup
      if (result.success) {
        await this.cleanupInstallationMedia(qmpClient, isoPath)
      }

      return result
    } catch (error) {
      // Ensure monitor is stopped on error
      monitor.stop()

      // If it's already an UnattendedError, rethrow unchanged to preserve the error code
      if (isUnattendedError(error)) {
        throw error
      }

      // Wrap non-UnattendedError in an appropriate error type
      const message = error instanceof Error ? error.message : String(error)
      throw new UnattendedError(
        UnattendedErrorCode.MONITORING_ERROR,
        `Installation monitoring failed: ${message}`,
        error instanceof Error ? error : undefined,
        this.config.vmId
      )
    }
  }

  /**
   * Cleans up installation media after installation completes
   *
   * This method ejects the CD-ROM and deletes the temporary ISO file.
   *
   * @param qmpClient - Connected QMPClient instance
   * @param isoPath - Path to the installation ISO to delete
   */
  public async cleanupInstallationMedia (
    qmpClient: QMPClient,
    isoPath: string
  ): Promise<void> {
    this.debug.log('Cleaning up installation media')

    // Eject the CD-ROM
    try {
      if (qmpClient.isConnected()) {
        await qmpClient.eject(CDROM_DEVICE_NAME, true)
        this.debug.log('CD-ROM ejected successfully')
      }
    } catch (error) {
      // Log but don't fail - CD-ROM ejection is not critical
      this.debug.log('warn', `Failed to eject CD-ROM: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Delete the temporary ISO file
    try {
      await fsPromises.unlink(isoPath)
      this.debug.log(`Temporary ISO deleted: ${isoPath}`)
    } catch (error) {
      // Log but don't fail - file cleanup is not critical
      this.debug.log('warn', `Failed to delete temporary ISO: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Returns the installation configuration
   */
  public getConfig (): UnattendedInstallConfig {
    return { ...this.config }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Validates the installation configuration
   */
  private validateConfig (): void {
    const errors: string[] = []

    if (!this.config.vmId || this.config.vmId.trim().length === 0) {
      errors.push('VM ID is required')
    }

    if (!this.config.os) {
      errors.push('Operating system type is required')
    }

    if (!this.config.username || this.config.username.trim().length === 0) {
      errors.push('Username is required')
    }

    if (!this.config.password || this.config.password.length === 0) {
      errors.push('Password is required')
    }

    // OS-specific validation
    if (this.config.os === 'windows10' || this.config.os === 'windows11') {
      // Windows can work without product key (will activate later)
    }

    if (errors.length > 0) {
      throw new UnattendedError(
        UnattendedErrorCode.INVALID_CONFIG,
        `Invalid unattended install configuration: ${errors.join(', ')}`,
        undefined,
        this.config.vmId,
        { errors }
      )
    }
  }

  /**
   * Gets the appropriate unattended manager for the specified OS
   *
   * @param os - Target operating system
   * @returns Instantiated manager for the OS
   */
  private async getManagerForOS (os: OSType): Promise<UnattendedManagerInterface> {
    this.debug.log(`Loading manager for OS: ${os}`)

    try {
      let ManagerClass: ManagerConstructor
      let managerModuleName: string

      switch (os) {
        case 'ubuntu':
          managerModuleName = 'unattendedUbuntuManager'
          break

        case 'windows10':
        case 'windows11':
          managerModuleName = 'unattendedWindowsManager'
          break

        case 'fedora':
          managerModuleName = 'unattendedRedHatManager'
          break

        default:
          throw new UnattendedError(
            UnattendedErrorCode.UNSUPPORTED_OS,
            `Unsupported operating system: ${os}`,
            undefined,
            this.config.vmId
          )
      }

      const managerModulePath = path.join(this.backendServicesPath, managerModuleName)
      this.debug.log(`Loading manager module from: ${managerModulePath}`)

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const managerModule = require(managerModulePath)

        // Get the appropriate export based on OS
        switch (os) {
          case 'ubuntu':
            ManagerClass = managerModule.UnattendedUbuntuManager
            break
          case 'windows10':
          case 'windows11':
            ManagerClass = managerModule.UnattendedWindowsManager
            break
          case 'fedora':
            ManagerClass = managerModule.UnattendedRedHatManager
            break
          default:
            throw new Error(`No manager class found for ${os}`)
        }
      } catch (moduleError) {
        const errMsg = moduleError instanceof Error ? moduleError.message : String(moduleError)
        throw new UnattendedError(
          UnattendedErrorCode.MANAGER_NOT_FOUND,
          `Failed to load unattended manager module for ${os} from '${managerModulePath}'. ` +
          `Ensure the backend services path is correct. ` +
          `You can configure it via INFINIBAY_BACKEND_SERVICES_PATH environment variable ` +
          `or the backendServicesPath constructor option. Error: ${errMsg}`,
          moduleError instanceof Error ? moduleError : undefined,
          this.config.vmId,
          { managerModulePath, os }
        )
      }

      // Convert applications to the format expected by backend managers
      const applications = this.config.applications?.map(app => ({
        id: app.id,
        name: app.name,
        description: app.description ?? null,
        version: app.version ?? null,
        url: app.url ?? null,
        icon: app.icon ?? null,
        os: app.os,
        installCommand: app.installCommand,
        parameters: app.parameters,
        createdAt: new Date(),
        updatedAt: new Date()
      })) ?? []

      // Instantiate the manager
      const manager = new ManagerClass(
        this.config.username,
        this.config.password,
        applications as unknown as UnattendedApplication[],
        this.config.vmId,
        this.config.scripts ?? []
      )

      this.debug.log(`Manager loaded successfully for ${os}`)
      return manager
    } catch (error) {
      // If it's already an UnattendedError, rethrow
      if (isUnattendedError(error)) {
        throw error
      }

      const message = error instanceof Error ? error.message : String(error)
      throw new UnattendedError(
        UnattendedErrorCode.MANAGER_NOT_FOUND,
        `Failed to load unattended manager for ${os}: ${message}`,
        error instanceof Error ? error : undefined,
        this.config.vmId
      )
    }
  }
}
