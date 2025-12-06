/**
 * Unattended Installation Type Definitions
 *
 * This file contains TypeScript types for automated OS installation.
 * Used by UnattendedInstaller and InstallationMonitor for managing
 * unattended installation workflows.
 */

import { BootDevice } from './qemu.types'

// =============================================================================
// OS Types
// =============================================================================

/**
 * Supported operating systems for unattended installation
 */
export type OSType = 'windows10' | 'windows11' | 'ubuntu' | 'fedora'

/**
 * Installation phases during unattended OS installation
 */
export type InstallationPhase =
  | 'generating_iso'
  | 'mounting_media'
  | 'installing'
  | 'completing'
  | 'cleanup'
  | 'completed'
  | 'failed'

// =============================================================================
// Application Types (mirrors Prisma Application model)
// =============================================================================

/**
 * Install command can be either:
 * - Record<string, string>: Key-value object for Ubuntu/Windows (e.g., { ubuntu: 'apt install ...' })
 * - string[]: Array for RedHat/Fedora where index corresponds to OS array index
 *
 * This matches the Prisma Application.installCommand Json field which can be either format.
 */
export type InstallCommandType = Record<string, string> | string[]

/**
 * Application configuration for unattended installation.
 * Mirrors the structure of Prisma's Application model.
 *
 * @remarks
 * The `installCommand` field can be in two formats:
 * - **Ubuntu/Windows**: `{ ubuntu: 'apt install firefox', windows: 'choco install firefox' }`
 * - **RedHat/Fedora**: `['package-name']` where array index corresponds to `os` array index
 *
 * The backend managers handle these formats differently:
 * - `UnattendedUbuntuManager` and `UnattendedWindowsManager` expect key-value objects
 * - `UnattendedRedHatManager` expects array format where `os` and `installCommand` indices match
 */
export interface UnattendedApplication {
  /** Unique application identifier */
  id: string
  /** Application display name */
  name: string
  /** Application description */
  description?: string | null
  /** Application version */
  version?: string | null
  /** Download URL */
  url?: string | null
  /** Icon identifier */
  icon?: string | null
  /** Supported operating systems (e.g., ['ubuntu', 'fedora', 'windows']) */
  os: string[]
  /**
   * Installation commands.
   * - For Ubuntu/Windows: Record<string, string> with OS keys
   * - For RedHat/Fedora: string[] where index matches the os array index
   *
   * @example
   * // Ubuntu/Windows format:
   * { ubuntu: 'apt-get install -y firefox', windows: 'choco install firefox' }
   *
   * @example
   * // RedHat/Fedora format (os: ['fedora'], installCommand: ['firefox']):
   * ['firefox']  // Will be installed via: dnf install -y firefox
   */
  installCommand: InstallCommandType
  /**
   * Parameters for installation command substitution.
   * Used to replace {{placeholder}} in install commands.
   */
  parameters: Record<string, unknown>
}

// =============================================================================
// Script Types
// =============================================================================

/**
 * Script shell types for first-boot scripts
 */
export type ScriptShell = 'POWERSHELL' | 'CMD' | 'BASH' | 'SH'

/**
 * Script definition for first-boot execution.
 * Mirrors the structure of Prisma's Script model.
 */
export interface UnattendedScript {
  /** Unique script identifier */
  id: string
  /** Script display name */
  name: string
  /** Script file name in storage */
  fileName: string
  /** Shell interpreter to use */
  shell: ScriptShell
  /** Optional description */
  description?: string | null
  /** Script category for organization */
  category?: string | null
  /** Tags for filtering */
  tags?: string[]
}

/**
 * Configuration for script execution during unattended installation
 */
