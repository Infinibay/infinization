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

import { createHash } from 'crypto'
import { CommandExecutor } from '@utils/commandExecutor'
import { Debugger } from '@utils/debug'
import { retryOnBusy, sleep } from '@utils/retry'
import { FirewallRuleTranslator } from './FirewallRuleTranslator'
import { NftablesPersistence } from './NftablesPersistence'
import {
  FirewallRuleInput,
  FirewallApplyResult,
  NftablesErrorCode,
  NftablesError,
  NftablesRuleTokens,
  INFINIVIRT_TABLE_NAME,
  INFINIVIRT_TABLE_FAMILY,
  DEFAULT_CHAIN_PRIORITY,
  generateVMChainName
} from '../types/firewall.types'

/** Delay after removing jump rules before flushing chain (ms) */
const POST_JUMP_REMOVAL_DELAY_MS = 500
/** Delay after flushing chain before deletion (ms) */
const POST_FLUSH_DELAY_MS = 500

/** Base chain name for forwarding VM traffic */
const BASE_FORWARD_CHAIN = 'forward'

export interface NftablesServiceConfig {
  /** Whether to persist rules to disk after changes (default: true) */
  enablePersistence?: boolean
}

export class NftablesService {
  private executor: CommandExecutor
  private debug: Debugger
  /** Cache of rule hashes per VM to detect changes */
  private ruleHashCache: Map<string, string> = new Map()
  /** Persistence handler for disk export/import */
  private persistence: NftablesPersistence
  /** Whether to persist rules to disk after changes */
  private enablePersistence: boolean

  constructor (config: NftablesServiceConfig = {}) {
    this.executor = new CommandExecutor()
    this.debug = new Debugger('nftables')
    this.persistence = new NftablesPersistence()
    this.enablePersistence = config.enablePersistence ?? true
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
    const chainName = generateVMChainName(vmId)
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
    const chainName = generateVMChainName(vmId)
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

      // Inject default rule for established/related traffic
      // This ensures connections initiated by the VM (or accepted via explicit rules) continue to work
      mergedRules.push(this.getDefaultEstablishedRule())
      this.debug.log('Injected default established/related rule (priority 9999)')

      // Sort by priority after adding default rule
      mergedRules.sort((a, b) => a.priority - b.priority)

      result.totalRules = mergedRules.length

      this.debug.log(`Processing ${mergedRules.length} merged rules (including default established/related)`)

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

      // Persist rules to disk after successful apply
      await this.persistToDiskIfEnabled()

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
    const chainName = generateVMChainName(vmId)
    this.debug.log(`Removing VM chain: ${chainName}`)

    try {
      // Step 1: Remove jump rules referencing this chain from the base forward chain
      // This stops new packets from being directed to the VM chain
      await this.removeJumpRules(chainName)

      // Step 1b: Verify jump rules were actually removed
      const verifyOutput = await this.exec([
        '-a', 'list', 'chain',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        BASE_FORWARD_CHAIN
      ])

      const verifyRegex = new RegExp(`jump\\s+${chainName}`, 'g')
      const remainingJumps = verifyOutput.match(verifyRegex)

      if (remainingJumps && remainingJumps.length > 0) {
        this.debug.log('warn', `Found ${remainingJumps.length} remaining jump rules for ${chainName} after removal attempt`)
        // Try one more time to remove them
        await this.removeJumpRules(chainName)
      }

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
          maxRetries: 5,
          initialDelayMs: 500,
          debugNamespace: 'nftables'
        }
      )

      // Clear rules hash cache for this VM
      this.ruleHashCache.delete(vmId)

      this.debug.log(`VM chain removed: ${chainName}`)

      // Persist changes to disk after successful removal
      await this.persistToDiskIfEnabled()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Handle gracefully if chain doesn't exist
      if (errorMessage.includes('No such file or directory') ||
          errorMessage.includes('does not exist') ||
          errorMessage.includes('No such chain')) {
        this.debug.log(`Chain ${chainName} does not exist, nothing to remove`)
        // Still clear cache even if chain didn't exist
        this.ruleHashCache.delete(vmId)
        return
      }

