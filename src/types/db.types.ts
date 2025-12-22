/**
 * Database Type Definitions
 *
 * This file contains TypeScript types for the PrismaAdapter and database operations.
 * These types mirror the Prisma schema models to avoid direct coupling with @prisma/client.
 */

import { MachineRecord, MachineConfigurationRecord } from './sync.types'
import { ConnectionStateConfig } from './firewall.types'

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error codes for PrismaAdapter operations.
 * Used for structured error handling.
 */
export enum PrismaAdapterErrorCode {
  /** The specified machine was not found in the database */
  MACHINE_NOT_FOUND = 'MACHINE_NOT_FOUND',
  /** Database connection failed */
  DB_CONNECTION_ERROR = 'DB_CONNECTION_ERROR',
  /** Update operation failed */
  UPDATE_FAILED = 'UPDATE_FAILED',
  /** Query operation failed */
  QUERY_FAILED = 'QUERY_FAILED',
  /** Invalid input provided to a method */
  INVALID_INPUT = 'INVALID_INPUT',
  /** Database constraint violation */
  CONSTRAINT_VIOLATION = 'CONSTRAINT_VIOLATION',
  /** Optimistic locking version conflict - another process modified the record */
  VERSION_CONFLICT = 'VERSION_CONFLICT'
}

/**
 * Custom error class for PrismaAdapter operations.
 * Provides structured error information with error codes.
 *
 * @example
 * ```typescript
 * try {
 *   await adapter.findMachine('invalid-id')
 * } catch (error) {
 *   if (isPrismaAdapterError(error)) {
 *     console.log(error.code)  // PrismaAdapterErrorCode.MACHINE_NOT_FOUND
 *     console.log(error.vmId)  // 'invalid-id'
 *   }
 * }
 * ```
 */
export class PrismaAdapterError extends Error {
  /** Error code for programmatic handling */
  public readonly code: PrismaAdapterErrorCode

  /** VM ID associated with the error, if applicable */
  public readonly vmId?: string

  /** Additional error details */
  public readonly details?: unknown

  constructor (
    message: string,
    code: PrismaAdapterErrorCode,
    vmId?: string,
    details?: unknown
  ) {
    super(message)
    this.name = 'PrismaAdapterError'
    this.code = code
    this.vmId = vmId
    this.details = details

    // Maintains proper stack trace for where error was thrown (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PrismaAdapterError)
    }
  }
}

/**
 * Type guard to check if an error is a PrismaAdapterError
 */
export function isPrismaAdapterError (error: unknown): error is PrismaAdapterError {
  return error instanceof PrismaAdapterError
}

// =============================================================================
// Configuration Update Types
// =============================================================================

/**
 * Fields that can be updated in MachineConfiguration.
 * All fields are optional to allow partial updates.
 */
