/**
 * VM Type Definitions (Consolidated)
 *
 * This file provides a consolidated hub for all VM-related types.
 * It re-exports types from specialized modules and defines new unified types
 * for comprehensive VM management.
 *
 * @module types/vm
 *
 * @example
 * ```typescript
 * // Import consolidated VM types
 * import {
 *   VMCreateConfig,
 *   VMStatus,
 *   VMInfo,
 *   VMOperation,
 *   VMOperationStatus
 * } from '@infinibay/infinization'
 *
 * // Create a VM with full type safety
 * const config: VMCreateConfig = {
 *   vmId: 'machine-uuid',
 *   name: 'my-vm',
 *   internalName: 'vm-abc123',
 *   os: 'ubuntu',
 *   cpuCores: 4,
 *   ramGB: 8,
 *   diskSizeGB: 50,
 *   bridge: 'virbr0',
 *   displayType: 'spice',
 *   displayPort: 5901
 * }
 * ```
 */

// =============================================================================
// Re-exports from Lifecycle Types
// =============================================================================

export {
  /** Display protocol for VM (SPICE or VNC) */
  DisplayProtocol,
  /** Configuration for creating a new VM */
  VMCreateConfig,
  /** Result of VM creation */
  VMCreateResult,
  /** Configuration options for starting a VM */
  VMStartConfig,
  /** Configuration options for stopping a VM */
  VMStopConfig,
  /** Generic result for VM operations */
  VMOperationResult,
  /** Result of a VM status query */
  VMStatusResult
} from './lifecycle.types'

// =============================================================================
// Re-exports from Sync Types
// =============================================================================

export {
  /** Database VM status values (from Prisma Machine.status) */
  DBVMStatus
} from './sync.types'

// Re-export DBVMStatus with an alias for convenience
import { DBVMStatus } from './sync.types'
/**
 * Alias for DBVMStatus - the VM status as stored in the database
 */
export type VMStatus = DBVMStatus

// =============================================================================
// Re-exports from QMP Types
// =============================================================================

export {
  /** QMP VM status values returned by query-status command */
  QMPVMStatus
} from './qmp.types'

// =============================================================================
// Re-exports from QEMU Types
// =============================================================================

export {
  /** Options for QEMU -machine option */
  MachineOptions
} from './qemu.types'

// =============================================================================
// VM Information Types
// =============================================================================

/**
 * Comprehensive VM information combining database state and runtime data.
 * This interface provides a unified view of all VM-related information.
 *
 * @example
 * ```typescript
 * const vmInfo: VMInfo = {
 *   id: 'machine-uuid',
 *   name: 'my-vm',
 *   internalName: 'vm-abc123',
 *   os: 'ubuntu',
 *   resources: {
 *     cpuCores: 4,
 *     ramGB: 8,
 *     diskSizeGB: 50
 *   },
 *   status: 'running',
 *   network: {
 *     bridge: 'virbr0',
 *     macAddress: '52:54:00:12:34:56',
 *     tapDevice: 'vnet-abc123'
 *   },
 *   display: {
 *     protocol: 'spice',
 *     port: 5901,
 *     address: '0.0.0.0'
 *   }
 * }
 * ```
 */
export interface VMInfo {
  /** Database machine ID (UUID) */
  id: string
  /** VM display name */
  name: string
  /** VM internal name (used for TAP device, disk, socket naming) */
  internalName: string
  /** Operating system type (e.g., 'ubuntu', 'windows') */
  os: string
  /** VM resource configuration */
  resources: VMResourceConfig
  /** Current VM status */
  status: VMStatus
  /** Network configuration (optional if not yet configured) */
  network?: VMNetworkInfo
  /** Display configuration (optional if not yet configured) */
  display?: VMDisplayInfo
  /** Hardware configuration (optional, for GPU passthrough etc.) */
  hardware?: VMHardwareConfig
  /** QEMU process ID (null if not running) */
  pid?: number | null
  /** QMP socket path (null if not running) */
  qmpSocketPath?: string | null
  /** VM creation timestamp */
  createdAt?: Date
  /** Last status update timestamp */
  updatedAt?: Date
}

