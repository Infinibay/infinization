/**
 * FirewallRuleTranslator translates Prisma FirewallRule models to nftables syntax.
 * This is a pure utility class with static methods for easy testing and reuse.
 *
 * @example
 * import { FirewallRuleTranslator } from '@network/FirewallRuleTranslator'
 *
 * const rule = {
 *   id: 'rule-1',
 *   name: 'Allow HTTPS',
 *   action: 'ACCEPT',
 *   direction: 'IN',
 *   protocol: 'tcp',
 *   dstPortStart: 443,
 *   dstPortEnd: 443,
 *   priority: 100
 * }
 *
 * const nftablesRule = FirewallRuleTranslator.translate(rule, 'vnet-abc12345')
 * // Result: 'oifname "vnet-abc12345" ip protocol tcp tcp dport 443 accept comment "Allow HTTPS"'
 */

import {
  FirewallRuleInput,
  ConnectionStateConfig,
  SUPPORTED_PROTOCOLS,
  CONNECTION_STATES,
  NftablesErrorCode,
  NftablesRuleTokens
} from '../types/firewall.types'

/** Type for rule direction from Prisma schema - only concrete directions, not INOUT */
type RuleDirection = 'IN' | 'OUT'

/** Type for rule action from Prisma schema */
type RuleAction = 'ACCEPT' | 'DROP' | 'REJECT'

/** Supported protocol type derived from SUPPORTED_PROTOCOLS constant */
type SupportedProtocol = typeof SUPPORTED_PROTOCOLS[number]

export class FirewallRuleTranslator {
  /**
   * Translates a Prisma FirewallRule to nftables rule tokens.
   *
   * Returns an array of tokens that can be passed directly to nft command
   * without any string splitting, which avoids issues with quoted values.
   *
   * @param rule - The FirewallRule to translate
   * @param tapDeviceName - The TAP device name for this VM
   * @returns Array of nftables command tokens
   * @throws Error if rule is invalid or unsupported
   */
  static translateToTokens (rule: FirewallRuleInput, tapDeviceName: string): NftablesRuleTokens {
    // Validate rule before translation
    this.validateRule(rule)

    const tokens: NftablesRuleTokens = []

    // Add direction filter (interface matching)
    const directionTokens = this.translateDirectionToTokens(rule.direction as RuleDirection, tapDeviceName)
    tokens.push(...directionTokens)

    // Add protocol filter (protocol has been validated by validateRule)
    const protocolTokens = this.translateProtocolToTokens(rule.protocol.toLowerCase() as SupportedProtocol)
    tokens.push(...protocolTokens)

    // Add IP address filters
    const ipTokens = this.translateIpAddressesToTokens(
      rule.srcIpAddr ?? undefined,
      rule.srcIpMask ?? undefined,
      rule.dstIpAddr ?? undefined,
      rule.dstIpMask ?? undefined
    )
    tokens.push(...ipTokens)

    // Add port filters (only for tcp/udp)
    const portTokens = this.translatePortsToTokens(
      rule.protocol,
      rule.srcPortStart ?? undefined,
      rule.srcPortEnd ?? undefined,
      rule.dstPortStart ?? undefined,
      rule.dstPortEnd ?? undefined
    )
    tokens.push(...portTokens)

    // Add connection state tracking
    const stateTokens = this.translateConnectionStateToTokens(rule.connectionState as ConnectionStateConfig | undefined)
    tokens.push(...stateTokens)

    // Add action
    tokens.push(this.translateAction(rule.action as RuleAction))

    // Add comment if rule has a name
    if (rule.name) {
      const safeComment = rule.name.substring(0, 64)
      tokens.push('comment', safeComment)
    }

    return tokens
  }

