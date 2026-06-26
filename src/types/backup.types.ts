/**
 * Backup Type Definitions
 *
 * Types for VM backup operations: full disk copies, incremental backups
 * via backing files, and snapshot-based backups using qemu-img.
 */

// =============================================================================
// Enums
// =============================================================================

/**
 * Type of backup to perform.
 *
 * - **FULL**: Complete copy of all disk images (qemu-img convert).
 *   Independent of any previous backup. Largest size but simplest to restore.
 *
 * - **INCREMENTAL**: Uses qcow2 backing files to store only changed data
 *   since the last backup. Smaller and faster than FULL, but requires
 *   the parent backup to be available for restore.
 *
 * - **SNAPSHOT**: Creates an internal qcow2 snapshot via SnapshotManager.
 *   Fastest and uses no extra disk space initially (copy-on-write).
 *   Best for short-lived checkpoints before risky operations.
 */
export enum BackupType {
  FULL = 'FULL',
  INCREMENTAL = 'INCREMENTAL',
  SNAPSHOT = 'SNAPSHOT'
}

/**
 * Current status of a backup operation.
 */
export enum BackupStatus {
  /** Backup is queued but has not started yet */
  PENDING = 'PENDING',
  /** Backup is currently in progress */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Backup completed successfully */
  COMPLETED = 'COMPLETED',
  /** Backup failed due to an error */
  FAILED = 'FAILED',
  /** Backup was manually cancelled by the user */
  CANCELLED = 'CANCELLED'
}

/**
 * Compression algorithm for backup files.
 */