export interface MachineConfigUpdate {
  /** Path to the QMP Unix socket for VM management */
  qmpSocketPath?: string | null
  /** QEMU process ID */
  qemuPid?: number | null
  /** TAP network device name */
  tapDeviceName?: string | null
  /** Display protocol (e.g., 'spice', 'vnc') */
  graphicProtocol?: string | null
  /** Display port number */
  graphicPort?: number | null
  /** Display authentication password */
  graphicPassword?: string | null
  /** Display host address */
  graphicHost?: string | null
  /** Assigned GPU PCI bus address */
  assignedGpuBus?: string | null
  // QEMU configuration fields
  /** Network bridge name (e.g., 'virbr0') */
  bridge?: string | null
  /** QEMU machine type (e.g., 'q35', 'pc') */
  machineType?: string | null
  /** CPU model (e.g., 'host', 'qemu64') */
  cpuModel?: string | null
  /** Disk bus type (e.g., 'virtio', 'scsi', 'ide', 'sata') */
  diskBus?: string | null
  /** Disk cache mode (e.g., 'writeback', 'writethrough', 'none', 'unsafe') */
  diskCacheMode?: string | null
  /** Network model (e.g., 'virtio-net-pci', 'e1000') */
  networkModel?: string | null
  /** Number of network queues for multi-queue networking */
  networkQueues?: number | null
  /** Enable dynamic memory management via balloon device */
  memoryBalloon?: boolean | null
  /** Array of disk paths stored as JSON */
  diskPaths?: string[] | null
  /** Path to OVMF firmware file for UEFI boot */
  uefiFirmware?: string | null
  /** Enable hugepages for improved memory performance */
  hugepages?: boolean | null
  /** CPU affinity configuration (format: {"cores": [0, 1, 2]}) - cgroups-based */
  cpuPinning?: { cores: number[] } | null
  /** Enable NUMA-aware CPU pinning via numactl wrapper */
  enableNumaCtlPinning?: boolean | null
  /** Strategy for automatic CPU pinning: 'basic' or 'hybrid' */
  cpuPinningStrategy?: string | null
  // Advanced device configuration
  /** Path to TPM 2.0 socket (swtpm) */
  tpmSocketPath?: string | null
  /** Path to QEMU Guest Agent socket */
  guestAgentSocketPath?: string | null
  /** Path to InfiniService channel socket */
  infiniServiceSocketPath?: string | null
  /** Path to VirtIO drivers ISO */
  virtioDriversIso?: string | null
  /** Enable Intel HDA audio device */
  enableAudio?: boolean | null
  /** Enable USB tablet for absolute mouse positioning */
  enableUsbTablet?: boolean | null
}

// =============================================================================
// Record Types
// =============================================================================

/**
 * Department record from database
 */
export interface DepartmentRecord {
  /** Department unique identifier */
  id: string
  /** Department name */
  name: string
  /** Department's firewall rule set (if assigned) */
  firewallRuleSet: FirewallRuleSetRecord | null
}

/**
 * Firewall rule set record from database
 */
export interface FirewallRuleSetRecord {
  /** Rule set unique identifier */
  id: string
  /** Rule set display name */
  name: string
  /** Rule set internal name (used in nftables chain) */
  internalName: string
  /** Rule set priority for ordering */
  priority: number
  /** Whether the rule set is active */
  isActive: boolean
  /** Firewall rules in this set */
  rules: FirewallRuleRecord[]
}

/**
 * Firewall rule record from database.
 * Matches the Prisma FirewallRule model structure.
 */
export interface FirewallRuleRecord {
  /** Rule unique identifier */
  id: string
  /** Rule display name */
  name: string
  /** Optional rule description */
  description: string | null
  /** Rule action: ACCEPT, DROP, or REJECT */
  action: 'ACCEPT' | 'DROP' | 'REJECT'
  /** Rule direction: IN (to VM), OUT (from VM), or INOUT (both) */
  direction: 'IN' | 'OUT' | 'INOUT'
  /** Rule priority (lower number = higher priority) */
  priority: number
  /** Protocol to match (tcp, udp, icmp, all) */
  protocol: string
  /** Source port range start (optional) */
  srcPortStart: number | null
  /** Source port range end (optional) */
  srcPortEnd: number | null
  /** Destination port range start (optional) */
  dstPortStart: number | null
  /** Destination port range end (optional) */
  dstPortEnd: number | null
  /** Source IP address (optional) */
  srcIpAddr: string | null
  /** Source IP subnet mask (optional) */
  srcIpMask: string | null
  /** Destination IP address (optional) */
  dstIpAddr: string | null
  /** Destination IP subnet mask (optional) */
  dstIpMask: string | null
  /** Connection state matching configuration */
  connectionState: ConnectionStateConfig | null
  /** Whether this rule overrides department rules */
  overridesDept: boolean
}

/**
 * Extended machine configuration record including graphic, GPU, and QEMU configuration fields
 */