  /**
   * Translates rule direction to nftables interface matching tokens.
   *
   * For bridge family filtering:
   * - IN (traffic TO the VM) → ['oifname', tapDeviceName]
   * - OUT (traffic FROM the VM) → ['iifname', tapDeviceName]
   *
   * Note: INOUT direction is NOT handled here. The NftablesService is responsible
   * for expanding composite directions like INOUT into separate IN and OUT calls
   * to this translator. This keeps responsibilities clear and avoids asymmetric
   * translation logic.
   *
   * @param direction - Rule direction (IN or OUT only, not INOUT)
   * @param tapDeviceName - TAP device name
   * @returns Array of tokens for interface matching
   * @throws Error if direction is not IN or OUT
   */
  static translateDirectionToTokens (direction: RuleDirection, tapDeviceName: string): NftablesRuleTokens {
    switch (direction) {
      case 'IN':
        // Traffic going TO the VM (output through TAP interface)
        return ['oifname', tapDeviceName]
      case 'OUT':
        // Traffic coming FROM the VM (input from TAP interface)
        return ['iifname', tapDeviceName]
      default:
        // This should never happen if validateRule and NftablesService work correctly
        throw this.createError(
          NftablesErrorCode.RULE_INVALID,
          `Invalid direction for translation: ${direction}. Only IN or OUT are supported. INOUT must be expanded by the caller.`
        )
    }
  }

  /**
   * Translates protocol to nftables protocol match tokens.
   *
   * This method assumes the protocol has already been validated by validateRule()
   * and only accepts protocols from SUPPORTED_PROTOCOLS ('tcp', 'udp', 'icmp', 'all').
   *
   * @param protocol - Protocol name (must be one of SUPPORTED_PROTOCOLS)
   * @returns Array of tokens for protocol matching
   * @throws Error if protocol is not in SUPPORTED_PROTOCOLS
   */
  static translateProtocolToTokens (protocol: SupportedProtocol): NftablesRuleTokens {
    const normalizedProtocol = protocol.toLowerCase() as SupportedProtocol

    // 'all' means no protocol filter
    if (normalizedProtocol === 'all') {
      return []
    }

    // For bridge family, we match the IP protocol
    switch (normalizedProtocol) {
      case 'tcp':
      case 'udp':
        return ['ip', 'protocol', normalizedProtocol]
      case 'icmp':
        return ['ip', 'protocol', 'icmp']
      default:
        // This should never happen if validateRule() is called first
        // The type system should prevent this, but we throw for safety
        throw this.createError(
          NftablesErrorCode.UNSUPPORTED_PROTOCOL,
          `Unsupported protocol: ${protocol}. Supported protocols are: ${SUPPORTED_PROTOCOLS.join(', ')}`
        )
    }
  }

  /**
   * Translates port ranges to nftables port match tokens.
   * Only applicable for tcp and udp protocols.
   *
   * @param protocol - Protocol (only tcp/udp support ports)
   * @param srcPortStart - Source port range start
   * @param srcPortEnd - Source port range end
   * @param dstPortStart - Destination port range start
   * @param dstPortEnd - Destination port range end
   * @returns Array of tokens for port matching
   */
  static translatePortsToTokens (
    protocol: string,
    srcPortStart?: number,
    srcPortEnd?: number,
    dstPortStart?: number,
    dstPortEnd?: number
  ): NftablesRuleTokens {
    const normalizedProtocol = protocol.toLowerCase()

    // Ports only make sense for tcp/udp
    if (normalizedProtocol !== 'tcp' && normalizedProtocol !== 'udp') {
      return []
    }

    const tokens: NftablesRuleTokens = []

    // Source port filter
    if (srcPortStart !== undefined) {
      if (srcPortEnd !== undefined && srcPortEnd !== srcPortStart) {
        // Port range
        tokens.push(normalizedProtocol, 'sport', `${srcPortStart}-${srcPortEnd}`)
      } else {
        // Single port
        tokens.push(normalizedProtocol, 'sport', srcPortStart.toString())
      }
    }

    // Destination port filter
    if (dstPortStart !== undefined) {
      if (dstPortEnd !== undefined && dstPortEnd !== dstPortStart) {
        // Port range
        tokens.push(normalizedProtocol, 'dport', `${dstPortStart}-${dstPortEnd}`)
      } else {
        // Single port
        tokens.push(normalizedProtocol, 'dport', dstPortStart.toString())
      }
    }

    return tokens
  }

