/**
 * State Synchronization Type Definitions
 *
 * This file contains TypeScript types for the state synchronization module
 * that bridges QMP protocol with PostgreSQL database state.
 */

import { QMPVMStatus, QMPEventType } from './qmp.types'

// =============================================================================
// Database Adapter Interface
// =============================================================================

/**
 * Machine record returned from database queries
 */
export interface MachineRecord {
  id: string
  status: string
}

/**
 * Machine configuration record for health monitoring
 */
export interface MachineConfigurationRecord {
  qemuPid: number | null
  tapDeviceName: string | null
  qmpSocketPath: string | null
  guestAgentSocketPath: string | null
  infiniServiceSocketPath: string | null
}

/**
 * Running VM query result combining machine and configuration
 */
export interface RunningVMRecord {
  id: string
  status: string
  MachineConfiguration: MachineConfigurationRecord | null
}

/**
 * Database adapter interface for state synchronization.
 * Implement this interface to provide database operations for the sync module.
 *
 * @example
 * ```typescript
 * // Using with Prisma
 * const adapter: DatabaseAdapter = {
 *   findMachine: (id) => prisma.machine.findUnique({ where: { id }, select: { id: true, status: true } }),
 *   updateMachineStatus: (id, status) => prisma.machine.update({ where: { id }, data: { status } }),
 *   findRunningVMs: () => prisma.machine.findMany({
 *     where: { status: 'running' },
 *     select: { id: true, status: true, MachineConfiguration: { select: { qemuPid: true, tapDeviceName: true, qmpSocketPath: true } } }
 *   }),
 *   clearMachineConfiguration: (machineId) => prisma.machineConfiguration.updateMany({
 *     where: { machineId },
 *     data: { qemuPid: null, tapDeviceName: null, qmpSocketPath: null }
 *   })
 * }
 * ```
 */
export interface DatabaseAdapter {
  /** Find a machine by ID */
  findMachine (id: string): Promise<MachineRecord | null>

  /** Update machine status */
  updateMachineStatus (id: string, status: string): Promise<void>

  /** Find all VMs with 'running' status including their configuration */
  findRunningVMs (): Promise<RunningVMRecord[]>

  /** Clear machine configuration (qemuPid, tapDeviceName, qmpSocketPath) */
  clearMachineConfiguration (machineId: string): Promise<void>
}

// =============================================================================
// Database Status Types
// =============================================================================

/**
 * Database VM status values (from Prisma Machine.status)
 */
export type DBVMStatus =
  | 'building'
  | 'running'
  | 'off'
  | 'suspended'
  | 'paused'
  | 'updating_hardware'
  | 'powering_off_update'
  | 'error'

/**
 * Status mapping result showing QMP to DB translation
 */
export interface StatusMapping {
  qmpStatus: QMPVMStatus
  dbStatus: DBVMStatus
  timestamp: Date
}

// =============================================================================
// Sync Result Types
// =============================================================================

/**
 * Result of a state synchronization operation
 */
export interface SyncResult {
  success: boolean
  vmId: string
  previousStatus: string
  newStatus: string
  timestamp: Date
  error?: string
}

/**
 * Error codes for sync operations
 */
export enum SyncErrorCode {
  QMP_UNAVAILABLE = 'QMP_UNAVAILABLE',
  DB_ERROR = 'DB_ERROR',
  VM_NOT_FOUND = 'VM_NOT_FOUND',
  INVALID_STATUS = 'INVALID_STATUS'
}

/**
 * Error object for sync operations
 */
export interface SyncError {
  code: SyncErrorCode
  message: string
  vmId: string
  timestamp: Date
}

// =============================================================================
// Health Monitor Types
// =============================================================================

/**
 * Configuration options for HealthMonitor
 */
export interface HealthMonitorConfig {
  /** How often to run health checks in milliseconds (default: 30000) */
  checkIntervalMs: number
  /** Whether to cleanup resources for crashed VMs (default: true) */
  enableCleanup: boolean
  /** Directory where pidfiles are stored (default: /var/run/infinivirt/pids) */
  pidfileDir?: string
  /** Optional callback when a crash is detected */
  onCrashDetected?: (vmId: string) => Promise<void>
  /** Optional callback when cleanup fails after retries */
  onCleanupAlert?: (alert: CleanupAlertEvent) => Promise<void>
}

/**
 * Result of a single VM health check
 */