/**
 * VM resource configuration (CPU, RAM, disk).
 *
 * @example
 * ```typescript
 * const resources: VMResourceConfig = {
 *   cpuCores: 4,
 *   ramGB: 8,
 *   diskSizeGB: 50
 * }
 * ```
 */
export interface VMResourceConfig {
  /** Number of CPU cores */
  cpuCores: number
  /** RAM size in gigabytes */
  ramGB: number
  /** Disk size in gigabytes */
  diskSizeGB: number
}

/**
 * VM network configuration information.
 *
 * @example
 * ```typescript
 * const network: VMNetworkInfo = {
 *   bridge: 'virbr0',
 *   macAddress: '52:54:00:12:34:56',
 *   tapDevice: 'vnet-abc123'
 * }
 * ```
 */
export interface VMNetworkInfo {
  /** Network bridge name (e.g., 'virbr0') */
  bridge: string
  /** MAC address */
  macAddress?: string
  /** TAP device name */
  tapDevice?: string
}

/**
 * VM display configuration information.
 *
 * @example
 * ```typescript
 * const display: VMDisplayInfo = {
 *   protocol: 'spice',
 *   port: 5901,
 *   address: '0.0.0.0'
 * }
 * ```
 */
export interface VMDisplayInfo {
  /** Display protocol (spice or vnc) */
  protocol: 'spice' | 'vnc'
  /** Display port number */
  port: number
  /** Display listen address */
  address?: string
  /** Whether password authentication is enabled */
  hasPassword?: boolean
}

/**
 * VM hardware configuration for advanced features like GPU passthrough.
 *
 * @example
 * ```typescript
 * const hardware: VMHardwareConfig = {
 *   gpuPciAddress: '0000:01:00.0',
 *   gpuRomfile: '/var/lib/infinization/roms/gpu.rom'
 * }
 * ```
 */
export interface VMHardwareConfig {
  /** GPU PCI address for passthrough (e.g., '0000:01:00.0') */
  gpuPciAddress?: string
  /** GPU ROM file path for passthrough */
  gpuRomfile?: string
  /** IOMMU group for device passthrough */
  iommuGroup?: number
}

// =============================================================================
// VM Operation Types
// =============================================================================

/**
 * VM operation types for lifecycle management.
 *
 * @example
 * ```typescript
 * const operation = VMOperation.START
 * if (operation === VMOperation.START) {
 *   // Handle start operation
 * }
 * ```
 */
export enum VMOperation {
  /** Create a new VM */
  CREATE = 'CREATE',
  /** Start an existing VM */
  START = 'START',
  /** Stop a running VM (graceful shutdown) */
  STOP = 'STOP',
  /** Restart a VM (stop + start) */
  RESTART = 'RESTART',
  /** Suspend a running VM (pause) */
  SUSPEND = 'SUSPEND',
  /** Resume a suspended VM */
  RESUME = 'RESUME',
  /** Hardware reset a VM */
  RESET = 'RESET',
  /** Delete a VM and its resources */
  DELETE = 'DELETE'
}

/**
 * Status of a VM operation.
 *
 * @example
 * ```typescript
 * const status = VMOperationStatus.IN_PROGRESS
 * if (status === VMOperationStatus.SUCCESS) {
 *   console.log('Operation completed successfully')
 * }
 * ```
 */
export enum VMOperationStatus {
  /** Operation is queued but not yet started */
  PENDING = 'PENDING',
  /** Operation is currently executing */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Operation completed successfully */
  SUCCESS = 'SUCCESS',
  /** Operation failed */
  FAILED = 'FAILED',
  /** Operation timed out */
  TIMEOUT = 'TIMEOUT'
}

/**
 * Record of a VM operation for history tracking.
 *
 * @example
 * ```typescript
 * const history: VMOperationHistory = {
 *   id: 'op-123',
 *   vmId: 'vm-abc',
 *   operation: VMOperation.START,
 *   status: VMOperationStatus.SUCCESS,
 *   startedAt: new Date('2024-01-15T10:00:00Z'),
 *   completedAt: new Date('2024-01-15T10:00:05Z'),
 *   message: 'VM started successfully'
 * }
 * ```
 */
