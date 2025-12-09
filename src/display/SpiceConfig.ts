/**
 * SPICE display configuration class
 * @module display/SpiceConfig
 */

import { Debugger } from '../utils/debug'
import {
  SpiceConfigOptions,
  DisplayValidationResult,
  DisplayCommandArgs,
  DisplayError,
  DisplayErrorCode,
  ValidationError,
  SPICE_MIN_PORT,
  SPICE_MAX_PORT,
  DEFAULT_SPICE_ADDR
} from '../types/display.types'

/**
 * Configuration class for SPICE display protocol.
 *
 * Generates validated QEMU arguments for SPICE display with QXL driver
 * and optional guest agent support for copy/paste functionality.
 *
 * @example
 * ```typescript
 * const config = new SpiceConfig({
 *   port: 5901,
 *   addr: '0.0.0.0',
 *   password: 'secure123',
 *   enableAgent: true
 * })
 *
 * const { args, vgaType } = config.generateArgs()
 * // Use args with QemuCommandBuilder
 * ```
 */
export class SpiceConfig {
  private readonly debug: Debugger
  private readonly port: number
  private readonly addr: string
  private readonly password?: string
  private readonly disableTicketing: boolean
  private readonly enableAgent: boolean

  /**
   * Creates a new SPICE configuration instance.
   *
   * @param options - SPICE configuration options
   * @throws {DisplayError} If configuration validation fails
   */
  constructor(options: SpiceConfigOptions) {
    this.debug = new Debugger('spice-config')

    this.port = options.port
    this.addr = options.addr ?? DEFAULT_SPICE_ADDR
    this.password = options.password
    this.disableTicketing = options.disableTicketing ?? false
    this.enableAgent = options.enableAgent ?? true

    const validation = this.validate()
    if (!validation.valid) {
      // Use the first validation error's code for the thrown error
      const primaryErrorCode = validation.validationErrors[0]?.code ?? DisplayErrorCode.INVALID_PORT
      const error = new DisplayError(
        primaryErrorCode,
        `SPICE configuration validation failed: ${validation.errors.join(', ')}`,
        { options, errors: validation.errors, validationErrors: validation.validationErrors }
      )
      this.debug.log(`Validation failed: ${validation.errors.join(', ')}`)
      throw error
    }

    this.debug.log(
      `SPICE config created: port=${this.port}, addr=${this.addr}, ` +
        `auth=${this.password ? 'password' : this.disableTicketing ? 'disabled' : 'default'}, ` +
        `agent=${this.enableAgent}`
    )
  }

  /**
   * Validates the SPICE configuration.
   *
   * @returns Validation result with any error messages and structured error codes
   */
  validate(): DisplayValidationResult {
    const validationErrors: ValidationError[] = []

    validationErrors.push(...this.validatePort(this.port))
    validationErrors.push(...this.validateAddress(this.addr))
    validationErrors.push(...this.validatePassword(this.password))
    validationErrors.push(...this.validateAuthOptions())

    return {
      valid: validationErrors.length === 0,
      errors: validationErrors.map(e => e.message),
      validationErrors
    }
  }

  /**
   * Generates QEMU command-line arguments for this SPICE configuration.
   *
   * @returns Object containing args array and VGA type
   */
  generateArgs(): DisplayCommandArgs {
    const args: string[] = []

    // Build SPICE option string
    const spiceOpts: string[] = [
      `port=${this.port}`,
      `addr=${this.addr}`
    ]

    if (this.password) {
      spiceOpts.push(`password=${this.password}`)
    } else if (this.disableTicketing) {
      spiceOpts.push('disable-ticketing=on')
    }

    args.push('-spice', spiceOpts.join(','))

    // QXL VGA driver for SPICE
    args.push('-vga', 'qxl')

    // Note: Guest agent devices (virtio-serial-pci, virtserialport, chardev) are NOT added here.
    // They are managed by QemuCommandBuilder.addSpice() using ensureVirtioSerial() to prevent
    // duplicate virtio-serial-pci controllers when multiple channels are configured.

    this.debug.log(`Generated args: ${args.join(' ')}`)

    return {
      args,
      vgaType: 'qxl'
    }
  }

  /**
   * Gets the configured SPICE port.
   */
  getPort(): number {
    return this.port
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
    return this.password !== undefined && this.password.length > 0
  }

  /**
   * Checks if the guest agent is enabled.
   */
  isAgentEnabled(): boolean {
    return this.enableAgent
  }

  /**
   * Validates the port number.
   */
  private validatePort(port: number): ValidationError[] {
    const errors: ValidationError[] = []

    if (!Number.isInteger(port)) {
      errors.push({
        code: DisplayErrorCode.INVALID_PORT,
        message: 'Port must be an integer'
      })
    } else if (port < SPICE_MIN_PORT || port > SPICE_MAX_PORT) {
      errors.push({
        code: DisplayErrorCode.PORT_OUT_OF_RANGE,
        message: `Port must be between ${SPICE_MIN_PORT} and ${SPICE_MAX_PORT}`
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

  /**
   * Validates the password if provided.
   */
  private validatePassword(password?: string): ValidationError[] {
    const errors: ValidationError[] = []

    if (password !== undefined && password.length === 0) {
      errors.push({
        code: DisplayErrorCode.INVALID_PASSWORD,
        message: 'Password cannot be empty string (use undefined for no password)'
      })
    }

    return errors
  }

  /**
   * Validates mutual exclusivity of authentication options.
   */
  private validateAuthOptions(): ValidationError[] {
    const errors: ValidationError[] = []

    if (this.password && this.disableTicketing) {
      errors.push({
        code: DisplayErrorCode.CONFLICTING_OPTIONS,
        message: 'Cannot use both password and disableTicketing options'
      })
    }

    return errors
  }
}
