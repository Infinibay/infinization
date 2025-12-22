import { CommandExecutor } from '../utils/commandExecutor'
import { Debugger } from '../utils/debug'
import { retryOnBusy, sleep } from '../utils/retry'
import { TAP_NAME_PREFIX, MAX_TAP_NAME_LENGTH, NetworkErrorCode } from '../types/network.types'

/** Delay after bringing down TAP device before deletion (ms) */
const POST_BRINGDOWN_DELAY_MS = 200
/** Maximum retries for device creation when busy */
const CREATE_MAX_RETRIES = 3
/** Delay between creation retries (ms) */
const CREATE_RETRY_DELAY_MS = 500

/**
 * TapDeviceManager manages TAP network devices for VMs.
 * Uses safe command execution via spawn (no shell concatenation).
 *
 * @example
 * const tapManager = new TapDeviceManager()
 *
 * // Create and configure a TAP device
 * const tapName = await tapManager.create('vm-abc123', 'virbr0')
 * await tapManager.configure(tapName, 'virbr0')
 *
 * // Later, destroy the device
 * await tapManager.destroy(tapName)
 */
export class TapDeviceManager {
  private executor: CommandExecutor
  private debug: Debugger

  constructor () {
    this.executor = new CommandExecutor()
    this.debug = new Debugger('tap-device')
  }

