/**
 * QMP (QEMU Machine Protocol) Type Definitions
 *
 * This file contains comprehensive TypeScript types for the QMP protocol,
 * which is a JSON-based protocol for communicating with QEMU over Unix sockets.
 */

// =============================================================================
// Core Protocol Types
// =============================================================================

/**
 * QMP protocol version information
 */
export interface QMPVersion {
  qemu: {
    micro: number
    minor: number
    major: number
  }
  package: string
}

/**
 * QMP server greeting message sent upon connection
 */
export interface QMPGreeting {
  QMP: {
    version: QMPVersion
    capabilities: string[]
  }
}

/**
 * QMP command message sent from client to server
 */
export interface QMPMessage {
  execute: string
  arguments?: Record<string, unknown>
  id?: string
}

/**
 * QMP error object returned when a command fails
 */
export interface QMPError {
  class: string
  desc: string
}

/**
 * QMP response message from server to client
 * @template T The type of the return data
 */
export interface QMPResponse<T = unknown> {
  return?: T
  error?: QMPError
  id?: string
}

/**
 * QMP timestamp object used in events
 */
export interface QMPTimestamp {
  seconds: number
  microseconds: number
}

/**
 * QMP event message emitted by QEMU
 */
export interface QMPEvent<T = unknown> {
  event: string
  data?: T
  timestamp: QMPTimestamp
}

// =============================================================================
// Event Types
// =============================================================================

/**
 * Union type of all supported QMP events
 */
export type QMPEventType =
  | 'SHUTDOWN'
  | 'POWERDOWN'
  | 'RESET'
  | 'STOP'
  | 'RESUME'
  | 'SUSPEND'
  | 'WAKEUP'
  | 'DEVICE_DELETED'
  | 'BLOCK_JOB_COMPLETED'

/**
 * Event data for SHUTDOWN event
 */
export interface QMPShutdownEventData {
  guest: boolean
  reason: 'guest-shutdown' | 'guest-reset' | 'guest-panic' | 'host-qmp-quit' | 'host-qmp-system-reset' | 'host-signal' | 'host-ui' | 'subsystem-reset' | 'snapshot-load'
}

/**
 * Event data for DEVICE_DELETED event
 */
export interface QMPDeviceDeletedEventData {
  device?: string
  path: string
}

/**
 * Event data for BLOCK_JOB_COMPLETED event
 */
export interface QMPBlockJobCompletedEventData {
  type: string
  device: string
  len: number
  offset: number
  speed: number
  error?: string
}

// =============================================================================
// Command Response Types
// =============================================================================

/**
 * VM status values returned by query-status command
 */
export type QMPVMStatus =
  | 'running'
  | 'paused'
  | 'shutdown'
  | 'inmigrate'
  | 'postmigrate'
  | 'prelaunch'
  | 'finish-migrate'
  | 'restore-vm'
  | 'suspended'
  | 'watchdog'
  | 'guest-panicked'
  | 'io-error'
  | 'colo'

/**
 * Response type for query-status command
 */
export interface QMPStatusInfo {
  running: boolean
  singlestep: boolean
  status: QMPVMStatus
}

/**
 * CPU information from query-cpus-fast command
 */
export interface QMPCpuInfo {
  'cpu-index': number
  'qom-path': string
  'thread-id': number
  props?: {
    'core-id'?: number
    'thread-id'?: number
    'socket-id'?: number
    'node-id'?: number
  }
  target?: string
}

/**
 * Block device image information
 */
export interface QMPBlockImageInfo {
  filename: string
  format: string
  'virtual-size': number
  'actual-size'?: number
  'dirty-flag'?: boolean
  'cluster-size'?: number
  encrypted?: boolean
  compressed?: boolean
  'backing-filename'?: string
  'full-backing-filename'?: string
  'backing-filename-format'?: string
  'backing-image'?: QMPBlockImageInfo
}

/**
 * Inserted block device information
 */
export interface QMPBlockInsertedInfo {
  file: string
  node_name?: string
  ro: boolean
  drv: string
  encrypted: boolean
  bps?: number
  bps_rd?: number
  bps_wr?: number
  iops?: number
  iops_rd?: number
  iops_wr?: number
  image?: QMPBlockImageInfo
  detect_zeroes?: string
  write_threshold?: number
}

/**
 * Block device information from query-block command
 */
export interface QMPBlockInfo {
  device: string
  qdev?: string
  type: string
  removable: boolean
  locked: boolean
  tray_open?: boolean
  io_status?: string
  inserted?: QMPBlockInsertedInfo
}

/**
 * VNC client information
 */
export interface QMPVncClientInfo {
  host: string
  service: string
  family: 'ipv4' | 'ipv6' | 'unix'
  websocket: boolean
  x509_dname?: string
  sasl_username?: string
}

/**
 * VNC server information from query-vnc command
 */
export interface QMPVncInfo {
  enabled: boolean
  host?: string
  family?: 'ipv4' | 'ipv6' | 'unix'
  service?: string
  auth?: string
  clients?: QMPVncClientInfo[]
}

/**
 * SPICE channel information
 */
export interface QMPSpiceChannel {
  host: string
  family: 'ipv4' | 'ipv6' | 'unix'
  port: string
  'connection-id': number
  'channel-type': number
  'channel-id': number
  tls: boolean
}

/**
 * SPICE server information from query-spice command
 */
export interface QMPSpiceInfo {
  enabled: boolean
  migrated?: boolean
  host?: string
  port?: number
  'tls-port'?: number
  auth?: string
  'compiled-version'?: string
  'mouse-mode'?: 'client' | 'server'
  channels?: QMPSpiceChannel[]
}

/**
 * Memory size information from query-memory-size-summary
 */
export interface QMPMemorySizeInfo {
  'base-memory': number
  'plugged-memory'?: number
}

/**
 * Balloon device information from query-balloon command.
 *
 * QEMU returns the current balloon size in bytes. The `actual` field
 * represents the current memory allocated to the VM via the balloon device.
 *
 * @remarks
 * - Memory values are in bytes, conversion to GB/MB should be done by caller
 * - Example: 2GB = 2 * 1024 * 1024 * 1024 = 2147483648 bytes
 */
export interface QMPBalloonInfo {
  /** Current balloon size in bytes */
  actual: number
}

// =============================================================================
// Client Configuration Types
// =============================================================================

/**
 * Configuration options for QMPClient
 */
export interface QMPClientOptions {
  /** Connection timeout in milliseconds (default: 5000) */
  connectTimeout?: number
  /** Command execution timeout in milliseconds (default: 30000) */
  commandTimeout?: number
  /** Whether to automatically reconnect on disconnect (default: false) */
  reconnect?: boolean
  /** Delay between reconnection attempts in milliseconds (default: 1000) */
  reconnectDelay?: number
  /** Maximum number of reconnection attempts (default: 3) */
  maxReconnectAttempts?: number
}

/**
 * Configuration for QMP socket in QemuProcess
 */
export interface QMPSocketOptions {
  /** Unix socket path for QMP communication */
  path: string
  /** Connection timeout in milliseconds */
  connectTimeout?: number
  /** Command execution timeout in milliseconds */
  commandTimeout?: number
}