export interface HealthCheckResult {
  vmId: string
  pid: number | null
  isAlive: boolean
  status: string
  timestamp: Date
}

/**
 * Summary of all health checks in a cycle
 */
export interface HealthCheckSummary {
  totalChecked: number
  alive: number
  crashed: number
  errors: number
  timestamp: Date
  results: HealthCheckResult[]
}

/**
 * Event emitted when a VM crash is detected
 */
export interface CrashEvent {
  vmId: string
  pid: number
  lastKnownStatus: string
  detectedAt: Date
  cleanupPerformed: boolean
  cleanupResult?: CleanupResult
}

// =============================================================================
// Cleanup Resource Types
// =============================================================================

/**
 * Types of resources that need cleanup when a VM crashes
 */
export enum CleanupResourceType {
  TAP_DEVICE = 'TAP_DEVICE',
  FIREWALL_CHAIN = 'FIREWALL_CHAIN',
  QMP_SOCKET = 'QMP_SOCKET',
  PIDFILE = 'PIDFILE',
  DB_CONFIGURATION = 'DB_CONFIGURATION'
}

/**
 * Status of a cleanup operation
 */
export enum CleanupStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING'
}

/**
 * State of a single cleanup resource
 */
export interface CleanupResourceState {
  type: CleanupResourceType
  identifier: string  // e.g., TAP device name, VM ID
  status: CleanupStatus
  attempts: number
  lastError?: string
  lastAttemptAt?: Date
}

/**
 * Result of a full cleanup operation for a VM
 */
export interface CleanupResult {
  vmId: string
  totalResources: number
  successfulCleanups: number
  failedCleanups: number
  resources: CleanupResourceState[]
  timestamp: Date
}

/**
 * Alert event emitted when cleanup fails after retries
 */
export interface CleanupAlertEvent {
  vmId: string
  failedResources: CleanupResourceState[]
  timestamp: Date
  severity: 'warning' | 'error'
}

// =============================================================================
// Event Handler Types
// =============================================================================

/**
 * Configuration options for EventHandler
 */
export interface EventHandlerConfig {
  /** Whether to log event handling (default: true) */
  enableLogging: boolean
  /** Whether to emit custom events for backend integration (default: true) */
  emitCustomEvents: boolean
}

/**
 * Data structure for VM events
 */
export interface VMEventData {
  vmId: string
  event: QMPEventType
  previousStatus: string
  newStatus: string
  timestamp: Date
  qmpData?: unknown
}

// =============================================================================
// Constants
// =============================================================================

/** Default interval for health checks (30 seconds) */
export const DEFAULT_HEALTH_CHECK_INTERVAL = 30000

/** Default timeout for sync operations (5 seconds) */
export const DEFAULT_SYNC_TIMEOUT = 5000

/** Maximum number of sync retry attempts */
export const MAX_SYNC_RETRIES = 3

/** Maximum number of cleanup retry attempts */
export const MAX_CLEANUP_RETRIES = 3

/** Base delay for cleanup retries in milliseconds (1 second) */
export const CLEANUP_RETRY_BASE_DELAY_MS = 1000

/** Maximum delay for cleanup retries in milliseconds (10 seconds) */
export const CLEANUP_RETRY_MAX_DELAY_MS = 10000

// =============================================================================
// Type Guards
// =============================================================================

/** Valid DB status values for type checking */
const VALID_DB_STATUSES: DBVMStatus[] = [
  'building',
  'running',
  'off',
  'suspended',
  'paused',
  'updating_hardware',
  'powering_off_update',
  'error'
]

/** Valid QMP status values for type checking */
const VALID_QMP_STATUSES: QMPVMStatus[] = [
  'running',
  'paused',
  'shutdown',
  'inmigrate',
  'postmigrate',
  'prelaunch',
  'finish-migrate',
  'restore-vm',
  'suspended',
  'watchdog',
  'guest-panicked',
  'io-error',
  'colo'
]

/**
 * Type guard to check if a string is a valid DB status
 */
export function isValidDBStatus (status: string): status is DBVMStatus {
  return VALID_DB_STATUSES.includes(status as DBVMStatus)
}

/**
 * Type guard to check if a string is a valid QMP status
 */
export function isValidQMPStatus (status: string): status is QMPVMStatus {
  return VALID_QMP_STATUSES.includes(status as QMPVMStatus)
}
