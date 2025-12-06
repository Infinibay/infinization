import { CommandExecutor } from '@utils/commandExecutor'
import { Debugger } from '@utils/debug'
import { TAP_NAME_PREFIX, MAX_TAP_NAME_LENGTH, NetworkErrorCode } from '@types/network.types'

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
   * @param vmId - The VM identifier used to generate TAP device name
   * @param bridge - Optional bridge name (not used during creation, only for naming context)
   * @returns The created TAP device name
   * @throws Error if device creation fails
   */
  async create (vmId: string, bridge?: string): Promise<string> {
    const tapName = this.generateTapName(vmId)
    this.debug.log(`Creating TAP device: ${tapName} for VM: ${vmId}${bridge ? ` (bridge: ${bridge})` : ''}`)

    try {
      await this.executor.execute('ip', ['tuntap', 'add', 'dev', tapName, 'mode', 'tap'])
      this.debug.log(`TAP device created successfully: ${tapName}`)
      return tapName
    } catch (error) {
      const message = `Failed to create TAP device ${tapName}: ${error instanceof Error ? error.message : String(error)}`
      this.debug.log('error', message)
      throw new Error(message)
    }
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
   * @param tapName - The TAP device name to destroy
   * @throws Error if destruction fails (but handles non-existent devices gracefully)
   */
  async destroy (tapName: string): Promise<void> {
    this.debug.log(`Destroying TAP device: ${tapName}`)

    try {
      await this.executor.execute('ip', ['link', 'del', tapName])
      this.debug.log(`TAP device destroyed successfully: ${tapName}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Handle gracefully if device doesn't exist
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
