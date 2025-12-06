/**
 * VNC display configuration class
 * @module display/VncConfig
 */

import { Debugger } from '../utils/debug'
import {
  VncConfigOptions,
  DisplayValidationResult,
  DisplayCommandArgs,
  DisplayError,
  DisplayErrorCode,
  ValidationError,
  VNC_BASE_PORT,
  VNC_MAX_PASSWORD_LENGTH,
  DEFAULT_VNC_ADDR
} from '../types/display.types'

/** Maximum display number for VNC */
const VNC_MAX_DISPLAY = 99

/** Minimum display number for VNC */
const VNC_MIN_DISPLAY = 0

/**
 * Configuration class for VNC display protocol.
 *
 * Generates validated QEMU arguments for VNC display with standard VGA driver.
 *
 * @remarks
 * **VNC Password Limitation**: VNC passwords are limited to 8 characters by QEMU.
 * For production use, consider SPICE with stronger authentication or use VNC
 * over an SSH tunnel for security.
 *
 * @example
 * ```typescript
 * const config = new VncConfig({
 *   display: 1,  // Port will be 5901 (5900 + 1)
 *   addr: '0.0.0.0',
 *   password: true
 * })
 *
 * const { args, vgaType } = config.generateArgs()
 * // Use args with QemuCommandBuilder
 * ```
 */
export class VncConfig {
  private readonly debug: Debugger
  private readonly display: number
  private readonly addr: string
  private readonly password: boolean

  /**
   * Creates a new VNC configuration instance.
   *
   * @param options - VNC configuration options
   * @throws {DisplayError} If configuration validation fails
   */
  constructor(options: VncConfigOptions) {
    this.debug = new Debugger('vnc-config')

    this.display = options.display
    this.addr = options.addr ?? DEFAULT_VNC_ADDR
    this.password = options.password ?? false

    const validation = this.validate()
    if (!validation.valid) {
      // Use the first validation error's code for the thrown error
      const primaryErrorCode = validation.validationErrors[0]?.code ?? DisplayErrorCode.INVALID_DISPLAY_NUMBER
      const error = new DisplayError(
        primaryErrorCode,
        `VNC configuration validation failed: ${validation.errors.join(', ')}`,
        { options, errors: validation.errors, validationErrors: validation.validationErrors }
      )
      this.debug.log(`Validation failed: ${validation.errors.join(', ')}`)
      throw error
    }

    this.debug.log(
      `VNC config created: display=${this.display}, port=${this.getPort()}, ` +
        `addr=${this.addr}, password=${this.password}`
    )
  }

  /**
   * Validates the VNC configuration.
   *
   * @returns Validation result with any error messages and structured error codes
   */
  validate(): DisplayValidationResult {
    const validationErrors: ValidationError[] = []

    validationErrors.push(...this.validateDisplay(this.display))
    validationErrors.push(...this.validateAddress(this.addr))

    return {
      valid: validationErrors.length === 0,
      errors: validationErrors.map(e => e.message),
      validationErrors
    }
  }

  /**
   * Generates QEMU command-line arguments for this VNC configuration.
   *
   * @returns Object containing args array and VGA type
   */
  generateArgs(): DisplayCommandArgs {
    const args: string[] = []

    // Build VNC option string: addr:display[,password=on]
    let vncOpt = `${this.addr}:${this.display}`
    if (this.password) {
      vncOpt += ',password=on'
    }

    args.push('-vnc', vncOpt)

    // Standard VGA driver for VNC
    args.push('-vga', 'std')

    this.debug.log(`Generated args: ${args.join(' ')}`)

    return {
      args,
      vgaType: 'std'
    }
  }

  /**
   * Gets the configured VNC display number.
   */
  getDisplay(): number {
    return this.display
  }

  /**
   * Gets the calculated VNC port (5900 + display number).
   */
  getPort(): number {
    return VNC_BASE_PORT + this.display
  }

  /**
   * Gets the configured listen address.
   */
  getAddr(): string {
    return this.addr
  }

  /**
   * Checks if password authentication is enabled.
   */
  hasPassword(): boolean {
    return this.password
  }

  /**
   * Converts a VNC display number to its corresponding port.
   *
   * @param display - VNC display number (0-99)
   * @returns Port number (5900 + display)
   *
   * @example
   * ```typescript
   * VncConfig.displayToPort(1)  // Returns 5901
   * VncConfig.displayToPort(0)  // Returns 5900
   * ```
   */
  static displayToPort(display: number): number {
    return VNC_BASE_PORT + display
  }

  /**
   * Converts a port number to its corresponding VNC display number.
   *
   * @param port - Port number (5900+)
   * @returns Display number (port - 5900)
   *
   * @example
   * ```typescript
   * VncConfig.portToDisplay(5901)  // Returns 1
   * VncConfig.portToDisplay(5900)  // Returns 0
   * ```
   */
  static portToDisplay(port: number): number {
    return port - VNC_BASE_PORT
  }

  /**
   * Gets the maximum password length for VNC.
   *
   * @remarks
   * VNC passwords are limited to 8 characters by the QEMU/VNC protocol.
   * Longer passwords will be truncated. For better security, use SPICE
   * or tunnel VNC over SSH.
   */
  static getMaxPasswordLength(): number {
    return VNC_MAX_PASSWORD_LENGTH
  }

  /**
   * Validates the display number.
   */
  private validateDisplay(display: number): ValidationError[] {
    const errors: ValidationError[] = []

    if (!Number.isInteger(display)) {
      errors.push({
        code: DisplayErrorCode.INVALID_DISPLAY_NUMBER,
        message: 'Display number must be an integer'
      })
    } else if (display < VNC_MIN_DISPLAY || display > VNC_MAX_DISPLAY) {
      errors.push({
        code: DisplayErrorCode.INVALID_DISPLAY_NUMBER,
        message: `Display number must be between ${VNC_MIN_DISPLAY} and ${VNC_MAX_DISPLAY}`
      })
    }

    return errors
  }

  /**
   * Validates the listen address.
   */
  private validateAddress(addr: string): ValidationError[] {
    const errors: ValidationError[] = []

    if (!addr || addr.trim().length === 0) {
      errors.push({
        code: DisplayErrorCode.INVALID_ADDRESS,
        message: 'Address cannot be empty'
      })
      return errors
    }

    // Basic validation: allow IPv4, IPv6, or hostname patterns
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/
    const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/
    const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/

    const isValidIpv4 = ipv4Pattern.test(addr)
    const isValidIpv6 = ipv6Pattern.test(addr) || addr === '::' || addr === '::1'
    const isValidHostname = hostnamePattern.test(addr)
    const isLocalhost = addr === 'localhost'
    const isAnyAddr = addr === '0.0.0.0' || addr === '::'

    if (!isValidIpv4 && !isValidIpv6 && !isValidHostname && !isLocalhost && !isAnyAddr) {
      errors.push({
        code: DisplayErrorCode.INVALID_ADDRESS,
        message: `Invalid address format: ${addr}`
      })
    }

    return errors
  }
}