export interface ScriptExecutionConfig {
  /** The script to execute */
  script: UnattendedScript
  /**
   * Input values for script parameter substitution.
   * Keys correspond to script parameter names.
   */
  inputValues: Record<string, unknown>
  /** Unique execution ID for tracking and reporting */
  executionId: string
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for unattended OS installation
 */
export interface UnattendedInstallConfig {
  /** Database machine ID (UUID) - must match the machine.id in the database */
  vmId: string
  /** Target operating system */
  os: OSType
  /** Username for the initial user account */
  username: string
  /** Password for the initial user account */
  password: string
  /** Windows product key (Windows only, optional) */
  productKey?: string
  /** Applications to install during or after OS installation */
  applications?: UnattendedApplication[]
  /** Scripts to execute after first boot */
  scripts?: ScriptExecutionConfig[]
  /** System locale (e.g., 'en_US', 'es_ES') */
  locale?: string
  /** System timezone (e.g., 'UTC', 'America/New_York', 'Pacific Standard Time') */
  timezone?: string
  /** System hostname (auto-generated if not provided) */
  hostname?: string
}

/**
 * Configuration for the InstallationMonitor
 */
export interface MonitorConfig {
  /** Timeout in milliseconds for the entire installation (default: 60 minutes) */
  timeout: number
  /** Maximum number of reset events before considering installation failed */
  maxResets: number
  /** Interval in milliseconds for timeout checks */
  checkInterval: number
}

// =============================================================================
// Progress and Result Types
// =============================================================================

/**
 * Progress update during installation
 */
export interface InstallationProgress {
  /** Current installation phase */
  phase: InstallationPhase
  /** Human-readable status message */
  message: string
  /** Timestamp of this progress update */
  timestamp: Date
  /** Error details if phase is 'failed' */
  error?: Error
}

/**
 * Result of an unattended installation operation
 */
export interface InstallationResult {
  /** Whether the installation completed successfully */
  success: boolean
  /** Path to the generated installation ISO */
  isoPath: string
  /** Total duration in milliseconds */
  duration: number
  /** History of all phases */
  phases: InstallationProgress[]
  /** Error details if installation failed */
  error?: Error
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error codes for unattended installation operations
 */
export enum UnattendedErrorCode {
  /** Invalid configuration provided */
  INVALID_CONFIG = 'INVALID_CONFIG',
  /** Failed to generate custom ISO */
  ISO_GENERATION_FAILED = 'ISO_GENERATION_FAILED',
  /** Failed to mount ISO in VM */
  MOUNT_FAILED = 'MOUNT_FAILED',
  /** Installation exceeded timeout */
  INSTALLATION_TIMEOUT = 'INSTALLATION_TIMEOUT',
  /** Installation exceeded maximum reset count (repeated reboots) */
  INSTALLATION_RESET_LIMIT_EXCEEDED = 'INSTALLATION_RESET_LIMIT_EXCEEDED',
  /** Generic installation failure */
  INSTALLATION_FAILED = 'INSTALLATION_FAILED',
  /** Failed to clean up temporary files */
  CLEANUP_FAILED = 'CLEANUP_FAILED',
  /** Operating system not supported */
  UNSUPPORTED_OS = 'UNSUPPORTED_OS',
  /** Backend manager not available */
  MANAGER_NOT_FOUND = 'MANAGER_NOT_FOUND',
  /** QMP communication error */
  QMP_ERROR = 'QMP_ERROR',
  /** Installation monitoring error */
  MONITORING_ERROR = 'MONITORING_ERROR'
}

/**
 * Custom error class for unattended installation operations
 */
export class UnattendedError extends Error {
  /** Error code for programmatic handling */
  public readonly code: UnattendedErrorCode

  /** Original error that caused this error */
  public readonly cause?: Error

  /** VM identifier (if applicable) */
  public readonly vmId?: string

  /** Additional context for debugging */
  public readonly context?: Record<string, unknown>

