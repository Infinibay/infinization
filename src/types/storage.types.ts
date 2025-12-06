/**
 * Storage-related type definitions for disk images and snapshots.
 */

/** Supported disk image formats */
export const SUPPORTED_IMAGE_FORMATS = ['qcow2', 'raw', 'vmdk', 'vdi', 'vhdx'] as const

/** Default qcow2 cluster size (64KB) */
export const DEFAULT_CLUSTER_SIZE = 65536

/** Maximum snapshot name length */
export const MAX_SNAPSHOT_NAME_LENGTH = 64

/**
 * Image format type alias
 */
export type ImageFormat = 'qcow2' | 'raw' | 'vmdk' | 'vdi' | 'vhdx'

/**
 * Storage error codes for structured error handling
 */
export enum StorageErrorCode {
  IMAGE_NOT_FOUND = 'IMAGE_NOT_FOUND',
  IMAGE_ALREADY_EXISTS = 'IMAGE_ALREADY_EXISTS',
  SNAPSHOT_NOT_FOUND = 'SNAPSHOT_NOT_FOUND',
  SNAPSHOT_ALREADY_EXISTS = 'SNAPSHOT_ALREADY_EXISTS',
  INVALID_FORMAT = 'INVALID_FORMAT',
  INVALID_SIZE = 'INVALID_SIZE',
  IMAGE_IN_USE = 'IMAGE_IN_USE',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  COMMAND_FAILED = 'COMMAND_FAILED',
  PARSE_ERROR = 'PARSE_ERROR'
}

/**
 * Information about a disk image
 */
export interface ImageInfo {
  /** Full path to image */
  filename: string
  /** Image format */
  format: ImageFormat
  /** Virtual size in bytes */
  virtualSize: number
  /** Actual size on disk in bytes */
  actualSize: number
  /** Cluster size (qcow2 only) */
  clusterSize?: number
  /** Whether image is encrypted */
  encrypted?: boolean
  /** Array of snapshots (qcow2 only) */
  snapshots?: SnapshotInfo[]
  /** Backing file path (if any) */
  backingFile?: string
}

/**
 * Information about a snapshot
 */
export interface SnapshotInfo {
  /** Snapshot ID */
  id: string
  /** Snapshot tag/name */
  name: string
  /** VM state size in bytes */
  vmSize: number
  /** Creation date string */
  date: string
  /** VM clock time */
  vmClock: string
}

/**
 * Result of image integrity check
 */
export interface ImageCheckResult {
  /** Number of errors found */
  errors: number
  /** Number of leaked clusters */
  leaks: number
  /** Number of corruptions */
  corruptions: number
  /** Total clusters in image */
  totalClusters: number
  /** Allocated clusters */
  allocatedClusters: number
}

/**
 * Configuration for creating a disk image
 */
export interface CreateImageOptions {
  /** Image file path */
  path: string
  /** Size in gigabytes */
  sizeGB: number
  /** Image format */
  format: ImageFormat
  /** Cluster size (qcow2 only) */
  clusterSize?: number
  /** Preallocation mode */
  preallocation?: 'off' | 'metadata' | 'falloc' | 'full'
}

/**
 * Configuration for converting a disk image
 */
export interface ConvertImageOptions {
  /** Source image path */
  sourcePath: string
  /** Destination image path */
  destPath: string
  /** Destination format */
  destFormat: ImageFormat
  /** Enable compression (qcow2 only) */
  compress?: boolean
}

/**
 * Configuration for creating a snapshot
 */
export interface SnapshotCreateOptions {
  /** Image file path */
  imagePath: string
  /** Snapshot name */
  name: string
  /** Optional description */
  description?: string
}

/**
 * Structured error for storage operations
 */
export interface StorageErrorInfo {
  /** Error code for programmatic handling */
  code: StorageErrorCode
  /** Human-readable error message */
  message: string
  /** File path that caused error */
  path?: string
  /** Command that failed */
  command?: string
}

/**
 * Error class for storage operations with structured error information
 */
export class StorageError extends Error {
  /** Error code for programmatic handling */
  readonly code: StorageErrorCode
  /** File path that caused error */
  readonly path?: string
  /** Command that failed */
  readonly command?: string

  constructor (code: StorageErrorCode, message: string, path?: string, command?: string) {
    super(message)
    this.name = 'StorageError'
    this.code = code
    this.path = path
    this.command = command
  }

  /** Returns structured error information */
  toInfo (): StorageErrorInfo {
    return {
      code: this.code,
      message: this.message,
      path: this.path,
      command: this.command
    }
  }
}

/**
 * Type guard to check if a format string is a valid ImageFormat
 * @param format - The format string to check
 * @returns true if format is a valid ImageFormat
 */
export function isValidImageFormat (format: string): format is ImageFormat {
  return SUPPORTED_IMAGE_FORMATS.includes(format as ImageFormat)
}