  /**
   * Translates IP addresses and masks to nftables address match tokens.
   *
   * @param srcIpAddr - Source IP address
   * @param srcIpMask - Source IP mask (CIDR notation or dotted decimal)
   * @param dstIpAddr - Destination IP address
   * @param dstIpMask - Destination IP mask
   * @returns Array of tokens for IP address matching
   */
  static translateIpAddressesToTokens (
    srcIpAddr?: string,
    srcIpMask?: string,
    dstIpAddr?: string,
    dstIpMask?: string
  ): NftablesRuleTokens {
    const tokens: NftablesRuleTokens = []

    // Source IP filter
    if (srcIpAddr) {
      if (srcIpMask) {
        // Convert dotted decimal mask to CIDR if needed
        const cidr = this.maskToCidr(srcIpMask)
        tokens.push('ip', 'saddr', `${srcIpAddr}/${cidr}`)
      } else {
        tokens.push('ip', 'saddr', srcIpAddr)
      }
    }

    // Destination IP filter
    if (dstIpAddr) {
      if (dstIpMask) {
        const cidr = this.maskToCidr(dstIpMask)
        tokens.push('ip', 'daddr', `${dstIpAddr}/${cidr}`)
      } else {
        tokens.push('ip', 'daddr', dstIpAddr)
      }
    }

    return tokens
  }

  /**
   * Translates connection state configuration to nftables ct state tokens.
   *
   * @param connectionState - Connection state configuration object
   * @returns Array of tokens for connection state matching
   */
  static translateConnectionStateToTokens (connectionState?: ConnectionStateConfig): NftablesRuleTokens {
    if (!connectionState) {
      return []
    }

    const enabledStates: string[] = []

    if (connectionState.established) {
      enabledStates.push('established')
    }
    if (connectionState.new) {
      enabledStates.push('new')
    }
    if (connectionState.related) {
      enabledStates.push('related')
    }
    if (connectionState.invalid) {
      enabledStates.push('invalid')
    }

    if (enabledStates.length === 0) {
      return []
    }

    // nftables syntax: ct state {state1,state2,...}
    // For single state, no braces needed
    if (enabledStates.length === 1) {
      return ['ct', 'state', enabledStates[0]]
    }

    // Multiple states need braces (as a single token since nft parses it that way)
    return ['ct', 'state', `{ ${enabledStates.join(', ')} }`]
  }

  /**
   * Translates rule action to nftables action.
   *
   * @param action - Rule action (ACCEPT, DROP, REJECT)
   * @returns nftables action (lowercase)
   */
  static translateAction (action: RuleAction): string {
    return action.toLowerCase()
  }