      // Last resort: try to manually flush and delete without retries
      if (errorMessage.includes('Device or resource busy')) {
        this.debug.log('warn', `Attempting manual cleanup for busy chain ${chainName}`)
        try {
          // List all rules in forward chain and manually delete any remaining jumps
          const output = await this.exec([
            '-a', 'list', 'chain',
            INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
            BASE_FORWARD_CHAIN
          ])

          const handleRegex = new RegExp(`jump\\s+${chainName}.*#\\s*handle\\s+(\\d+)`, 'g')
          let match
          while ((match = handleRegex.exec(output)) !== null) {
            const handle = match[1]
            this.debug.log(`Manually removing orphaned jump rule handle ${handle}`)
            await this.exec([
              'delete', 'rule',
              INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
              BASE_FORWARD_CHAIN,
              'handle', handle
            ])
          }

          // Wait and try delete again
          await sleep(1000)
          await this.exec([
            'delete', 'chain',
            INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
            chainName
          ])

          this.debug.log(`Manual cleanup succeeded for chain ${chainName}`)
          this.ruleHashCache.delete(vmId)
          return // Success
        } catch (manualError) {
          this.debug.log('error', `Manual cleanup also failed: ${manualError instanceof Error ? manualError.message : String(manualError)}`)
        }
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
    const chainName = generateVMChainName(vmId)
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
  // Persistent Firewall Methods
  // These methods support persistent firewall rules that survive VM stop/start cycles.
  // The chain and rules persist; only jump rules are attached/detached with TAP lifecycle.
  // ============================================================================

  /**
   * Ensures a VM chain exists without adding jump rules.
   * This is idempotent - safe to call multiple times.
   * Used for persistent firewall where chain outlives TAP device.
   *
   * @param vmId - The VM identifier
   * @returns The chain name
   */
  async ensureVMChain (vmId: string): Promise<string> {
    const chainName = generateVMChainName(vmId)
    this.debug.log(`Ensuring VM chain exists: ${chainName} for VM: ${vmId}`)

    try {
      const exists = await this.chainExists(chainName)
      if (exists) {
        this.debug.log(`Chain ${chainName} already exists`)
        return chainName
      }

      // Create the VM chain (regular chain, no hook)
      await this.exec([
        'add', 'chain',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        chainName
      ])
      this.debug.log(`VM chain created: ${chainName}`)
      return chainName
    } catch (error) {
      const message = `Failed to ensure VM chain ${chainName}: ${error instanceof Error ? error.message : String(error)}`
      this.debug.log('error', message)
      throw this.wrapError(error, NftablesErrorCode.COMMAND_FAILED, {
        command: 'add chain',
        args: [chainName]
      })
    }
  }

  /**
   * Attaches jump rules for a TAP device to route traffic to VM chain.
   * Called when VM starts to connect the active TAP device to persistent rules.
   *
   * @param vmId - The VM identifier
   * @param tapDeviceName - The TAP device name to route traffic from/to
   */
  async attachJumpRules (vmId: string, tapDeviceName: string): Promise<void> {
    const chainName = generateVMChainName(vmId)
    this.debug.log(`Attaching jump rules for VM ${vmId} (chain: ${chainName}, TAP: ${tapDeviceName})`)

    try {
      await this.addJumpRules(chainName, tapDeviceName)
      this.debug.log(`Jump rules attached for VM ${vmId}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // If rules already exist, that's fine
      if (!errorMessage.includes('File exists')) {
        throw this.wrapError(error, NftablesErrorCode.COMMAND_FAILED, {
          command: 'attach jump rules',
          args: [vmId, tapDeviceName]
        })
      }
      this.debug.log(`Jump rules already exist for VM ${vmId}`)
    }
  }

  /**
   * Detaches jump rules when VM stops.
   * The chain and firewall rules persist - only the routing from TAP is removed.
   * This allows rules to survive stop/start cycles.
   *
   * @param vmId - The VM identifier
   */
  async detachJumpRules (vmId: string): Promise<void> {
    const chainName = generateVMChainName(vmId)
    this.debug.log(`Detaching jump rules for VM ${vmId} (chain: ${chainName})`)

    try {
      await this.removeJumpRules(chainName)
      this.debug.log(`Jump rules detached for VM ${vmId} - chain and rules persist`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Log but don't throw - detach is best-effort on stop
      this.debug.log('warn', `Failed to detach jump rules for VM ${vmId}: ${errorMessage}`)
    }
  }

  /**
   * Applies firewall rules only if they have changed since last application.
   * Uses SHA-256 hashing to detect changes, avoiding unnecessary rule flushes.
   * This optimization is important for persistent firewall chains that may be
   * re-applied on VM restart without actual rule changes.
   *
   * @param vmId - The VM identifier
   * @param tapDeviceName - The TAP device name for this VM
   * @param departmentRules - Rules inherited from the department
   * @param vmRules - Rules specific to this VM
   * @returns Object with changed flag and apply result (if changed)
   */
  async applyRulesIfChanged (
    vmId: string,
    tapDeviceName: string,
    departmentRules: FirewallRuleInput[],
    vmRules: FirewallRuleInput[]
  ): Promise<{ changed: boolean; result?: FirewallApplyResult }> {
    // Compute hash of the merged rules (including default established/related rule)
    // This ensures the hash matches the effective rule set applied by applyRules()
    const mergedRules = this.mergeRules(departmentRules, vmRules)
    mergedRules.push(this.getDefaultEstablishedRule())
    const newHash = this.hashRules(mergedRules)
    const cachedHash = this.ruleHashCache.get(vmId)

    if (cachedHash === newHash) {
      this.debug.log(`Rules unchanged for VM ${vmId} (hash: ${newHash.substring(0, 8)}...), skipping apply`)
      return { changed: false }
    }

    this.debug.log(`Rules changed for VM ${vmId} (old: ${cachedHash?.substring(0, 8) ?? 'none'}..., new: ${newHash.substring(0, 8)}...), applying`)

    // Apply the rules
    const result = await this.applyRules(vmId, tapDeviceName, departmentRules, vmRules)

    // Update cache only on successful apply
    if (result.failedRules === 0) {
      this.ruleHashCache.set(vmId, newHash)
      this.debug.log(`Rules hash cached for VM ${vmId}`)
    }

    return { changed: true, result }
  }

  /**
   * Clears the rules hash cache for a VM.
   * Call this when removing a VM to free memory.
   *
   * @param vmId - The VM identifier
   */
  clearRulesCache (vmId: string): void {
    this.ruleHashCache.delete(vmId)
    this.debug.log(`Rules cache cleared for VM ${vmId}`)
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Returns the default established/related rule that is automatically injected.
   * This rule ensures connections initiated by the VM (or accepted via explicit rules) continue to work.
   * Priority 9999 means it's evaluated last, after all user-defined rules.
   */
  private getDefaultEstablishedRule (): FirewallRuleInput {
    return {
      id: '__default_established',
      name: 'Allow Established/Related (Auto)',
      action: 'ACCEPT',
      direction: 'INOUT',
      protocol: 'all',
      priority: 9999,
      connectionState: { established: true, related: true },
      overridesDept: false
    }
  }

  /**
   * Computes a SHA-256 hash of the firewall rules.
   * Rules are sorted by priority before hashing for consistent results.
   */
  private hashRules (rules: FirewallRuleInput[]): string {
    // Sort by priority to ensure consistent hash regardless of input order
    const sorted = [...rules].sort((a, b) => a.priority - b.priority)
    const serialized = JSON.stringify(sorted)
    return createHash('sha256').update(serialized).digest('hex')
  }

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
      // Ensure DHCP rules exist even if chain already exists
      await this.addDHCPAllowRules()
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

    // Add DHCP allow rules to ensure VMs can obtain IP addresses
    await this.addDHCPAllowRules()
  }

  /**
   * Adds rules to allow DHCP traffic in the bridge firewall.
   * This is critical for VMs to obtain IP addresses from dnsmasq.
   *
   * DHCP uses UDP ports 67 (server) and 68 (client) with broadcast.
   * The br_netfilter kernel module causes bridge traffic to pass through
   * nftables, which can block DHCP if not explicitly allowed.
   */
  private async addDHCPAllowRules (): Promise<void> {
    this.debug.log('Adding DHCP allow rules to forward chain')

    // Check if DHCP rules already exist by listing the chain
    try {
      const chainOutput = await this.exec([
        'list', 'chain',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        BASE_FORWARD_CHAIN
      ])

      // If rules already exist, skip adding them
      if (chainOutput.includes('udp dport 67') && chainOutput.includes('udp dport 68')) {
        this.debug.log('DHCP allow rules already exist, skipping')
        return
      }
    } catch {
      // Chain might not exist yet, continue with adding rules
    }

    try {
      // Rule 1: Allow DHCP client -> server (DHCPDISCOVER, DHCPREQUEST)
      // Clients send to UDP port 67, broadcasts from 0.0.0.0:68 to 255.255.255.255:67
      await this.exec([
        'insert', 'rule',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        BASE_FORWARD_CHAIN,
        'udp', 'dport', '67', 'accept',
        'comment', '"Allow DHCP client to server"'
      ])
      this.debug.log('Added DHCP client->server rule (UDP dport 67)')

      // Rule 2: Allow DHCP server -> client (DHCPOFFER, DHCPACK)
      // Server responds from port 67 to client port 68
      await this.exec([
        'insert', 'rule',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        BASE_FORWARD_CHAIN,
        'udp', 'dport', '68', 'accept',
        'comment', '"Allow DHCP server to client"'
      ])
      this.debug.log('Added DHCP server->client rule (UDP dport 68)')

      // Rule 3: Allow broadcast traffic for DHCP discovery
      // DHCP uses broadcast when client doesn't have an IP yet
      await this.exec([
        'insert', 'rule',
        INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
        BASE_FORWARD_CHAIN,
        'pkttype', 'broadcast', 'udp', 'dport', '67', 'accept',
        'comment', '"Allow DHCP broadcast discovery"'
      ])
      this.debug.log('Added DHCP broadcast rule')

      this.debug.log('DHCP allow rules added successfully')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Log but don't throw - DHCP rules are best-effort
      // If they fail, it might be because they already exist or nftables isn't available
      this.debug.log('warn', `Failed to add DHCP allow rules: ${errorMessage}`)
    }
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

      // Log forward chain output for debugging
      this.debug.log(`Forward chain output:\n${output}`)

      // Find and delete rules that jump to this chain
      // Format: ... jump vm_abc123 # handle 42 (handle is at end of line in nft -a output)
      const handleRegex = new RegExp(`jump\\s+${chainName}.*#\\s*handle\\s+(\\d+)`, 'g')
      let match
      const matches: string[] = []

      while ((match = handleRegex.exec(output)) !== null) {
        const handle = match[1]
        matches.push(`handle ${handle}`)
        this.debug.log(`Removing jump rule with handle ${handle}`)

        await this.exec([
          'delete', 'rule',
          INFINIVIRT_TABLE_FAMILY, INFINIVIRT_TABLE_NAME,
          BASE_FORWARD_CHAIN,
          'handle', handle
        ])
      }

      this.debug.log(`Found ${matches.length} jump rules to remove: ${matches.join(', ')}`)

      if (matches.length === 0) {
        this.debug.log('warn', `No jump rules found for chain ${chainName} - may already be removed or regex failed`)
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

  /**
   * Persists the current nftables ruleset to disk if persistence is enabled.
   * Called after rule changes to ensure rules survive reboots.
   * Errors are logged but not thrown to avoid affecting rule application.
   */
  private async persistToDiskIfEnabled (): Promise<void> {
    if (!this.enablePersistence) {
      return
    }

    try {
      const result = await this.persistence.exportToDisk()
      if (result.success) {
        this.debug.log(`Rules persisted to ${result.filePath}`)
      } else {
        this.debug.log('warn', `Failed to persist rules: ${result.error}`)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.debug.log('warn', `Failed to persist rules to disk: ${errorMsg}`)
      // Don't throw - persistence failure shouldn't affect rule application
    }
  }

  // ============================================================================
  // Persistence Public Methods
  // ============================================================================

  /**
   * Gets the persistence handler for direct access to persistence operations.
   * Useful for system startup/shutdown operations.
   *
   * @returns The NftablesPersistence instance
   */
  getPersistence (): NftablesPersistence {
    return this.persistence
  }

  /**
   * Manually triggers a persistence export.
   * Useful when external operations modify rules outside of this service.
   *
   * @returns Result indicating success/failure
   */
  async forcePersist (): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await this.persistence.exportToDisk()
      return { success: result.success, error: result.error }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMsg }
    }
  }
}