export interface ExtendedMachineConfigurationRecord extends MachineConfigurationRecord {
  /** Display protocol (e.g., 'spice', 'vnc') */
  graphicProtocol: string | null
  /** Display port number */
  graphicPort: number | null
  /** Display authentication password */
  graphicPassword: string | null
  /** Display host address */
  graphicHost: string | null
  /** Assigned GPU PCI bus address */
  assignedGpuBus: string | null
  // QEMU configuration fields
  /** Network bridge name (e.g., 'virbr0') */
  bridge: string | null
  /** QEMU machine type (e.g., 'q35', 'pc') */
  machineType: string | null
  /** CPU model (e.g., 'host', 'qemu64') */
  cpuModel: string | null
  /** Disk bus type (e.g., 'virtio', 'scsi', 'ide', 'sata') */
  diskBus: string | null
  /** Disk cache mode (e.g., 'writeback', 'writethrough', 'none', 'unsafe') */
  diskCacheMode: string | null
  /** Network model (e.g., 'virtio-net-pci', 'e1000') */
  networkModel: string | null
  /** Number of network queues for multi-queue networking */
  networkQueues: number | null
  /** Enable dynamic memory management via balloon device */
  memoryBalloon: boolean | null
  /** Array of disk paths */
  diskPaths: string[] | null
  /** Path to OVMF firmware file for UEFI boot */
  uefiFirmware: string | null
  /** Enable hugepages for improved memory performance */
  hugepages: boolean | null
  /** CPU affinity configuration (cgroups-based) */
  cpuPinning: { cores: number[] } | null
  /** Enable NUMA-aware CPU pinning via numactl wrapper */
  enableNumaCtlPinning: boolean | null
  /** Strategy for automatic CPU pinning: 'basic' or 'hybrid' */
  cpuPinningStrategy: string | null
  // Advanced device configuration
  /** Path to TPM 2.0 socket (swtpm) */
  tpmSocketPath: string | null
  /** Path to QEMU Guest Agent socket */
  guestAgentSocketPath: string | null
  /** Path to InfiniService channel socket */
  infiniServiceSocketPath: string | null
  /** Path to VirtIO drivers ISO */
  virtioDriversIso: string | null
  /** Enable Intel HDA audio device */
  enableAudio: boolean | null
  /** Enable USB tablet for absolute mouse positioning */
  enableUsbTablet: boolean | null
}

/**
 * Full VM configuration record including configuration, firewall, and department.
 * Extends MachineRecord with nested related records and hardware specs.
 */
export interface VMConfigRecord extends MachineRecord {
  /** Machine's display name */
  name: string
  /** Machine's internal name (used for TAP device naming) */
  internalName: string
  /** Operating system type (e.g., 'ubuntu', 'windows') */
  os: string
  /** Number of CPU cores */
  cpuCores: number
  /** RAM size in gigabytes */
  ramGB: number
  /** Disk size in gigabytes */
  diskSizeGB: number
  /** GPU PCI address for passthrough (optional) */
  gpuPciAddress: string | null
  /** Machine configuration (runtime settings) */
  configuration: ExtendedMachineConfigurationRecord | null
  /** Machine's firewall rule set */
  firewallRuleSet: FirewallRuleSetRecord | null
  /** Machine's department with inherited firewall rules */
  department: DepartmentRecord | null
  /** Optimistic locking version number */
  version: number
}

// =============================================================================
// Constants
// =============================================================================

/** Default path prefix for VM disk images */
export const DEFAULT_DISK_PATH_PREFIX = '/var/lib/infinization/disks'

/** Default path prefix for QMP Unix sockets */
export const DEFAULT_QMP_SOCKET_PATH_PREFIX = '/var/run/infinization'

/** Default disk image format */
export const DEFAULT_DISK_FORMAT = 'qcow2'

/** Default disk image extension */
export const DEFAULT_DISK_EXTENSION = '.qcow2'