  /**
   * Validates a firewall rule before translation.
   * Throws descriptive errors if validation fails.
   *
   * @param rule - Rule to validate
   * @throws Error with descriptive message if invalid
   */
  static validateRule (rule: FirewallRuleInput): void {
    // Check required fields
    if (!rule.name) {
      throw this.createError(
        NftablesErrorCode.RULE_INVALID,
        'Rule name is required',
        rule.id
      )
    }

    if (!rule.action) {
      throw this.createError(
        NftablesErrorCode.RULE_INVALID,
        'Rule action is required',
        rule.id
      )
    }

    if (!rule.direction) {
      throw this.createError(
        NftablesErrorCode.RULE_INVALID,
        'Rule direction is required',
        rule.id
      )
    }

    // Validate protocol
    const normalizedProtocol = (rule.protocol || 'all').toLowerCase()
    if (!SUPPORTED_PROTOCOLS.includes(normalizedProtocol as typeof SUPPORTED_PROTOCOLS[number])) {
      throw this.createError(
        NftablesErrorCode.UNSUPPORTED_PROTOCOL,
        `Unsupported protocol: ${rule.protocol}`,
        rule.id
      )
    }

    // Validate port ranges
    if (rule.srcPortStart != null && rule.srcPortEnd != null) {
      if (rule.srcPortStart > rule.srcPortEnd) {
        throw this.createError(
          NftablesErrorCode.INVALID_PORT_RANGE,
          `Source port range invalid: start (${rule.srcPortStart}) > end (${rule.srcPortEnd})`,
          rule.id
        )
      }
    }

    if (rule.dstPortStart != null && rule.dstPortEnd != null) {
      if (rule.dstPortStart > rule.dstPortEnd) {
        throw this.createError(
          NftablesErrorCode.INVALID_PORT_RANGE,
          `Destination port range invalid: start (${rule.dstPortStart}) > end (${rule.dstPortEnd})`,
          rule.id
        )
      }
    }

    // Validate port values
    const validatePort = (port: number | undefined | null, name: string) => {
      if (port !== undefined && port !== null) {
        if (port < 0 || port > 65535) {
          throw this.createError(
            NftablesErrorCode.INVALID_PORT_RANGE,
            `${name} port out of range: ${port} (must be 0-65535)`,
            rule.id
          )
        }
      }
    }

    validatePort(rule.srcPortStart, 'Source start')
    validatePort(rule.srcPortEnd, 'Source end')
    validatePort(rule.dstPortStart, 'Destination start')
    validatePort(rule.dstPortEnd, 'Destination end')

    // Validate ports are only used with tcp/udp
    const hasPorts = rule.srcPortStart !== undefined || rule.srcPortEnd !== undefined ||
                     rule.dstPortStart !== undefined || rule.dstPortEnd !== undefined
    if (hasPorts && normalizedProtocol !== 'tcp' && normalizedProtocol !== 'udp') {
      throw this.createError(
        NftablesErrorCode.RULE_INVALID,
        `Ports can only be specified for tcp/udp protocols, not ${rule.protocol}`,
        rule.id
      )
    }

    // Validate IP addresses if provided
    if (rule.srcIpAddr && !this.isValidIpAddress(rule.srcIpAddr)) {
      throw this.createError(
        NftablesErrorCode.INVALID_IP_ADDRESS,
        `Invalid source IP address: ${rule.srcIpAddr}`,
        rule.id
      )
    }

    if (rule.dstIpAddr && !this.isValidIpAddress(rule.dstIpAddr)) {
      throw this.createError(
        NftablesErrorCode.INVALID_IP_ADDRESS,
        `Invalid destination IP address: ${rule.dstIpAddr}`,
        rule.id
      )
    }

    // Validate subnet masks if provided (Comment 6: explicit mask validation)
    if (rule.srcIpMask && !this.isValidSubnetMask(rule.srcIpMask)) {
      throw this.createError(
        NftablesErrorCode.INVALID_SUBNET_MASK,
        `Invalid source subnet mask: ${rule.srcIpMask}. Expected CIDR (0-32) or dotted decimal (e.g., 255.255.255.0)`,
        rule.id
      )
    }

    if (rule.dstIpMask && !this.isValidSubnetMask(rule.dstIpMask)) {
      throw this.createError(
        NftablesErrorCode.INVALID_SUBNET_MASK,
        `Invalid destination subnet mask: ${rule.dstIpMask}. Expected CIDR (0-32) or dotted decimal (e.g., 255.255.255.0)`,
        rule.id
      )
    }

    // Validate connection states if provided
    if (rule.connectionState && typeof rule.connectionState === 'object') {
      const validStates = new Set(CONNECTION_STATES)
      const stateConfig = rule.connectionState as Record<string, unknown>
      for (const key of Object.keys(stateConfig)) {
        if (!validStates.has(key as typeof CONNECTION_STATES[number])) {
          throw this.createError(
            NftablesErrorCode.RULE_INVALID,
            `Invalid connection state: ${key}`,
            rule.id
          )
        }
      }
    }
  }

  /**
   * Validates an IPv4 address format.
   *
   * @param ip - IP address string to validate
   * @returns true if valid IPv4 address
   */
  static isValidIpAddress (ip: string): boolean {
    // Basic IPv4 validation regex
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
    return ipv4Regex.test(ip)
  }

  /**
   * Validates CIDR notation (e.g., "192.168.1.0/24").
   *
   * @param cidr - CIDR notation string to validate
   * @returns true if valid CIDR notation
   */
  static isValidCidr (cidr: string): boolean {
    const parts = cidr.split('/')
    if (parts.length !== 2) {
      return false
    }

    const [ip, mask] = parts
    if (!this.isValidIpAddress(ip)) {
      return false
    }

    const maskNum = parseInt(mask, 10)
    return !isNaN(maskNum) && maskNum >= 0 && maskNum <= 32
  }

