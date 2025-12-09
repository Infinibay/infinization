/**
 * NftablesService manages VM firewall rules using nftables.
 * Uses the bridge family for Layer 2 filtering on TAP devices.
 *
 * @example
 * import { NftablesService } from '@network/NftablesService'
 *
 * const nftables = new NftablesService()
 *
 * // Initialize nftables infrastructure
 * await nftables.initialize()
 *
 * // Create firewall chain for VM
 * const chainName = await nftables.createVMChain('vm-abc123', 'vnet-abc12345')
 *
 * // Apply firewall rules
 * const result = await nftables.applyRules(
 *   'vm-abc123',
 *   'vnet-abc12345',
 *   departmentRules,
 *   vmRules
 * )
 *
 * // Later, remove VM firewall
 * await nftables.removeVMChain('vm-abc123')
 */

import { CommandExecutor } from '@utils/commandExecutor'
import { Debugger } from '@utils/debug'
import { retryOnBusy, sleep } from '@utils/retry'
import { FirewallRuleTranslator } from './FirewallRuleTranslator'
import {
  FirewallRuleInput,
  FirewallApplyResult,
  NftablesErrorCode,
  NftablesError,
  NftablesRuleTokens,
  INFINIVIRT_TABLE_NAME,
  INFINIVIRT_TABLE_FAMILY,
  DEFAULT_CHAIN_PRIORITY,
  VM_CHAIN_PREFIX,
  MAX_CHAIN_NAME_LENGTH
} from '../types/firewall.types'

/** Delay after removing jump rules before flushing chain (ms) */
const POST_JUMP_REMOVAL_DELAY_MS = 200
/** Delay after flushing chain before deletion (ms) */
const POST_FLUSH_DELAY_MS = 200

/** Base chain name for forwarding VM traffic */
const BASE_FORWARD_CHAIN = 'forward'

export class NftablesService {
  private executor: CommandExecutor
  private debug: Debugger

