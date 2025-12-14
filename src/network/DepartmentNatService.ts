/**
 * DepartmentNatService manages NAT (masquerade) rules for department bridges.
 * Uses nftables ip family for Layer 3 NAT operations.
 *
 * Each department bridge gets a masquerade rule that allows VMs in that
 * subnet to access the internet through the host.
 *
 * @example
 * const natService = new DepartmentNatService()
 *
 * // Initialize NAT infrastructure
 * await natService.initialize()
 *
 * // Add NAT for a department
 * await natService.addMasquerade('10.10.100.0/24', 'infinibr-abc123')
 *
 * // Remove NAT when department is deleted
 * await natService.removeMasquerade('infinibr-abc123')
 */

import { CommandExecutor } from '@utils/commandExecutor'
import { Debugger } from '@utils/debug'

/** Table name for department NAT rules */
const NAT_TABLE_NAME = 'infinibay_nat'
/** nftables family for NAT (IPv4) */
const NAT_TABLE_FAMILY = 'ip'
/** Chain name for postrouting NAT rules */
const NAT_CHAIN_NAME = 'postrouting'

export class DepartmentNatService {
  private executor: CommandExecutor
  private debug: Debugger
  private initialized = false

  constructor () {
    this.executor = new CommandExecutor()
    this.debug = new Debugger('dept-nat')
  }

  /**
   * Initializes the NAT infrastructure.
   * Creates the infinibay_nat table and postrouting chain if they don't exist.
   */
  async initialize (): Promise<void> {
    if (this.initialized) {
      this.debug.log('NAT infrastructure already initialized')
      return
    }

    this.debug.log('Initializing department NAT infrastructure')

    // Create NAT table
    await this.createTableIfNotExists()

    // Create postrouting chain
    await this.createChainIfNotExists()

    // Enable IP forwarding
    await this.enableIPForwarding()

    this.initialized = true
    this.debug.log('Department NAT infrastructure initialized successfully')
  }

