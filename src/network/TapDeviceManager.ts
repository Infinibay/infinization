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
      this.debug.log(`TAP device ${tapName} is now up`)

      // Attach to bridge if specified
      if (bridge) {
        await this.executor.execute('ip', ['link', 'set', tapName, 'master', bridge])
        this.debug.log(`TAP device ${tapName} attached to bridge ${bridge}`)
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