  constructor () {
    this.executor = new CommandExecutor()
    this.debug = new Debugger('nftables')
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Initializes the nftables infrastructure for VM firewall management.
   * Creates the infinivirt table and base forward chain if they don't exist.
   *
   * @throws Error if initialization fails (except for already-exists errors)
   */
  async initialize (): Promise<void> {
    this.debug.log('Initializing nftables infrastructure')

    // Create table (bridge family for Layer 2 filtering)
    await this.createTableIfNotExists()

    // Create base forward chain with hook
    await this.createBaseChainIfNotExists()

    this.debug.log('nftables infrastructure initialized successfully')
  }

  /**
   * Creates a firewall chain for a specific VM.
   * The chain will be named using the VM ID and attached to the base forward chain.
   *
   * @param vmId - The VM identifier
   * @param tapDeviceName - The TAP device name for this VM
   * @returns The created chain name
   * @throws Error if chain creation fails
   */
  async createVMChain (vmId: string, tapDeviceName: string): Promise<string> {
    const chainName = this.generateChainName(vmId)
    this.debug.log(`Creating VM chain: ${chainName} for VM: ${vmId} (TAP: ${tapDeviceName})`)

    try {
      // Check if chain already exists
      const exists = await this.chainExists(chainName)
      if (exists) {
        this.debug.log(`Chain ${chainName} already exists, skipping creation`)
      } else {
        // Create the VM chain (regular chain, no hook)
        await this.exec([
          'add', 'chain',
          INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
          chainName
        ])
        this.debug.log(`VM chain created: ${chainName}`)
      }

      // Add jump rules from base forward chain to VM chain for this TAP device
      // We need rules for both directions (traffic to and from the VM)
      await this.addJumpRules(chainName, tapDeviceName)

      return chainName
    } catch (error) {
      const message = `Failed to create VM chain ${chainName}: ${error instanceof Error ? error.message : String(error)}`
      this.debug.log('error', message)
      throw this.wrapError(error, NftablesErrorCode.COMMAND_FAILED, {
        command: 'add chain',
        args: [chainName]
      })
    }
  }

  /**
   * Applies firewall rules to a VM.
   * Merges department rules with VM-specific rules, respecting overridesDept flags.
   *
   * @param vmId - The VM identifier
   * @param tapDeviceName - The TAP device name for this VM
   * @param departmentRules - Rules inherited from the department
   * @param vmRules - Rules specific to this VM
   * @returns Result containing count of applied/failed rules
   */
  async applyRules (
    vmId: string,
    tapDeviceName: string,
    departmentRules: FirewallRuleInput[],
    vmRules: FirewallRuleInput[]
  ): Promise<FirewallApplyResult> {
    const chainName = this.generateChainName(vmId)
    this.debug.log(`Applying firewall rules to chain ${chainName} for VM ${vmId}`)

    const result: FirewallApplyResult = {
      totalRules: 0,
      appliedRules: 0,
      failedRules: 0,
      chainName,
      failures: []
    }

    try {
      // Ensure chain exists
      const exists = await this.chainExists(chainName)
      if (!exists) {
        this.debug.log(`Chain ${chainName} does not exist, creating it`)
        await this.createVMChain(vmId, tapDeviceName)
      }

      // Flush existing rules in the chain before applying new ones
      await this.flushVMRules(vmId)

      // Merge rules (VM rules can override department rules)
      const mergedRules = this.mergeRules(departmentRules, vmRules)
      result.totalRules = mergedRules.length

      this.debug.log(`Processing ${mergedRules.length} merged rules`)

      // Apply each rule
      // Note: Rules are applied in priority order (ascending). Since nftables evaluates
      // rules in the order they were added to the chain, applying rules sorted by priority
      // ensures the intended evaluation order. For stronger guarantees in future iterations,
      // consider using explicit insert semantics (e.g., `insert rule` with position handles).
      for (const rule of mergedRules) {
        try {
          // Handle INOUT direction by creating two rules (one for each direction)
          // The translator only handles concrete directions (IN or OUT), so we expand
          // INOUT here to maintain clear separation of responsibilities.
          if (rule.direction === 'INOUT') {
            // Create rule for IN direction
            const inRule = { ...rule, direction: 'IN' as const }
            const inTokens = FirewallRuleTranslator.translateToTokens(inRule, tapDeviceName)
            await this.addRuleTokens(chainName, inTokens)

            // Create rule for OUT direction
            const outRule = { ...rule, direction: 'OUT' as const }
            const outTokens = FirewallRuleTranslator.translateToTokens(outRule, tapDeviceName)
            await this.addRuleTokens(chainName, outTokens)
          } else {
            const tokens = FirewallRuleTranslator.translateToTokens(rule, tapDeviceName)
            await this.addRuleTokens(chainName, tokens)
          }

          result.appliedRules++
          this.debug.log(`Applied rule: ${rule.name}`)
        } catch (error) {
          result.failedRules++
          const errorMsg = error instanceof Error ? error.message : String(error)
          result.failures.push({
            ruleName: rule.name,
            error: errorMsg
          })
          this.debug.log('error', `Failed to apply rule ${rule.name}: ${errorMsg}`)
        }
      }

      this.debug.log(`Applied ${result.appliedRules}/${result.totalRules} rules to chain ${chainName}`)
      return result
    } catch (error) {
      const message = `Failed to apply rules to chain ${chainName}: ${error instanceof Error ? error.message : String(error)}`
      this.debug.log('error', message)
      throw this.wrapError(error, NftablesErrorCode.COMMAND_FAILED)
    }
  }

  /**
   * Removes a VM's firewall chain and all its rules.
   * Also removes jump rules from the base forward chain.
   *
   * The removal sequence is carefully ordered with delays to handle busy resources:
   * 1. Remove jump rules from forward chain (stops new traffic from reaching VM chain)
   * 2. Wait for kernel to process rule removal
   * 3. Flush all rules in VM chain
   * 4. Wait for kernel to release chain resources
   * 5. Delete the chain with retries on busy errors
   *
   * @param vmId - The VM identifier
   */
  async removeVMChain (vmId: string): Promise<void> {
    const chainName = this.generateChainName(vmId)
    this.debug.log(`Removing VM chain: ${chainName}`)

    try {
      // Step 1: Remove jump rules referencing this chain from the base forward chain
      // This stops new packets from being directed to the VM chain
      await this.removeJumpRules(chainName)

      // Step 2: Wait for kernel to process jump rule removal
      // This ensures no new packets are being processed by the chain
      await sleep(POST_JUMP_REMOVAL_DELAY_MS)

      // Step 3: Check if chain exists before trying to delete
      const exists = await this.chainExists(chainName)
      if (!exists) {
        this.debug.log(`Chain ${chainName} does not exist, nothing to remove`)
        return
      }

      // Step 4: Flush all rules in the chain first (required before deletion)
      await this.exec([
        'flush', 'chain',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        chainName
      ])

      // Step 5: Wait for kernel to release chain resources after flush
      await sleep(POST_FLUSH_DELAY_MS)

      // Step 6: Delete the chain with retries on busy errors
      await retryOnBusy(
        async () => {
          await this.exec([
            'delete', 'chain',
            INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
            chainName
          ])
        },
        {
          maxRetries: 3,
          initialDelayMs: 300,
          debugNamespace: 'nftables'
        }
      )

      this.debug.log(`VM chain removed: ${chainName}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Handle gracefully if chain doesn't exist
      if (errorMessage.includes('No such file or directory') ||
          errorMessage.includes('does not exist') ||
          errorMessage.includes('No such chain')) {
        this.debug.log(`Chain ${chainName} does not exist, nothing to remove`)
        return
      }

      this.debug.log('error', `Failed to remove chain ${chainName}: ${errorMessage}`)
      // Don't throw on cleanup operations - log and continue
    }
  }

  /**
   * Flushes all rules from a VM's chain without deleting the chain.
   * Useful for re-applying updated rules.
   *
   * @param vmId - The VM identifier
   */
  async flushVMRules (vmId: string): Promise<void> {
    const chainName = this.generateChainName(vmId)
    this.debug.log(`Flushing rules from chain: ${chainName}`)

    try {
      await this.exec([
        'flush', 'chain',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        chainName
      ])
      this.debug.log(`Rules flushed from chain: ${chainName}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Handle gracefully if chain doesn't exist
      if (errorMessage.includes('does not exist') ||
          errorMessage.includes('No such chain')) {
        this.debug.log(`Chain ${chainName} does not exist, nothing to flush`)
        return
      }

      this.debug.log('error', `Failed to flush rules from chain ${chainName}: ${errorMessage}`)
      // Don't throw on flush operations - log and continue
    }
  }

  /**
   * Lists all chains in the infinivirt table.
   * Useful for debugging and health checks.
   *
   * @returns Array of chain names
   */
  async listChains (): Promise<string[]> {
    this.debug.log('Listing chains in infinivirt table')

    try {
      const output = await this.exec([
        'list', 'chains',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME
      ])

      // Parse output to extract chain names
      // Format: table bridge infinivirt { chain forward { ... } chain vm_abc { ... } }
      const chainRegex = /chain\s+(\w+)\s*\{/g
      const chains: string[] = []
      let match

      while ((match = chainRegex.exec(output)) !== null) {
        chains.push(match[1])
      }

      this.debug.log(`Found ${chains.length} chains: ${chains.join(', ')}`)
      return chains
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // If table doesn't exist, return empty array
      if (errorMessage.includes('does not exist') ||
          errorMessage.includes('No such table')) {
        this.debug.log('Table does not exist, returning empty chain list')
        return []
      }

      this.debug.log('error', `Failed to list chains: ${errorMessage}`)
      throw this.wrapError(error, NftablesErrorCode.COMMAND_FAILED)
    }
  }

  /**
   * Checks if a chain exists in the infinivirt table.
   *
   * @param chainName - Chain name to check
   * @returns true if chain exists
   */
  async chainExists (chainName: string): Promise<boolean> {
    this.debug.log(`Checking if chain exists: ${chainName}`)

    try {
      await this.exec([
        'list', 'chain',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        chainName
      ])
      this.debug.log(`Chain ${chainName} exists`)
      return true
    } catch {
      this.debug.log(`Chain ${chainName} does not exist`)
      return false
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Creates the infinivirt table if it doesn't already exist.
   */
  private async createTableIfNotExists (): Promise<void> {
    try {
      // Try to list the table - if it exists, we're done
      await this.exec(['list', 'table', INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME])
      this.debug.log(`Table ${INFINIVIRT_TABLE_FAMILY} ${INFINIVIRT_TABLE_NAME} already exists`)
    } catch {
      // Table doesn't exist, create it
      this.debug.log(`Creating table ${INFINIVIRT_TABLE_FAMILY} ${INFINIVIRT_TABLE_NAME}`)
      await this.exec([
        'add', 'table',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME
      ])
      this.debug.log(`Table created: ${INFINIVIRT_TABLE_FAMILY} ${INFINIVIRT_TABLE_NAME}`)
    }
  }

  /**
   * Creates the base forward chain with hook if it doesn't exist.
   */
  private async createBaseChainIfNotExists (): Promise<void> {
    const chainExists = await this.chainExists(BASE_FORWARD_CHAIN)

    if (chainExists) {
      this.debug.log(`Base chain ${BASE_FORWARD_CHAIN} already exists`)
      return
    }

    this.debug.log(`Creating base chain ${BASE_FORWARD_CHAIN}`)

    // Create base chain with forward hook
    // The chain definition includes: type filter, hook forward, priority 0
    await this.exec([
      'add', 'chain',
      INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
      BASE_FORWARD_CHAIN,
      '{ type filter hook forward priority ' + DEFAULT_CHAIN_PRIORITY + '; policy accept; }'
    ])

    this.debug.log(`Base chain created: ${BASE_FORWARD_CHAIN}`)
  }

  /**
   * Adds jump rules from the base forward chain to a VM chain.
   * Creates rules for both traffic directions (to and from the VM).
   */
  private async addJumpRules (chainName: string, tapDeviceName: string): Promise<void> {
    this.debug.log(`Adding jump rules for chain ${chainName} (TAP: ${tapDeviceName})`)

    // Jump rule for traffic TO the VM (output interface is TAP)
    // Using tokens directly to avoid issues with quoted strings
    const toVmTokens: NftablesRuleTokens = ['oifname', tapDeviceName, 'jump', chainName]

    // Jump rule for traffic FROM the VM (input interface is TAP)
    const fromVmTokens: NftablesRuleTokens = ['iifname', tapDeviceName, 'jump', chainName]

    try {
      // Add both jump rules
      await this.addRuleTokens(BASE_FORWARD_CHAIN, toVmTokens)
      await this.addRuleTokens(BASE_FORWARD_CHAIN, fromVmTokens)

      this.debug.log(`Jump rules added for chain ${chainName}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // If rule already exists, that's fine
      if (!errorMessage.includes('File exists')) {
        throw error
      }
      this.debug.log(`Jump rules already exist for chain ${chainName}`)
    }
  }

  /**
   * Removes jump rules referencing a VM chain from the base forward chain.
   */
  private async removeJumpRules (chainName: string): Promise<void> {
    this.debug.log(`Removing jump rules for chain ${chainName}`)

    try {
      // Get current rules in the forward chain
      const output = await this.exec([
        '-a', 'list', 'chain',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        BASE_FORWARD_CHAIN
      ])

      // Find and delete rules that jump to this chain
      // Format: rule bridge infinivirt forward handle N ...jump chainName
      const handleRegex = new RegExp(`handle\\s+(\\d+)\\s+.*jump\\s+${chainName}`, 'g')
      let match

      while ((match = handleRegex.exec(output)) !== null) {
        const handle = match[1]
        this.debug.log(`Removing jump rule with handle ${handle}`)

        await this.exec([
          'delete', 'rule',
          INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
          BASE_FORWARD_CHAIN,
          'handle', handle
        ])
      }

      this.debug.log(`Jump rules removed for chain ${chainName}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Log but don't throw - cleanup should be best-effort
      this.debug.log('error', `Failed to remove jump rules for ${chainName}: ${errorMessage}`)
    }
  }

  /**
   * Adds a single rule to a chain using token array.
   * This method accepts an array of tokens that are spread directly into the
   * nft command, avoiding issues with space-splitting quoted values.
   *
   * @param chainName - The chain to add the rule to
   * @param tokens - Array of rule tokens (e.g., ['oifname', 'vnet-abc', 'accept'])
   */
  private async addRuleTokens (chainName: string, tokens: NftablesRuleTokens): Promise<void> {
    await this.exec([
      'add', 'rule',
      INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
      chainName,
      ...tokens
    ])
  }

  /**
   * Merges department rules with VM rules.
   * VM rules with overridesDept=true will exclude conflicting department rules.
   *
   * IMPORTANT: Rule Priority Ordering
   * ---------------------------------
   * Rules are sorted by their `priority` field (ascending order, where lower number = higher priority).
   * Since nftables evaluates rules in the order they are added to a chain, we rely on append order
   * to enforce priority. Rules are applied sequentially in `applyRules()` after sorting.
   *
   * This means:
   * - Rules added first (lower priority number) are evaluated first by nftables
   * - The first matching rule determines the action for the packet
   * - No other part of the system should write rules to these VM chains to avoid unexpected reordering
   *
   * For stronger guarantees in future iterations, consider using explicit insert semantics
   * (e.g., `nft insert rule` with position handles or index-based insertion).
   *
   * @param departmentRules - Rules from department
   * @param vmRules - Rules specific to VM
   * @returns Merged and sorted rules (by priority ascending)
   */
  private mergeRules (
    departmentRules: FirewallRuleInput[],
    vmRules: FirewallRuleInput[]
  ): FirewallRuleInput[] {
    // Find VM rules that override department rules
    const overridingRules = vmRules.filter(r => r.overridesDept)

    // Filter out department rules that are overridden
    // A department rule is considered overridden if there's a VM rule with overridesDept=true
    // that has the same direction and protocol (simple conflict detection)
    const filteredDeptRules = departmentRules.filter(deptRule => {
      return !overridingRules.some(vmRule =>
        vmRule.direction === deptRule.direction &&
        vmRule.protocol.toLowerCase() === deptRule.protocol.toLowerCase()
      )
    })

    // Combine and sort by priority (lower number = higher priority in evaluation order)
    // This sorting is critical: rules with lower priority numbers are added to the chain first
    // and will be evaluated first by nftables
    const merged = [...filteredDeptRules, ...vmRules]
    merged.sort((a, b) => a.priority - b.priority)

    this.debug.log(
      `Merged ${departmentRules.length} dept rules + ${vmRules.length} VM rules = ${merged.length} total (sorted by priority)`
    )

    return merged
  }

  /**
   * Generates a chain name from a VM ID.
   * Format: vm_{first-8-chars-of-vmId-sanitized}
   */
  private generateChainName (vmId: string): string {
    // Remove non-alphanumeric characters and take first 8 chars
    const sanitizedId = vmId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8).toLowerCase()

    const chainName = `${VM_CHAIN_PREFIX}${sanitizedId}`

    // Ensure name doesn't exceed max length
    if (chainName.length > MAX_CHAIN_NAME_LENGTH) {
      return chainName.substring(0, MAX_CHAIN_NAME_LENGTH)
    }

    return chainName
  }

  /**
   * Executes an nftables command using CommandExecutor.
   * Wraps the command with debug logging and error handling.
   */
  private async exec (args: string[]): Promise<string> {
    this.debug.log(`Executing: nft ${args.join(' ')}`)

    try {
      const result = await this.executor.execute('nft', args)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.debug.log('error', `nft command failed: ${message}`)
      throw error
    }
  }

  /**
   * Wraps an error in a structured NftablesError.
   */
  private wrapError (
    error: unknown,
    code: NftablesErrorCode,
    context?: { command?: string; args?: string[] }
  ): NftablesError {
    const originalMessage = error instanceof Error ? error.message : String(error)
    const nftError = new Error(originalMessage) as NftablesError
    nftError.code = code
    nftError.context = context

    return nftError
  }
}
