import { CommandExecutor } from '@utils/commandExecutor'
import { Debugger } from '@utils/debug'

/**
 * BridgeManager manages network bridge operations.
 * Uses safe command execution via spawn (no shell concatenation).
 *
 * @example
 * const bridgeManager = new BridgeManager()
 *
 * // Check if bridge exists
 * if (await bridgeManager.exists('virbr0')) {
 *   // Add interface to bridge
 *   await bridgeManager.addInterface('virbr0', 'vnet-abc123')
 * }
 *
 * // List interfaces on a bridge
 * const interfaces = await bridgeManager.listInterfaces('virbr0')
 */
export class BridgeManager {
  private executor: CommandExecutor
  private debug: Debugger

  constructor () {
    this.executor = new CommandExecutor()
    this.debug = new Debugger('bridge')
  }

  /**
   * Checks if a bridge exists.
   * @param bridgeName - The bridge name to check
   * @returns true if bridge exists, false otherwise
   */
  async exists (bridgeName: string): Promise<boolean> {
    this.debug.log(`Checking if bridge exists: ${bridgeName}`)

    try {
      await this.executor.execute('ip', ['link', 'show', bridgeName])
      this.debug.log(`Bridge ${bridgeName} exists`)
      return true
    } catch {
      this.debug.log(`Bridge ${bridgeName} does not exist`)
      return false
    }
  }

  /**
   * Creates a new network bridge.
   * @param bridgeName - The name for the new bridge
   * @throws Error if bridge already exists or creation fails
   */
  async create (bridgeName: string): Promise<void> {
    this.debug.log(`Creating bridge: ${bridgeName}`)

    // Check if bridge already exists
    if (await this.exists(bridgeName)) {
      const message = `Bridge ${bridgeName} already exists`
      this.debug.log('error', message)
      throw new Error(message)
    }

    try {
      // Create the bridge
      await this.executor.execute('ip', ['link', 'add', 'name', bridgeName, 'type', 'bridge'])
      this.debug.log(`Bridge ${bridgeName} created`)

      // Bring the bridge up
      await this.executor.execute('ip', ['link', 'set', bridgeName, 'up'])
      this.debug.log(`Bridge ${bridgeName} is now up`)
    } catch (error) {
      const message = `Failed to create bridge ${bridgeName}: ${error instanceof Error ? error.message : String(error)}`
      this.debug.log('error', message)
      throw new Error(message)
    }
  }

  /**
   * Destroys a network bridge.
   * @param bridgeName - The bridge name to destroy
   * @throws Error if destruction fails (but handles non-existent bridges gracefully)
   */
  async destroy (bridgeName: string): Promise<void> {
    this.debug.log(`Destroying bridge: ${bridgeName}`)

    try {
      // Bring the bridge down first
      await this.executor.execute('ip', ['link', 'set', bridgeName, 'down'])
      this.debug.log(`Bridge ${bridgeName} is now down`)

      // Delete the bridge
      await this.executor.execute('ip', ['link', 'del', bridgeName])
      this.debug.log(`Bridge ${bridgeName} destroyed successfully`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Handle gracefully if bridge doesn't exist
      if (errorMessage.includes('Cannot find device') || errorMessage.includes('No such device')) {
        this.debug.log(`Bridge ${bridgeName} does not exist, nothing to destroy`)
        return
      }
      const message = `Failed to destroy bridge ${bridgeName}: ${errorMessage}`
      this.debug.log('error', message)
      throw new Error(message)
    }
  }

  /**
   * Adds an interface to a bridge.
   * @param bridgeName - The bridge name
   * @param interfaceName - The interface to attach to the bridge
   * @throws Error if bridge doesn't exist or attachment fails
   */
  async addInterface (bridgeName: string, interfaceName: string): Promise<void> {
    this.debug.log(`Adding interface ${interfaceName} to bridge ${bridgeName}`)

    // Verify bridge exists
    if (!await this.exists(bridgeName)) {
      const message = `Bridge ${bridgeName} does not exist`
      this.debug.log('error', message)
      throw new Error(message)
    }

    try {
      await this.executor.execute('ip', ['link', 'set', interfaceName, 'master', bridgeName])
      this.debug.log(`Interface ${interfaceName} attached to bridge ${bridgeName}`)
    } catch (error) {
      const message = `Failed to add interface ${interfaceName} to bridge ${bridgeName}: ${error instanceof Error ? error.message : String(error)}`
      this.debug.log('error', message)
      throw new Error(message)
    }
  }

  /**
   * Removes an interface from a bridge.
   * @param bridgeName - The bridge name (used for logging)
   * @param interfaceName - The interface to detach from the bridge
   * @throws Error if removal fails (but handles non-existent interfaces gracefully)
   */
  async removeInterface (bridgeName: string, interfaceName: string): Promise<void> {
    this.debug.log(`Removing interface ${interfaceName} from bridge ${bridgeName}`)

    try {
      await this.executor.execute('ip', ['link', 'set', interfaceName, 'nomaster'])
      this.debug.log(`Interface ${interfaceName} detached from bridge ${bridgeName}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Handle gracefully if interface doesn't exist
      if (errorMessage.includes('Cannot find device') || errorMessage.includes('No such device')) {
        this.debug.log(`Interface ${interfaceName} does not exist, nothing to remove`)
        return
      }
      const message = `Failed to remove interface ${interfaceName} from bridge ${bridgeName}: ${errorMessage}`
      this.debug.log('error', message)
      throw new Error(message)
    }
  }

  /**
   * Lists all interfaces attached to a bridge.
   * @param bridgeName - The bridge name
   * @returns Array of interface names attached to the bridge
   */
  async listInterfaces (bridgeName: string): Promise<string[]> {
    this.debug.log(`Listing interfaces on bridge ${bridgeName}`)

    try {
      const output = await this.executor.execute('ip', ['link', 'show', 'master', bridgeName])

      // Parse output to extract interface names
      // Output format: "N: interface_name@... state ..."
      const interfaces: string[] = []
      const lines = output.split('\n')

      for (const line of lines) {
        // Match lines that start with a number followed by interface name
        const match = line.match(/^\d+:\s+([^:@\s]+)/)
        if (match && match[1]) {
          interfaces.push(match[1])
        }
      }

      this.debug.log(`Found ${interfaces.length} interfaces on bridge ${bridgeName}: ${interfaces.join(', ') || 'none'}`)
      return interfaces
    } catch {
      // If command fails (e.g., bridge doesn't exist), return empty array
      this.debug.log(`Could not list interfaces on bridge ${bridgeName}, returning empty list`)
      return []
    }
  }
}