  constructor (
    code: UnattendedErrorCode,
    message: string,
    cause?: Error,
    vmId?: string,
    context?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'UnattendedError'
    this.code = code
    this.cause = cause
    this.vmId = vmId
    this.context = context

    // Maintains proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, UnattendedError)
    }
  }
}

// =============================================================================
// Constants
// =============================================================================

/** Default timeout for installation monitoring (60 minutes) */
export const DEFAULT_INSTALLATION_TIMEOUT = 60 * 60 * 1000

/**
 * OS-specific installation timeouts (in milliseconds)
 * - Ubuntu: 45 minutes (typically faster installation)
 * - Fedora: 60 minutes (similar to Ubuntu)
 * - Windows 10: 90 minutes (longer due to updates)
 * - Windows 11: 120 minutes (can take significantly longer)
 */
export const OS_INSTALLATION_TIMEOUTS: Record<OSType, number> = {
  ubuntu: 45 * 60 * 1000, // 45 minutes
  fedora: 60 * 60 * 1000, // 60 minutes
  windows10: 90 * 60 * 1000, // 90 minutes
  windows11: 120 * 60 * 1000 // 120 minutes
}

/**
 * Gets the recommended installation timeout for a specific OS
 * @param os - The target operating system
 * @returns Timeout in milliseconds
 */
export function getInstallationTimeout (os: OSType): number {
  return OS_INSTALLATION_TIMEOUTS[os] ?? DEFAULT_INSTALLATION_TIMEOUT
}

/** Standard QEMU CD-ROM device name */
export const CDROM_DEVICE_NAME = 'ide1-cd0'

/** Boot order for CD-ROM installation: CD-ROM first, then disk */
export const ISO_BOOT_ORDER: BootDevice[] = ['d', 'c']

/** Maximum number of reset events before failing installation */
export const DEFAULT_MAX_RESETS = 5

/** Interval for checking installation timeout (5 seconds) */
export const DEFAULT_CHECK_INTERVAL = 5000

/** Default locale for installations */
export const DEFAULT_LOCALE = 'en_US'

/** Default timezone for installations */
export const DEFAULT_TIMEZONE = 'UTC'

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Checks if a string is a valid OS type
 */
export function isValidOSType (os: string): os is OSType {
  return ['windows10', 'windows11', 'ubuntu', 'fedora'].includes(os)
}

/**
 * Checks if a string is a valid installation phase
 */
export function isValidInstallationPhase (phase: string): phase is InstallationPhase {
  return [
    'generating_iso',
    'mounting_media',
    'installing',
    'completing',
    'cleanup',
    'completed',
    'failed'
  ].includes(phase)
}

/**
 * Validates an unattended installation configuration
 */
export function isValidInstallConfig (config: unknown): config is UnattendedInstallConfig {
  if (!config || typeof config !== 'object') {
    return false
  }

  const c = config as Record<string, unknown>

  // Required fields
  if (typeof c.vmId !== 'string' || c.vmId.length === 0) {
    return false
  }
  if (typeof c.os !== 'string' || !isValidOSType(c.os)) {
    return false
  }
  if (typeof c.username !== 'string' || c.username.length === 0) {
    return false
  }
  if (typeof c.password !== 'string' || c.password.length === 0) {
    return false
  }

  // Optional fields type validation
  if (c.productKey !== undefined && typeof c.productKey !== 'string') {
    return false
  }
  if (c.applications !== undefined && !Array.isArray(c.applications)) {
    return false
  }
  if (c.scripts !== undefined && !Array.isArray(c.scripts)) {
    return false
  }
  if (c.locale !== undefined && typeof c.locale !== 'string') {
    return false
  }
  if (c.timezone !== undefined && typeof c.timezone !== 'string') {
    return false
  }
  if (c.hostname !== undefined && typeof c.hostname !== 'string') {
    return false
  }

  return true
}

/**
 * Type guard to check if an error is an UnattendedError
 */
export function isUnattendedError (error: unknown): error is UnattendedError {
  return error instanceof UnattendedError
}

/**
 * Factory function to create an UnattendedError
 */
export function createUnattendedError (
  code: UnattendedErrorCode,
  message: string,
  cause?: Error,
  vmId?: string,
  context?: Record<string, unknown>
): UnattendedError {
  return new UnattendedError(code, message, cause, vmId, context)
}
