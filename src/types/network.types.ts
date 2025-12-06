/**
 * Network-related type definitions for TAP devices, bridges, and MAC addresses.
 */

/** QEMU's OUI prefix for MAC addresses */
export const QEMU_MAC_PREFIX = '52:54:00'

/** Linux interface name maximum length */
export const MAX_TAP_NAME_LENGTH = 15

/** Standard prefix for TAP devices */
export const TAP_NAME_PREFIX = 'vnet-'

/**
 * Network device state enumeration
 */
export enum NetworkDeviceState {
  UP = 'up',
  DOWN = 'down',
  UNKNOWN = 'unknown'
}

/**
 * Network error codes for structured error handling
 */
export enum NetworkErrorCode {
  DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',
  DEVICE_ALREADY_EXISTS = 'DEVICE_ALREADY_EXISTS',
  BRIDGE_NOT_FOUND = 'BRIDGE_NOT_FOUND',
  BRIDGE_ALREADY_EXISTS = 'BRIDGE_ALREADY_EXISTS',
  COMMAND_FAILED = 'COMMAND_FAILED',
  INVALID_MAC_ADDRESS = 'INVALID_MAC_ADDRESS',
  PERMISSION_DENIED = 'PERMISSION_DENIED'
}

/** Type alias for MAC address strings */
export type MacAddress = string

/**
 * Configuration for creating a TAP device
 */
export interface TapDeviceConfig {
  /** TAP device name (e.g., "vnet-abc123") */
  name: string
  /** Associated VM ID */
  vmId: string
  /** Optional bridge name to attach to */
  bridge?: string
  /** Optional MAC address */
  mac?: string
}

/**
 * Information about an existing TAP device
 */
export interface TapDeviceInfo {
  /** TAP device name */
  name: string
  /** Whether device exists */
  exists: boolean
  /** Bridge it's attached to (if any) */
  bridge?: string
  /** Interface state */
  state: NetworkDeviceState
}

/**
 * Configuration for creating a network bridge
 */
export interface BridgeConfig {
  /** Bridge name (e.g., "virbr0") */
  name: string
  /** List of interfaces to attach to bridge */
  interfaces?: string[]
}

/**
 * Information about an existing network bridge
 */
export interface BridgeInfo {
  /** Bridge name */
  name: string
  /** Whether bridge exists */
  exists: boolean
  /** Bridge state */
  state: NetworkDeviceState
  /** List of attached interfaces */
  interfaces: string[]
}

/**
 * Structured error for network device operations
 */
export interface NetworkDeviceError {
  /** Error code for programmatic handling */
  code: NetworkErrorCode
  /** Human-readable error message */
  message: string
  /** Device name that caused the error */
  device?: string
  /** Command that failed */
  command?: string
}
