/**
 * Display configuration types for SPICE and VNC protocols
 * @module types/display
 */

// Re-export canonical types from qemu.types
import { DisplayType, VgaType } from './qemu.types'
export { DisplayType, VgaType }

// ============================================================================
// Constants
// ============================================================================

/** Base port for VNC display numbers (actual port = 5900 + display number) */
export const VNC_BASE_PORT = 5900

/** Maximum password length for VNC (QEMU limitation) */
export const VNC_MAX_PASSWORD_LENGTH = 8

/** Minimum valid SPICE port */
export const SPICE_MIN_PORT = 5900

/** Maximum valid SPICE port */
export const SPICE_MAX_PORT = 65535

/** Default listen address for SPICE */
export const DEFAULT_SPICE_ADDR = '0.0.0.0'

/** Default listen address for VNC */
export const DEFAULT_VNC_ADDR = '0.0.0.0'

// ============================================================================
// Enums
// ============================================================================

/**
 * Error codes for display configuration validation
 */
export enum DisplayErrorCode {
  INVALID_PORT = 'INVALID_PORT',
  INVALID_PASSWORD = 'INVALID_PASSWORD',
  INVALID_ADDRESS = 'INVALID_ADDRESS',
  INVALID_DISPLAY_NUMBER = 'INVALID_DISPLAY_NUMBER',
  PASSWORD_TOO_LONG = 'PASSWORD_TOO_LONG',
  PORT_OUT_OF_RANGE = 'PORT_OUT_OF_RANGE',
  CONFLICTING_OPTIONS = 'CONFLICTING_OPTIONS'
}

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Configuration options for SPICE display
 */
export interface SpiceConfigOptions {
  /** SPICE listening port (5900-65535) */
  port: number
  /** Listen address (IPv4, IPv6, or hostname) */
  addr?: string
  /** Authentication password */
  password?: string
  /** Disable ticket-based authentication (mutually exclusive with password) */
  disableTicketing?: boolean
  /** Enable SPICE guest agent for copy/paste via virtio-serial (default: true) */
  enableAgent?: boolean
}

/**
 * Configuration options for VNC display
 */
export interface VncConfigOptions {
  /** Display number (0-99, actual port = 5900 + display) */
  display: number
  /** Listen address (IPv4, IPv6, or hostname) */
  addr?: string
  /** Enable password authentication */
  password?: boolean
}

/**
 * Structured validation error with code and message
 */
export interface ValidationError {
  /** Error code identifying the type of validation failure */
  code: DisplayErrorCode
  /** Human-readable error message */
  message: string
}

/**
 * Result of display configuration validation
 */
export interface DisplayValidationResult {
  /** Whether the configuration is valid */
  valid: boolean
  /** Array of validation error messages (for backward compatibility) */
  errors: string[]
  /** Array of structured validation errors with codes */
  validationErrors: ValidationError[]
}

/**
 * Generated QEMU command arguments for display configuration
 */
export interface DisplayCommandArgs {
  /** Array of QEMU command-line arguments */
  args: string[]
  /** VGA device type to use */
  vgaType: VgaType
}

// ============================================================================
// Error Class
// ============================================================================

/**
 * Error class for display configuration errors
 */
export class DisplayError extends Error {
  /** Error code identifying the type of error */
  public readonly code: DisplayErrorCode
  /** Additional context about the error */
  public readonly context?: Record<string, unknown>

  constructor(
    code: DisplayErrorCode,
    message: string,
    context?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'DisplayError'
    this.code = code
    this.context = context

    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DisplayError)
    }
  }
}