  /**
   * Adds a masquerade rule for a department subnet.
   * Traffic from the subnet going out any interface except the bridge will be NAT'd.
   *
   * @param subnet - The department subnet in CIDR notation (e.g., "10.10.100.0/24")
   * @param bridgeName - The bridge name for this department
   */
  async addMasquerade (subnet: string, bridgeName: string): Promise<void> {
    this.debug.log(`Adding masquerade for subnet ${subnet} via bridge ${bridgeName}`)

    await this.ensureInitialized()

    try {
      // Add masquerade rule with comment for identification
      // Traffic from subnet, going out any interface EXCEPT the bridge, gets masqueraded
      await this.exec([
        'add', 'rule', NAT_TABLE_FAMILY, NAT_TABLE_NAME, NAT_CHAIN_NAME,
        'ip', 'saddr', subnet,
        'oifname', '!=', bridgeName,
        'masquerade',
        'comment', `"dept-${bridgeName}"`
      ])

      this.debug.log(`Masquerade rule added for ${subnet} (bridge: ${bridgeName})`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Ignore if rule already exists
      if (errorMessage.includes('File exists')) {
        this.debug.log(`Masquerade rule for ${bridgeName} already exists`)
        return
      }
      throw new Error(`Failed to add masquerade for ${bridgeName}: ${errorMessage}`)
    }
  }

  /**
   * Removes the masquerade rule for a department.
   * Finds the rule by its comment and removes it by handle.
   *
   * @param bridgeName - The bridge name for this department
   */
  async removeMasquerade (bridgeName: string): Promise<void> {
    this.debug.log(`Removing masquerade for bridge ${bridgeName}`)

    await this.ensureInitialized()

    try {
      // List rules with handles
      const output = await this.exec([
        '-a', 'list', 'chain', NAT_TABLE_FAMILY, NAT_TABLE_NAME, NAT_CHAIN_NAME
      ])

      // Find rules with comment containing our bridge name
      // Format: ... handle N ... comment "dept-bridgeName"
      const commentPattern = `dept-${bridgeName}`
      const lines = output.split('\n')

      for (const line of lines) {
        if (line.includes(commentPattern)) {
          // Extract handle number
          const handleMatch = line.match(/handle\s+(\d+)/)
          if (handleMatch && handleMatch[1]) {
            const handle = handleMatch[1]
            await this.exec([
              'delete', 'rule', NAT_TABLE_FAMILY, NAT_TABLE_NAME, NAT_CHAIN_NAME,
              'handle', handle
            ])
            this.debug.log(`Removed masquerade rule handle ${handle} for ${bridgeName}`)
          }
        }
      }

      this.debug.log(`Masquerade rules removed for bridge ${bridgeName}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Ignore if chain doesn't exist
      if (errorMessage.includes('No such file or directory') ||
          errorMessage.includes('does not exist')) {
        this.debug.log(`NAT chain does not exist, nothing to remove for ${bridgeName}`)
        return
      }
      throw new Error(`Failed to remove masquerade for ${bridgeName}: ${errorMessage}`)
    }
  }

  /**
   * Checks if a masquerade rule exists for a department.
   *
   * @param bridgeName - The bridge name for this department
   * @returns true if a masquerade rule exists for this bridge
   */
  async hasMasquerade (bridgeName: string): Promise<boolean> {
    try {
      const output = await this.exec([
        'list', 'chain', NAT_TABLE_FAMILY, NAT_TABLE_NAME, NAT_CHAIN_NAME
      ])

      return output.includes(`dept-${bridgeName}`)
    } catch {
      return false
    }
  }

  /**
   * Lists all department masquerade rules.
   *
   * @returns Array of bridge names that have masquerade rules
   */
  async listMasqueradeRules (): Promise<string[]> {
    try {
      const output = await this.exec([
        'list', 'chain', NAT_TABLE_FAMILY, NAT_TABLE_NAME, NAT_CHAIN_NAME
      ])

      const bridges: string[] = []
      const regex = /comment\s+"dept-([^"]+)"/g
      let match

      while ((match = regex.exec(output)) !== null) {
        if (match[1]) {
          bridges.push(match[1])
        }
      }

      return bridges
    } catch {
      return []
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Creates the NAT table if it doesn't exist.
   */
  private async createTableIfNotExists (): Promise<void> {
    try {
      await this.exec(['add', 'table', NAT_TABLE_FAMILY, NAT_TABLE_NAME])
      this.debug.log(`Created NAT table ${NAT_TABLE_NAME}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorMessage.includes('File exists')) {
        this.debug.log(`NAT table ${NAT_TABLE_NAME} already exists`)
        return
      }
      throw error
    }
  }

  /**
   * Creates the postrouting chain if it doesn't exist.
   */
  private async createChainIfNotExists (): Promise<void> {
    try {
      await this.exec([
        'add', 'chain', NAT_TABLE_FAMILY, NAT_TABLE_NAME, NAT_CHAIN_NAME,
        '{ type nat hook postrouting priority srcnat; policy accept; }'
      ])
      this.debug.log(`Created NAT chain ${NAT_CHAIN_NAME}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorMessage.includes('File exists')) {
        this.debug.log(`NAT chain ${NAT_CHAIN_NAME} already exists`)
        return
      }
      throw error
    }
  }

  /**
   * Enables IP forwarding in the kernel.
   */
  private async enableIPForwarding (): Promise<void> {
    try {
      const output = await this.executor.execute('sysctl', ['net.ipv4.ip_forward'])
      if (output.includes('= 1')) {
        this.debug.log('IP forwarding already enabled')
        return
      }

      await this.executor.execute('sysctl', ['-w', 'net.ipv4.ip_forward=1'])
      this.debug.log('Enabled IP forwarding')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.debug.log('error', `Failed to enable IP forwarding: ${errorMessage}`)
      // Don't throw - this might already be enabled system-wide
    }
  }

  /**
   * Ensures the NAT infrastructure is initialized before operations.
   */
  private async ensureInitialized (): Promise<void> {
    if (!this.initialized) {
      await this.initialize()
    }
  }

  /**
   * Executes an nft command.
   *
   * @param args - Arguments for the nft command
   * @returns Command output
   */
  private async exec (args: string[]): Promise<string> {
    return this.executor.execute('nft', args)
  }
}
