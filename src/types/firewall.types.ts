/**
 * Firewall-related type definitions for nftables management.
 * Used by NftablesService to manage VM firewall rules at Layer 2 using the bridge family.
 */

// ============================================================================
// Enums
// ============================================================================

/**
 * nftables address families.
 * Use BRIDGE for Layer 2 filtering on TAP devices (recommended for VM filtering).
 *
 * @example
 * // For VM firewall rules, always use BRIDGE family
 * const family = NftablesFamily.BRIDGE
 */
export enum NftablesFamily {
  /** Bridge family for Layer 2 filtering (used for VM traffic) */
  BRIDGE = 'bridge',
  /** Internet family for combined IPv4/IPv6 (Layer 3) */
  INET = 'inet',
  /** IPv4 only */
  IP = 'ip',
  /** IPv6 only */
  IP6 = 'ip6'
}

/**
 * nftables chain hook types.
 * These define where in the packet flow the chain is attached.
 */
export enum NftablesHookType {
  /** Before routing decision */
  PREROUTING = 'prerouting',
  /** Packets destined for local delivery */
  INPUT = 'input',
  /** Packets being routed through */
  FORWARD = 'forward',
  /** Packets originating from local processes */
  OUTPUT = 'output',
  /** After routing decision */
  POSTROUTING = 'postrouting'
}

/**
 * Default policy for nftables chains.
 */
export enum NftablesChainPolicy {
  /** Accept packets by default */
  ACCEPT = 'accept',
  /** Drop packets by default */
  DROP = 'drop'
}

/**
 * Error codes for nftables operations.
 * Used for structured error handling in NftablesService.
 */
export enum NftablesErrorCode {
  /** The specified table does not exist */
  TABLE_NOT_FOUND = 'TABLE_NOT_FOUND',
  /** The table already exists (when creating) */
  TABLE_EXISTS = 'TABLE_EXISTS',
  /** The specified chain does not exist */
  CHAIN_NOT_FOUND = 'CHAIN_NOT_FOUND',
  /** The chain already exists (when creating) */
  CHAIN_EXISTS = 'CHAIN_EXISTS',
  /** Invalid rule syntax or parameters */
  RULE_INVALID = 'RULE_INVALID',
  /** nftables command execution failed */
  COMMAND_FAILED = 'COMMAND_FAILED',
  /** Permission denied (needs root/CAP_NET_ADMIN) */
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  /** Invalid IP address format */
  INVALID_IP_ADDRESS = 'INVALID_IP_ADDRESS',
  /** Invalid subnet mask format */
  INVALID_SUBNET_MASK = 'INVALID_SUBNET_MASK',
  /** Invalid port range */
  INVALID_PORT_RANGE = 'INVALID_PORT_RANGE',
  /** Unsupported protocol */
  UNSUPPORTED_PROTOCOL = 'UNSUPPORTED_PROTOCOL'
}

// ============================================================================
// Constants
// ============================================================================

/** Name of the nftables table for all VM firewall rules */
export const INFINIVIRT_TABLE_NAME = 'infinivirt'

/** Address family used for VM firewall rules (bridge for Layer 2 filtering) */
export const INFINIVIRT_TABLE_FAMILY = NftablesFamily.BRIDGE

/** Default priority for base chains (lower = higher priority in nftables) */
export const DEFAULT_CHAIN_PRIORITY = 0

/** Prefix for comments in nftables rules (for identification) */
export const NFTABLES_COMMENT_PREFIX = 'infinivirt'

/** Supported protocols for firewall rules */
export const SUPPORTED_PROTOCOLS = ['tcp', 'udp', 'icmp', 'all'] as const

/** Valid connection states for stateful filtering */
export const CONNECTION_STATES = ['established', 'new', 'related', 'invalid'] as const

/** Maximum length for chain names in nftables */
export const MAX_CHAIN_NAME_LENGTH = 31

/** Prefix for VM-specific chains */
export const VM_CHAIN_PREFIX = 'vm_'

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Configuration for creating an nftables table.
 *
 * @example
 * const tableConfig: NftablesTableConfig = {
 *   name: 'infinivirt',
 *   family: NftablesFamily.BRIDGE
 * }
 */
export interface NftablesTableConfig {
  /** Table name (e.g., "infinivirt") */
  name: string
  /** Address family (use BRIDGE for VM filtering) */
  family: NftablesFamily
}

/**
 * Configuration for creating an nftables chain.
 *
 * @example
 * const chainConfig: NftablesChainConfig = {
 *   name: 'forward',
 *   table: 'infinivirt',
 *   family: NftablesFamily.BRIDGE,
 *   hook: NftablesHookType.FORWARD,
 *   priority: 0,
 *   policy: NftablesChainPolicy.ACCEPT
 * }
 */