export enum BackupCompression {
  /** No compression — fastest, largest files */
  NONE = 'NONE',
  /** qcow2 native compression (zlib) — good balance */
  QCOW2 = 'QCOW2',
  /** gzip compression via OS-level tooling */
  GZIP = 'GZIP'
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for a single backup operation.
 *
 * @example
 * ```typescript
 * const config: BackupConfig = {
 *   vmId: 'abc-123',
 *   diskPaths: ['/var/lib/infinization/disks/vm-abc-123-disk-0.qcow2'],
 *   destinationDir: '/var/lib/infinization/backups/abc-123',
 *   type: BackupType.FULL,
 *   compression: BackupCompression.QCOW2,
 *   description: 'Pre-update backup'
 * }
 * ```
 */
export interface BackupConfig {
  /** VM identifier (UUID) this backup belongs to */
  vmId: string
  /**
   * Disk image paths to include in the backup.
   * For FULL and INCREMENTAL backups, these are source qcow2 paths.
   * For SNAPSHOT backups, only the first disk is used.
   */
  diskPaths: string[]
  /** Directory where backup files will be stored */
  destinationDir: string
  /** Type of backup to perform */
  type: BackupType
  /** Compression algorithm (default: NONE) */
  compression?: BackupCompression
  /** Human-readable description for this backup */
  description?: string
  /**
   * Parent backup ID for INCREMENTAL backups.
   * Required when type is INCREMENTAL. The new backup will only contain
   * data changed since this parent backup.
   */
  parentBackupId?: string
  /**
   * Optional tags for categorising backups (e.g. ['pre-update', 'weekly']).
   */
  tags?: string[]
}

/**
 * Configuration for restoring a backup.
 *
 * @example
 * ```typescript
 * const restoreConfig: BackupRestoreOptions = {
 *   backupId: 'backup-456',
 *   vmId: 'abc-123',
 *   diskPaths: ['/var/lib/infinization/disks/vm-abc-123-disk-0.qcow2'],
 *   overwriteExisting: false
 * }
 * ```
 */
export interface BackupRestoreOptions {
  /** ID of the backup to restore from */
  backupId: string
  /** VM identifier to restore into */
  vmId: string
  /**
   * Target disk paths for restored images.
   * Must match the count and order of the original backup's disks.
   */
  diskPaths: string[]
  /**
   * Whether to overwrite existing disk images.
   * If false (default), restore will fail if a target file already exists.
   */
  overwriteExisting?: boolean
  /**
   * Whether to stop the VM automatically before restore and restart after.
   * Default: false (user must stop the VM manually).
   */
  autoStopStart?: boolean
  /**
   * SNAPSHOT restore only: explicit opt-in to revert the LIVE source disk
   * in-place (a `qemu-img snapshot -a` mutates the original qcow2). Internal
   * snapshots cannot be reverted to a *different* file, so when the supplied
   * target path differs from the snapshot's source path the restore refuses
   * unless this flag is set AND the target equals the source. This guard
   * exists so a snapshot restore can never silently clobber the live disk
   * (the default is fail-closed). Ignored for FULL/INCREMENTAL restores.
   */
  allowInPlaceSnapshotRevert?: boolean
}

/**
 * Recurring backup schedule configuration.
 *
 * @example
 * ```typescript
 * const schedule: BackupSchedule = {
 *   vmId: 'abc-123',
 *   type: BackupType.FULL,
 *   cronExpression: '0 2 * * 0',  // Every Sunday at 2 AM
 *   retentionCount: 4,             // Keep last 4 backups
 *   compression: BackupCompression.QCOW2,
 *   enabled: true
 * }
 * ```
 */
export interface BackupSchedule {
  /** Unique schedule identifier */
  id: string
  /** VM identifier this schedule applies to */
  vmId: string
  /**
   * Disk image paths to back up. If omitted, the scheduler resolves them via the
   * `diskPathResolver` it was constructed with. One of the two MUST yield a
   * non-empty list or the scheduled run fails loudly (a backup of zero disks is
   * never what the operator intended).
   */
  diskPaths?: string[]
  /** Type of backup this schedule creates */
  type: BackupType
  /** Cron expression for scheduling (e.g. '0 2 * * 0' = Sundays at 2 AM) */
  cronExpression: string
  /**
   * Maximum number of backups to retain for this schedule.
   * Oldest backups are automatically deleted when exceeded.
   * Set to 0 for unlimited retention.
   */
  retentionCount: number
  /** Destination directory for scheduled backups */
  destinationDir: string
  /** Compression algorithm for scheduled backups */
  compression?: BackupCompression
  /** Whether this schedule is active */
  enabled: boolean
  /** Human-readable label for this schedule */
  label?: string
  /** ISO timestamp of last scheduled execution */
  lastRunAt?: string
  /** ISO timestamp of next scheduled execution */
  nextRunAt?: string
}

// =============================================================================
// Metadata & Result Types
// =============================================================================

/**
 * Metadata for a single disk within a backup.
 */
export interface BackupDiskInfo {
  /** Original disk image path */
  sourcePath: string
  /** Backup file path */
  backupPath: string
  /** Size of the original disk image in bytes */
  originalSize: number
  /** Size of the backup file in bytes */
  backupSize: number
  /** Disk format (qcow2, raw, etc.) */
  format: string
  /** For incremental backups: path to the parent backup file */
  backingFile?: string
}

/**
 * Full metadata for a completed (or in-progress) backup.
 * Stored as a JSON manifest alongside the backup files.
 */
export interface BackupMetadata {
  /** Unique backup identifier */
  id: string
  /** VM identifier this backup belongs to */
  vmId: string
  /** Backup type */
  type: BackupType
  /** Current status */
  status: BackupStatus
  /** ISO timestamp when the backup was created */
  createdAt: string
  /** ISO timestamp when the backup completed or failed */
  completedAt?: string
  /** Duration of the backup in milliseconds */
  durationMs?: number
  /** Per-disk information */
  disks: BackupDiskInfo[]
  /** Total size of all backup files in bytes */
  totalSize: number
  /** Total size of original disk images in bytes */
  totalOriginalSize: number
  /** Compression used */
  compression: BackupCompression
  /** Human-readable description */
  description?: string
  /** Tags for categorisation */
  tags?: string[]
  /** Parent backup ID (for incremental backups) */
  parentBackupId?: string
  /** Error message if status is FAILED */
  errorMessage?: string
  /**
   * Whether the VM was running when this backup was taken. A backup taken of a
   * live disk may capture a torn / in-flight write unless the guest filesystem
   * was quiesced — see `crashConsistent`.
   */
  runningAtBackup?: boolean
  /**
   * True when the backup is only crash-consistent (live disk read WITHOUT a
   * successful guest fsfreeze quiesce). A restore of a crash-consistent backup
   * behaves like a hard power-loss recovery and should be surfaced to the user.
   * Absent / false means the source was quiesced or the VM was stopped, i.e.
   * the backup is application-/filesystem-consistent.
   */
  crashConsistent?: boolean
}

/**
 * Result of a backup creation operation.
 */
export interface BackupResult {
  /** Whether the backup succeeded */
  success: boolean
  /** Backup identifier */
  backupId: string
  /** VM identifier */
  vmId: string
  /** Backup type that was performed */
  type: BackupType
  /** Per-disk results */
  disks: BackupDiskInfo[]
  /** Total backup size in bytes */
  totalSize: number
  /** Duration of the operation in milliseconds */
  durationMs: number
  /** Error message if success is false */
  error?: string
}

/**
 * Result of a backup restore operation.
 */
export interface BackupRestoreResult {
  /** Whether the restore succeeded */
  success: boolean
  /** Backup identifier that was restored */
  backupId: string
  /** VM identifier */
  vmId: string
  /** Restored disk paths */
  restoredDiskPaths: string[]
  /** Duration of the restore in milliseconds */
  durationMs: number
  /** Error message if success is false */
  error?: string
}

/**
 * Progress information for an in-progress backup.
 */
export interface BackupProgress {
  /** Backup identifier */
  backupId: string
  /** VM identifier */
  vmId: string
  /** Current disk being processed (0-based index) */
  currentDisk: number
  /** Total number of disks to process */
  totalDisks: number
  /** Percentage complete for the current disk (0-100) */
  diskProgress: number
  /** Overall percentage complete (0-100) */
  overallProgress: number
  /** Estimated time remaining in milliseconds */
  estimatedTimeRemainingMs?: number
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error codes for backup operations.
 */
export enum BackupErrorCode {
  /** VM not found */
  VM_NOT_FOUND = 'VM_NOT_FOUND',
  /** Backup not found */
  BACKUP_NOT_FOUND = 'BACKUP_NOT_FOUND',
  /** Backup destination directory is invalid or unwritable */
  INVALID_DESTINATION = 'INVALID_DESTINATION',
  /** Disk image not found */
  DISK_NOT_FOUND = 'DISK_NOT_FOUND',
  /** VM is running and must be stopped for this operation */
  VM_RUNNING = 'VM_RUNNING',
  /** Not enough disk space for backup */
  INSUFFICIENT_SPACE = 'INSUFFICIENT_SPACE',
  /** Parent backup not found for incremental backup */
  PARENT_NOT_FOUND = 'PARENT_NOT_FOUND',
  /** Backup already exists at the destination */
  BACKUP_EXISTS = 'BACKUP_EXISTS',
  /** Target disk already exists and overwrite is disabled */
  TARGET_EXISTS = 'TARGET_EXISTS',
  /** Backup operation failed */
  OPERATION_FAILED = 'OPERATION_FAILED',
  /** Backup was cancelled */
  CANCELLED = 'CANCELLED',
  /** Invalid backup configuration */
  INVALID_CONFIG = 'INVALID_CONFIG',
  /** Backup file is corrupt or unreadable */
  CORRUPT_BACKUP = 'CORRUPT_BACKUP',
  /**
   * The backup cannot be deleted because another backup depends on it as an
   * INCREMENTAL parent (deleting it would orphan the dependent chain).
   */
  DEPENDENCY = 'DEPENDENCY'
}

/**
 * Structured error information for backup operations.
 */
export interface BackupErrorInfo {
  /** Error code for programmatic handling */
  code: BackupErrorCode
  /** Human-readable error message */
  message: string
  /** Backup ID if applicable */
  backupId?: string
  /** VM ID if applicable */
  vmId?: string
  /** Disk path that caused the error */
  diskPath?: string
  /** Command that failed (if applicable) */
  command?: string
}

/**
 * Custom error class for backup operations.
 */
export class BackupError extends Error {
  /** Error code for programmatic handling */
  readonly code: BackupErrorCode
  /** Backup ID if applicable */
  readonly backupId?: string
  /** VM ID if applicable */
  readonly vmId?: string
  /** Disk path that caused the error */
  readonly diskPath?: string
  /** Command that failed */
  readonly command?: string