  /**
   * Creates a new TAP device for a VM.
   * Handles cleanup of orphaned devices and retries on busy resources.
   *
   * @param vmId - The VM identifier used to generate TAP device name
   * @param bridge - Optional bridge name (not used during creation, only for naming context)
   * @returns The created TAP device name
   * @throws Error if device creation fails after all retries
   */
  async create (vmId: string, bridge?: string): Promise<string> {
    const tapName = this.generateTapName(vmId)
    this.debug.log(`Creating TAP device: ${tapName} for VM: ${vmId}${bridge ? ` (bridge: ${bridge})` : ''}`)

    // Proactively clean up any orphaned TAP devices before creating new ones
    // This handles TAP devices left behind by crashed/killed QEMU processes
    this.debug.log('Running orphaned TAP device cleanup before creation')
    const cleanupStats = await this.cleanupOrphanedTapDevices()
    if (cleanupStats.cleaned > 0) {
      this.debug.log(`Cleaned ${cleanupStats.cleaned} orphaned TAP devices before creating ${tapName}`)
    }

    // Check if device already exists (orphaned from previous run) and clean it up
    if (await this.exists(tapName)) {
      this.debug.log(`TAP device ${tapName} already exists (orphaned), cleaning up first`)
      await this.destroy(tapName)
      // Wait after cleanup for kernel to fully release resources
      await sleep(POST_BRINGDOWN_DELAY_MS)
    }

    // Retry creation with backoff in case resource is briefly busy after cleanup
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= CREATE_MAX_RETRIES; attempt++) {
      try {
        await this.executor.execute('ip', ['tuntap', 'add', 'dev', tapName, 'mode', 'tap'])
        this.debug.log(`TAP device created successfully: ${tapName}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
        return tapName
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        const errorMessage = lastError.message.toLowerCase()

        // Check if this is a busy/unavailable error that might resolve with a retry
        const isBusyError = errorMessage.includes('device or resource busy') ||
                           errorMessage.includes('resource temporarily unavailable') ||
                           errorMessage.includes('file exists')

        if (isBusyError && attempt < CREATE_MAX_RETRIES) {
          this.debug.log(`TAP creation attempt ${attempt}/${CREATE_MAX_RETRIES} failed (resource busy), retrying in ${CREATE_RETRY_DELAY_MS}ms...`)
          await sleep(CREATE_RETRY_DELAY_MS)
          continue
        }

        break
      }
    }

    const message = `Failed to create TAP device ${tapName}: ${lastError?.message ?? 'Unknown error'}`
    this.debug.log('error', message)
    throw new Error(message)
  }

  /**
   * Configures a TAP device by bringing it up and optionally attaching to a bridge.
   * @param tapName - The TAP device name to configure
   * @param bridge - Optional bridge name to attach the device to
   * @throws Error if configuration fails
   */
  async configure (tapName: string, bridge?: string): Promise<void> {
    this.debug.log(`Configuring TAP device: ${tapName}${bridge ? ` with bridge: ${bridge}` : ''}`)

    try {
      // Bring interface up
      await this.executor.execute('ip', ['link', 'set', tapName, 'up'])
      this.debug.log(`TAP device ${tapName} brought up successfully (checking carrier...)`)

      // Disable checksum offloading to fix DHCP issues with virtio-net
      // When offloading is enabled, broadcast DHCP packets may have invalid checksums
      // that cause them to be dropped before reaching the VM
      await this.executor.execute('ethtool', ['-K', tapName, 'tx', 'off', 'rx', 'off'])
      this.debug.log(`TAP device ${tapName} checksum offloading disabled`)

      // Attach to bridge if specified
      if (bridge) {
        await this.executor.execute('ip', ['link', 'set', tapName, 'master', bridge])
        this.debug.log(`TAP device ${tapName} attached to bridge ${bridge} (waiting for QEMU connection...)`)
      }
    } catch (error) {
      const message = `Failed to configure TAP device ${tapName}: ${error instanceof Error ? error.message : String(error)}`
      this.debug.log('error', message)
      throw new Error(message)
    }
  }

  /**
   * Destroys a TAP device.
   * First brings the device down, waits for kernel to release resources,
   * then deletes the device with retries on busy errors.
   *
   * @param tapName - The TAP device name to destroy
   * @throws Error if destruction fails (but handles non-existent devices gracefully)
   */
  async destroy (tapName: string): Promise<void> {
    this.debug.log(`Destroying TAP device: ${tapName}`)

    // First check if device exists
    if (!await this.exists(tapName)) {
      this.debug.log(`TAP device ${tapName} does not exist, nothing to destroy`)
      return
    }

    // Bring device down first to release kernel resources
    await this.bringDown(tapName)
    this.debug.log(`TAP device ${tapName} brought down, waiting ${POST_BRINGDOWN_DELAY_MS}ms for kernel cleanup`)

    // Wait for kernel to release resources after bringing down
    await sleep(POST_BRINGDOWN_DELAY_MS)

    // Delete the device with retries on busy errors
    try {
      await retryOnBusy(
        async () => {
          await this.executor.execute('ip', ['link', 'del', tapName])
        },
        {
          maxRetries: 3,
          initialDelayMs: 300,
          debugNamespace: 'tap-device'
        }
      )
      this.debug.log(`TAP device destroyed successfully: ${tapName}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Handle gracefully if device doesn't exist (might have been removed during retry delays)
      if (errorMessage.includes('Cannot find device') || errorMessage.includes('No such device')) {
        this.debug.log(`TAP device ${tapName} does not exist, nothing to destroy`)
        return
      }
      const message = `Failed to destroy TAP device ${tapName}: ${errorMessage}`
      this.debug.log('error', message)
      throw new Error(message)
    }
  }

  /**
   * Brings a TAP device down (deactivates it).
   * This must be done before deletion to allow kernel to release resources.
   *
   * @param tapName - The TAP device name to bring down
   */
  async bringDown (tapName: string): Promise<void> {
    this.debug.log(`Bringing down TAP device: ${tapName}`)

    try {
      await this.executor.execute('ip', ['link', 'set', tapName, 'down'])
      this.debug.log(`TAP device ${tapName} is now down`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Handle gracefully if device doesn't exist or is already down
      if (errorMessage.includes('Cannot find device') ||
          errorMessage.includes('No such device') ||
          errorMessage.includes('not found')) {
        this.debug.log(`TAP device ${tapName} does not exist or is already down`)
        return
      }
      // Log warning but don't throw - bringDown is best-effort before deletion
      this.debug.log('warn', `Failed to bring down TAP device ${tapName}: ${errorMessage}`)
    }
  }

  /**
   * Detaches a TAP device from its bridge without destroying it.
   * The device remains configured and can be quickly reattached on VM restart.
   * This enables persistent firewall rules that survive VM stop/start cycles.
   *
   * @param tapName - The TAP device name to detach
   */
  async detachFromBridge (tapName: string): Promise<void> {
    this.debug.log(`Detaching TAP device ${tapName} from bridge`)

    if (!await this.exists(tapName)) {
      this.debug.log(`TAP device ${tapName} does not exist, nothing to detach`)
      return
    }

    try {
      // Remove from bridge using nomaster
      await this.executor.execute('ip', ['link', 'set', tapName, 'nomaster'])
      this.debug.log(`TAP device ${tapName} removed from bridge`)

      // Bring interface down
      await this.executor.execute('ip', ['link', 'set', tapName, 'down'])
      this.debug.log(`TAP device ${tapName} is now down (detached)`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Handle gracefully - device might already be detached or not exist
      if (errorMessage.includes('Cannot find device') ||
          errorMessage.includes('No such device') ||
          errorMessage.includes('not found')) {
        this.debug.log(`TAP device ${tapName} does not exist or already detached`)
        return
      }
      // Log warning but don't throw - detach is best-effort
      this.debug.log('warn', `Failed to detach TAP device ${tapName}: ${errorMessage}`)
    }
  }

  /**
   * Attaches an existing TAP device to a bridge.
   * Used when restarting a VM to reuse the existing TAP device.
   *
   * @param tapName - The TAP device name to attach
   * @param bridge - The bridge name to attach to
   * @throws Error if device doesn't exist or attachment fails
   */
  async attachToBridge (tapName: string, bridge: string): Promise<void> {
    this.debug.log(`Attaching TAP device ${tapName} to bridge ${bridge}`)

    if (!await this.exists(tapName)) {
      throw new Error(`TAP device ${tapName} does not exist, cannot attach to bridge`)
    }

    try {
      // Bring interface up first
      await this.executor.execute('ip', ['link', 'set', tapName, 'up'])
      this.debug.log(`TAP device ${tapName} is now up`)

      // Attach to bridge
      await this.executor.execute('ip', ['link', 'set', tapName, 'master', bridge])
      this.debug.log(`TAP device ${tapName} attached to bridge ${bridge}`)
    } catch (error) {
      const message = `Failed to attach TAP device ${tapName} to bridge ${bridge}: ${error instanceof Error ? error.message : String(error)}`
      this.debug.log('error', message)
      throw new Error(message)
    }
  }

  /**
   * Checks if a TAP device exists.
   * @param tapName - The TAP device name to check
   * @returns true if device exists, false otherwise
   */
  async exists (tapName: string): Promise<boolean> {
    this.debug.log(`Checking if TAP device exists: ${tapName}`)

    try {
      await this.executor.execute('ip', ['link', 'show', tapName])
      this.debug.log(`TAP device ${tapName} exists`)
      return true
    } catch {
      this.debug.log(`TAP device ${tapName} does not exist`)
      return false
    }
  }

  /**
   * Checks if a TAP device has carrier (QEMU connected).
   * A TAP device has carrier when QEMU has successfully attached to it.
   * Without carrier (NO-CARRIER flag present), the VM has no network connectivity.
   *
   * @param tapName - The TAP device name to check
   * @returns true if device has carrier, false otherwise
   */
  async hasCarrier (tapName: string): Promise<boolean> {
    this.debug.log(`Checking carrier status for TAP device: ${tapName}`)

    try {
      const output = await this.executor.execute('ip', ['link', 'show', tapName])

      // Parse the first line for interface flags
      // Example outputs:
      // "12: vnet-abc123: <NO-CARRIER,BROADCAST,MULTICAST,UP> ..." -> no carrier
      // "12: vnet-abc123: <BROADCAST,MULTICAST,UP,LOWER_UP> ..." -> has carrier
      const firstLine = output.split('\n')[0]

      // Check for NO-CARRIER flag (indicates QEMU not connected)
      if (firstLine.includes('NO-CARRIER')) {
        this.debug.log(`TAP device ${tapName} has NO-CARRIER flag (QEMU not connected or disconnected)`)
        return false
      }

      // Check for LOWER_UP which indicates carrier present and link layer is up
      // Also check UP to ensure the interface is administratively up
      const hasUp = firstLine.includes(',UP') || firstLine.includes('<UP')
      const hasLowerUp = firstLine.includes('LOWER_UP')

      if (hasUp && hasLowerUp) {
        this.debug.log(`TAP device ${tapName} has carrier (QEMU connected, flags: UP,LOWER_UP)`)
        return true
      }

      // UP but no LOWER_UP and no NO-CARRIER - ambiguous state, treat as no carrier
      this.debug.log(`TAP device ${tapName} in ambiguous state - no LOWER_UP flag`)
      return false
    } catch (error) {
      // Device doesn't exist or other error - treat as no carrier
      this.debug.log(`Failed to check carrier for ${tapName}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Lists all TAP devices in the system that match our naming convention.
   * Scans the system for TAP/TUN devices with the TAP_NAME_PREFIX (vnet-).
   *
   * @returns Array of TAP device names found in the system
   */
  async listAllTapDevices (): Promise<string[]> {
    this.debug.log(`Scanning system for TAP devices with prefix ${TAP_NAME_PREFIX}`)

    try {
      const output = await this.executor.execute('ip', ['link', 'show', 'type', 'tuntap'])

      // Parse output to extract device names
      // Each device line starts with: "index: device_name: <flags>..."
      const deviceNames: string[] = []
      const lines = output.split('\n')

      for (const line of lines) {
        // Match lines like: "12: vnet-abc123: <BROADCAST,MULTICAST,UP>"
        const match = line.match(/^\d+:\s+([^:@]+)[@:]/)
        if (match) {
          const deviceName = match[1].trim()
          // Only include devices with our prefix
          if (deviceName.startsWith(TAP_NAME_PREFIX)) {
            deviceNames.push(deviceName)
          }
        }
      }

      this.debug.log(`Found ${deviceNames.length} TAP devices: [${deviceNames.join(', ')}]`)
      return deviceNames
    } catch (error) {
      // Return empty array if command fails (e.g., no tuntap devices exist)
      this.debug.log(`Failed to list TAP devices: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /**
   * Determines if a TAP device is orphaned.
   * A TAP device is considered orphaned if it:
   * - Has the 'persist on' flag set (won't auto-cleanup)
   * - Does NOT have carrier (QEMU not connected)
   *
   * @param tapName - The TAP device name to check
   * @returns true if device is orphaned, false otherwise
   */
  async isOrphaned (tapName: string): Promise<boolean> {
    this.debug.log(`Checking if ${tapName} is orphaned...`)

    // Check if device exists
    if (!await this.exists(tapName)) {
      this.debug.log(`Device ${tapName} does not exist, not orphaned`)
      return false
    }

    // Check carrier status
    const hasCarrierStatus = await this.hasCarrier(tapName)
    this.debug.log(`Device ${tapName} has carrier: ${hasCarrierStatus}`)

    if (hasCarrierStatus) {
      this.debug.log(`Device ${tapName} has carrier (active), not orphaned`)
      return false
    }

    // Check for persist flag using detailed link info
    try {
      const output = await this.executor.execute('ip', ['-d', 'link', 'show', tapName])
      const hasPersist = output.includes('persist on')
      this.debug.log(`Device ${tapName} has persist flag: ${hasPersist}`)

      if (hasPersist) {
        this.debug.log(`Device ${tapName} is ORPHANED (persist on + no carrier)`)
        return true
      } else {
        this.debug.log(`Device ${tapName} is not persistent, will auto-cleanup`)
        return false
      }
    } catch (error) {
      this.debug.log(`Failed to check persist flag for ${tapName}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Cleans up all orphaned TAP devices in the system.
   * Scans for TAP devices with our prefix that have 'persist on' but no carrier,
   * indicating they were left behind by crashed/killed QEMU processes.
   *
   * @returns Statistics about the cleanup operation
   */
  async cleanupOrphanedTapDevices (): Promise<{ total: number; cleaned: number; failed: number }> {
    this.debug.log('Starting orphaned TAP device cleanup scan')

    const stats = { total: 0, cleaned: 0, failed: 0 }
    const tapDevices = await this.listAllTapDevices()
    stats.total = tapDevices.length

    if (tapDevices.length === 0) {
      this.debug.log('No TAP devices found in system, nothing to clean')
      return stats
    }

    for (const tapName of tapDevices) {
      try {
        if (await this.isOrphaned(tapName)) {
          this.debug.log(`Cleaning orphaned TAP device: ${tapName}`)
          await this.destroy(tapName)
          stats.cleaned++
          this.debug.log(`Successfully cleaned orphaned TAP device: ${tapName}`)
        }
      } catch (error) {
        stats.failed++
        this.debug.log('warn', `Failed to clean ${tapName}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    this.debug.log(`Orphaned TAP cleanup complete: ${stats.cleaned}/${stats.total} devices removed, ${stats.failed} failures`)
    return stats
  }

  /**
   * Gets the current state of a TAP device for diagnostic purposes.
   * @param tapName - The TAP device name to check
   * @returns The full output of `ip link show` for the device, or error message
   */
  async getDeviceState (tapName: string): Promise<string> {
    try {
      const output = await this.executor.execute('ip', ['link', 'show', tapName])
      return output.trim()
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * Generates a TAP device name from a VM ID.
   * Format: vnet-{first-8-chars-of-vmId}
   * Ensures name is valid for Linux interface naming (max 15 chars).
   * @param vmId - The VM identifier
   * @returns A valid TAP device name
   */
  private generateTapName (vmId: string): string {
    // Calculate max length for vmId portion
    const maxVmIdLength = MAX_TAP_NAME_LENGTH - TAP_NAME_PREFIX.length

    // Take first N characters of vmId (removing any non-alphanumeric characters)
    const sanitizedVmId = vmId.replace(/[^a-zA-Z0-9]/g, '').substring(0, maxVmIdLength)

    return `${TAP_NAME_PREFIX}${sanitizedVmId}`
  }
}