  /**
   * Validates a subnet mask in either CIDR notation (0-32) or dotted decimal format.
   *
   * Valid CIDR: "0" through "32"
   * Valid dotted decimal: Standard subnet masks like "255.255.255.0", "255.255.0.0", etc.
   *
   * For dotted decimal, the mask must be contiguous (all 1s followed by all 0s in binary).
   *
   * @param mask - Mask in CIDR (e.g., "24") or dotted decimal (e.g., "255.255.255.0")
   * @returns true if valid subnet mask
   */
  static isValidSubnetMask (mask: string): boolean {
    // Check if it's a valid CIDR number (0-32)
    const numericMask = parseInt(mask, 10)
    if (!isNaN(numericMask) && mask === numericMask.toString() && numericMask >= 0 && numericMask <= 32) {
      return true
    }

    // Check if it's a valid dotted decimal subnet mask
    if (mask.includes('.')) {
      const octets = mask.split('.').map(o => parseInt(o, 10))
      if (octets.length !== 4 || octets.some(o => isNaN(o) || o < 0 || o > 255)) {
        return false
      }

      // Valid subnet masks in dotted decimal (contiguous 1s followed by 0s)
      const validOctets = [0, 128, 192, 224, 240, 248, 252, 254, 255]

      // Check that the mask is contiguous
      let foundZero = false
      for (const octet of octets) {
        if (foundZero) {
          // After seeing a non-255 octet, all remaining must be 0
          if (octet !== 0) {
            return false
          }
        } else if (octet === 255) {
          // 255 is valid and we haven't seen a non-255 yet
          continue
        } else if (validOctets.includes(octet)) {
          // Valid transition octet (e.g., 254, 252, 248, etc.)
          foundZero = true
        } else {
          // Invalid octet value for a subnet mask
          return false
        }
      }

      return true
    }

    return false
  }

  /**
   * Converts a dotted decimal mask or CIDR suffix to CIDR suffix.
   *
   * This method assumes the mask has already been validated by isValidSubnetMask()
   * or validateRule(). It will throw an error for invalid masks rather than
   * silently defaulting to /32.
   *
   * @param mask - Mask in dotted decimal (255.255.255.0) or CIDR (24)
   * @returns CIDR suffix number as string
   * @throws Error if mask cannot be parsed
   */
  private static maskToCidr (mask: string): string {
    // If it's already a CIDR number, return it
    const numericMask = parseInt(mask, 10)
    if (!isNaN(numericMask) && mask === numericMask.toString() && numericMask >= 0 && numericMask <= 32) {
      return mask
    }

    // Convert dotted decimal to CIDR
    if (mask.includes('.')) {
      const octets = mask.split('.').map(o => parseInt(o, 10))
      if (octets.length === 4 && octets.every(o => !isNaN(o) && o >= 0 && o <= 255)) {
        // Count bits set in the mask
        let bits = 0
        for (const octet of octets) {
          // eslint-disable-next-line no-bitwise
          bits += this.countSetBits(octet)
        }
        return bits.toString()
      }
    }

    // Instead of silently defaulting to /32, throw an error
    // This should not happen if validateRule() is called first
    throw this.createError(
      NftablesErrorCode.INVALID_SUBNET_MASK,
      `Invalid subnet mask format: ${mask}. Expected CIDR (0-32) or dotted decimal (e.g., 255.255.255.0)`
    )
  }

  /**
   * Counts the number of set bits (1s) in a number.
   * Used for converting subnet mask octets to CIDR.
   */
  private static countSetBits (n: number): number {
    let count = 0
    let num = n
    while (num > 0) {
      // eslint-disable-next-line no-bitwise
      count += num & 1
      // eslint-disable-next-line no-bitwise
      num >>= 1
    }
    return count
  }

  /**
   * Creates a structured error for validation failures.
   */
  private static createError (code: NftablesErrorCode, message: string, ruleId?: string): Error {
    const error = new Error(ruleId ? `[Rule ${ruleId}] ${message}` : message)
    ;(error as any).code = code
    return error
  }
}