export interface VMOperationHistory {
  /** Operation record ID */
  id: string
  /** VM identifier */
  vmId: string
  /** Type of operation performed */
  operation: VMOperation
  /** Status of the operation */
  status: VMOperationStatus
  /** When the operation started */
  startedAt: Date
  /** When the operation completed (null if still in progress) */
  completedAt?: Date | null
  /** Human-readable message about the operation */
  message?: string
  /** Error details if the operation failed */
  error?: string
  /** Whether the operation was forced (e.g., force stop) */
  forced?: boolean
  /** Additional context for the operation */
  context?: Record<string, unknown>
}

// =============================================================================
// Type Guards
// =============================================================================

/** Valid VM status values for type checking */
const VALID_VM_STATUSES: VMStatus[] = [
  'building',
  'running',
  'off',
  'suspended',
  'paused',
  'updating_hardware',
  'powering_off_update',
  'error'
]

/** Valid VM operation values for type checking */
const VALID_VM_OPERATIONS: VMOperation[] = [
  VMOperation.CREATE,
  VMOperation.START,
  VMOperation.STOP,
  VMOperation.RESTART,
  VMOperation.SUSPEND,
  VMOperation.RESUME,
  VMOperation.RESET,
  VMOperation.DELETE
]

/**
 * Type guard to check if a string is a valid VM status.
 *
 * @param status - The string to check
 * @returns True if the string is a valid VMStatus
 *
 * @example
 * ```typescript
 * const status = 'running'
 * if (isValidVMStatus(status)) {
 *   // status is typed as VMStatus here
 * }
 * ```
 */
export function isValidVMStatus (status: string): status is VMStatus {
  return VALID_VM_STATUSES.includes(status as VMStatus)
}

/**
 * Type guard to check if a value is a valid VM operation.
 *
 * @param operation - The value to check
 * @returns True if the value is a valid VMOperation
 *
 * @example
 * ```typescript
 * const op = 'START'
 * if (isValidVMOperation(op)) {
 *   // op is typed as VMOperation here
 * }
 * ```
 */
export function isValidVMOperation (operation: string): operation is VMOperation {
  return VALID_VM_OPERATIONS.includes(operation as VMOperation)
}

/**
 * Type guard to check if an object is a valid VMInfo structure.
 *
 * @param obj - The object to check
 * @returns True if the object has the required VMInfo properties
 *
 * @example
 * ```typescript
 * const data = await fetchVMData()
 * if (isValidVMInfo(data)) {
 *   console.log(data.name) // TypeScript knows this is VMInfo
 * }
 * ```
 */
export function isValidVMInfo (obj: unknown): obj is VMInfo {
  if (typeof obj !== 'object' || obj === null) return false
  const candidate = obj as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.internalName === 'string' &&
    typeof candidate.os === 'string' &&
    typeof candidate.status === 'string' &&
    isValidVMStatus(candidate.status) &&
    typeof candidate.resources === 'object' &&
    candidate.resources !== null
  )
}

// =============================================================================
// Constants
// =============================================================================

/** Default CPU cores for new VMs */
export const DEFAULT_VM_CPU_CORES = 2

/** Default RAM in GB for new VMs */
export const DEFAULT_VM_RAM_GB = 4

/** Default disk size in GB for new VMs */
export const DEFAULT_VM_DISK_SIZE_GB = 20

/** Minimum CPU cores allowed */
export const MIN_VM_CPU_CORES = 1

/** Maximum CPU cores allowed */
export const MAX_VM_CPU_CORES = 64

/** Minimum RAM in GB allowed */
export const MIN_VM_RAM_GB = 1

/** Maximum RAM in GB allowed */
export const MAX_VM_RAM_GB = 512

/** Minimum disk size in GB allowed */
export const MIN_VM_DISK_SIZE_GB = 10

/** Maximum disk size in GB allowed */
export const MAX_VM_DISK_SIZE_GB = 2048