export interface NftablesChainConfig {
  /** Chain name (e.g., "forward", "vm_abc123") */
  name: string
  /** Parent table name */
  table: string
  /** Address family of the parent table */
  family: NftablesFamily
  /** Hook type (only for base chains, omit for regular chains) */
  hook?: NftablesHookType
  /** Chain priority (only for base chains) */
  priority?: number
  /** Default policy (only for base chains) */
  policy?: NftablesChainPolicy
}

/**
 * Configuration for adding an nftables rule.
 *
 * @example
 * const ruleConfig: NftablesRuleConfig = {
 *   chain: 'vm_abc123',
 *   table: 'infinivirt',
 *   family: NftablesFamily.BRIDGE,
 *   expression: 'ip protocol tcp tcp dport 443 accept'
 * }
 */
export interface NftablesRuleConfig {
  /** Target chain name */
  chain: string
  /** Parent table name */
  table: string
  /** Address family */
  family: NftablesFamily
  /** Rule expression (e.g., "ip protocol tcp tcp dport 443 accept") */
  expression: string
}

/**
 * Array of tokens representing an nftables rule.
 * Each token is a separate argument to be passed to the nft command.
 * This avoids issues with space-splitting quoted strings like comments.
 *
 * @example
 * // Rule: oifname "vnet-abc" ip protocol tcp tcp dport 443 accept comment "Allow HTTPS"
 * const tokens: NftablesRuleTokens = [
 *   'oifname', 'vnet-abc',
 *   'ip', 'protocol', 'tcp',
 *   'tcp', 'dport', '443',
 *   'accept',
 *   'comment', 'Allow HTTPS'
 * ]
 */
export type NftablesRuleTokens = string[]

/**
 * Result of translating a Prisma FirewallRule to nftables syntax.
 */
export interface FirewallRuleTranslation {
  /** Complete nftables rule expression */
  expression: string
  /** Rule priority (from Prisma model) */
  priority: number
  /** Original rule name (for logging/debugging) */
  ruleName: string
  /** Whether translation was successful */
  success: boolean
  /** Error message if translation failed */
  error?: string
}

/**
 * Configuration for applying firewall rules to a VM.
 * Used as input to NftablesService.applyRules().
 *
 * @example
 * const vmConfig: VMFirewallConfig = {
 *   vmId: 'abc-123-def',
 *   tapDeviceName: 'vnet-abc12345',
 *   departmentRules: [...],  // FirewallRule[] from department
 *   vmRules: [...]           // FirewallRule[] specific to VM
 * }
 */
export interface VMFirewallConfig {
  /** VM identifier (used to generate chain name) */
  vmId: string
  /** TAP device name for this VM (e.g., "vnet-abc12345") */
  tapDeviceName: string
  /** Firewall rules inherited from department */
  departmentRules: FirewallRuleInput[]
  /** Firewall rules specific to this VM */
  vmRules: FirewallRuleInput[]
}

/**
 * Input interface for firewall rules (matches Prisma FirewallRule model).
 * This interface mirrors the Prisma model to avoid direct dependency.
 */
export interface FirewallRuleInput {
  id: string
  name: string
  description?: string | null
  action: 'ACCEPT' | 'DROP' | 'REJECT'
  direction: 'IN' | 'OUT' | 'INOUT'
  priority: number
  protocol: string
  srcPortStart?: number | null
  srcPortEnd?: number | null
  dstPortStart?: number | null
  dstPortEnd?: number | null
  srcIpAddr?: string | null
  srcIpMask?: string | null
  dstIpAddr?: string | null
  dstIpMask?: string | null
  connectionState?: ConnectionStateConfig | null
  overridesDept?: boolean
}

/**
 * Connection state configuration for stateful firewall rules.
 */
export interface ConnectionStateConfig {
  established?: boolean
  new?: boolean
  related?: boolean
  invalid?: boolean
}

/**
 * Structured error for nftables operations.
 */
export interface NftablesError extends Error {
  /** Error code for programmatic handling */
  code: NftablesErrorCode
  /** Additional context about the error */
  context?: {
    /** Command that failed */
    command?: string
    /** Arguments passed to command */
    args?: string[]
    /** stderr output */
    stderr?: string
    /** Exit code */
    exitCode?: number
  }
}

/**
 * Result of listing chains in a table.
 */
export interface ChainListResult {
  /** List of chain names */
  chains: string[]
  /** Whether the table exists */
  tableExists: boolean
}

/**
 * Statistics for applied firewall rules.
 */
export interface FirewallApplyResult {
  /** Total number of rules processed */
  totalRules: number
  /** Number of rules successfully applied */
  appliedRules: number
  /** Number of rules that failed to apply */
  failedRules: number
  /** Chain name where rules were applied */
  chainName: string
  /** Details of any failures */
  failures: Array<{
    ruleName: string
    error: string
  }>
}