  constructor (
    code: BackupErrorCode,
    message: string,
    options?: { backupId?: string, vmId?: string, diskPath?: string, command?: string }
  ) {
    super(message)
    this.name = 'BackupError'
    this.code = code
    this.backupId = options?.backupId
    this.vmId = options?.vmId
    this.diskPath = options?.diskPath
    this.command = options?.command
  }

  /** Returns structured error information */
  toInfo (): BackupErrorInfo {
    return {
      code: this.code,
      message: this.message,
      backupId: this.backupId,
      vmId: this.vmId,
      diskPath: this.diskPath,
      command: this.command
    }
  }
}

// =============================================================================
// Constants
// =============================================================================

/** Default directory for storing backup files */
export const DEFAULT_BACKUP_DIR = '/var/lib/infinization/backups'

/** Default backup type */
export const DEFAULT_BACKUP_TYPE = BackupType.FULL

/** Default compression */
export const DEFAULT_BACKUP_COMPRESSION = BackupCompression.NONE

/** Default retention count for schedules (keep last 5) */
export const DEFAULT_RETENTION_COUNT = 5

/** Maximum number of concurrent backup operations */
export const MAX_CONCURRENT_BACKUPS = 2

/** File extension for backup metadata manifests */
export const BACKUP_MANIFEST_FILENAME = 'backup.json'

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if a value is a valid BackupType.
 * @param value - The value to check
 * @returns true if value is a valid BackupType
 */
export function isValidBackupType (value: string): value is BackupType {
  return Object.values(BackupType).includes(value as BackupType)
}

/**
 * Type guard to check if a value is a valid BackupStatus.
 * @param value - The value to check
 * @returns true if value is a valid BackupStatus
 */
export function isValidBackupStatus (value: string): value is BackupStatus {
  return Object.values(BackupStatus).includes(value as BackupStatus)
}

/**
 * Type guard to check if an error is a BackupError.
 * @param error - The error to check
 * @returns true if error is a BackupError
 */
export function isBackupError (error: unknown): error is BackupError {
  return error instanceof BackupError
}
