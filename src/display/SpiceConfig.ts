/**
 * SPICE display configuration class
 * @module display/SpiceConfig
 */

import * as fs from 'fs'
import { Debugger } from '../utils/debug'
import {
  SpiceConfigOptions,
  DisplayValidationResult,
  DisplayCommandArgs,
  DisplayError,
  DisplayErrorCode,
  ValidationError,
  SpiceImageCompression,
  SpiceWanCompression,
  SpiceStreamingMode,
  SpicePlaybackCompression,
  SPICE_MIN_PORT,
  SPICE_MAX_PORT,
  DEFAULT_SPICE_ADDR
} from '../types/display.types'

/**
 * Configuration class for SPICE display protocol.
 *
 * Generates validated QEMU arguments for SPICE display with QXL driver,
 * guest agent support, and comprehensive performance optimizations.
 *
 * ## Performance Optimizations
 *
 * ### Compression Options
 * - **image-compression**: Controls how images are compressed before transmission
 *   - `auto_glz`: Automatic GLZ (default) - Best balance for most scenarios
 *   - `auto_lz`: Automatic LZ - Alternative auto mode
 *   - `quic`: SFALIC algorithm - Fast, lower compression
 *   - `glz`: LZ with global dictionary - High compression, more CPU
 *   - `lz`: Lempel-Ziv - Moderate compression
 *   - `off`: No compression - Highest bandwidth, lowest CPU
 *
 * - **jpeg-wan-compression**: JPEG compression for WAN scenarios (auto/never/always)
 * - **zlib-glz-wan-compression**: zlib-glz compression for WAN (auto/never/always)
 *
 * ### Streaming Options
 * - **streaming-video**: Video detection and compression
 *   - `filter`: Smart detection (default) - Detects video regions automatically
 *   - `all`: Treat all content as video - Lower quality, better performance
 *   - `off`: Disable video streaming - Higher quality, more bandwidth
 *
 * ### Audio Options
 * - **playback-compression**: CELT algorithm for audio (on/off, default: on)
 *
 * ### GL Acceleration
 * - **gl**: Enable OpenGL acceleration (requires recent QEMU/SPICE/Mesa)
 *   - Note: Currently local-only, remote GL support is experimental
 * - **rendernode**: Specify GPU render node (e.g., /dev/dri/renderD128)
 *
 * ## Resolution Adjustment
 *
 * Automatic resolution adjustment requires:
 * 1. QXL VGA driver (automatically configured)
 * 2. SPICE vdagent running in guest OS
 * 3. SPICE client that supports resolution changes
 *
 * **Guest Setup:**
 * - **Linux**: Install `spice-vdagent` package and ensure service is running
 * - **Windows**: Install SPICE Guest Tools (includes vdagent)
 *
 * **QXL Memory Sizing:**
 * - 16 MB: Default, suitable for 1920x1080 and below
 * - 32 MB: Recommended for 2560x1440
 * - 64 MB: Recommended for 4K (3840x2160)
 * - 128 MB: For multiple 4K displays
 *
 * ## Performance Impact
 *
 * | Option | CPU Impact | Bandwidth Impact | Use Case |
 * |--------|-----------|------------------|----------|
 * | auto_glz | Medium | Low | General purpose (default) |
 * | quic | Low | Medium | Fast networks, low CPU |
 * | glz | High | Very Low | Slow networks, powerful CPU |
 * | off | Very Low | Very High | LAN with high bandwidth |
 * | streaming=filter | Medium | Low | Mixed content (default) |
 * | streaming=all | Low | Very Low | Video-heavy workloads |
 * | gl=on | Low (GPU) | Medium | 3D applications (local) |
 *
 * @example
 * ```typescript
 * // Standard configuration with optimizations
 * const config = new SpiceConfig({
 *   port: 5901,
 *   addr: '0.0.0.0',
 *   password: 'secure123',
 *   enableAgent: true,
 *   imageCompression: 'auto_glz',
 *   streamingVideo: 'filter',
 *   playbackCompression: 'on'
 * })
 *
 * // High-bandwidth LAN scenario (no compression)
 * const lanConfig = new SpiceConfig({
 *   port: 5901,
 *   imageCompression: 'off',
 *   streamingVideo: 'off'
 * })
 *
 * // Low-bandwidth WAN scenario (maximum compression)
 * const wanConfig = new SpiceConfig({
 *   port: 5901,
 *   imageCompression: 'glz',
 *   jpegWanCompression: 'always',
 *   zlibGlzWanCompression: 'always',
 *   streamingVideo: 'all'
 * })
 *
 * // GL acceleration for 3D workloads (local only)
 * const glConfig = new SpiceConfig({
 *   port: 5901,
 *   gl: true,
 *   rendernode: '/dev/dri/renderD128'
 * })
 * ```
 */
export class SpiceConfig {
  private readonly debug: Debugger
  private readonly port: number
  private readonly addr: string
  private readonly password?: string
  private readonly disableTicketing: boolean
  private readonly enableAgent: boolean

  // Compression options
  private readonly imageCompression: SpiceImageCompression
  private readonly jpegWanCompression: SpiceWanCompression
  private readonly zlibGlzWanCompression: SpiceWanCompression

  // Streaming options
  private readonly streamingVideo: SpiceStreamingMode

  // Audio options
  private readonly playbackCompression: SpicePlaybackCompression

  // GL acceleration
  private readonly gl: boolean
  private readonly rendernode?: string

  // Agent options
  private readonly disableCopyPaste: boolean
  private readonly disableAgentFileXfer: boolean
  private readonly seamlessMigration: boolean

  /**
   * Creates a new SPICE configuration instance.
   *
   * @param options - SPICE configuration options
   * @throws {DisplayError} If configuration validation fails
   */
  constructor(options: SpiceConfigOptions) {
    this.debug = new Debugger('spice-config')

    // Basic options
    this.port = options.port
    this.addr = options.addr ?? DEFAULT_SPICE_ADDR
    this.password = options.password
    this.disableTicketing = options.disableTicketing ?? false
    this.enableAgent = options.enableAgent ?? true

    // Compression options with sensible defaults
    this.imageCompression = options.imageCompression ?? 'auto_glz'
    this.jpegWanCompression = options.jpegWanCompression ?? 'auto'
    this.zlibGlzWanCompression = options.zlibGlzWanCompression ?? 'auto'

    // Streaming options
    this.streamingVideo = options.streamingVideo ?? 'filter'

    // Audio options
    this.playbackCompression = options.playbackCompression ?? 'on'

    // GL acceleration (disabled by default)
    this.gl = options.gl ?? false
    this.rendernode = options.rendernode

    // Agent options
    this.disableCopyPaste = options.disableCopyPaste ?? false
    this.disableAgentFileXfer = options.disableAgentFileXfer ?? false
    this.seamlessMigration = options.seamlessMigration ?? false

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

    // Enhanced debug logging
    this.debug.log(
      `SPICE config created: port=${this.port}, addr=${this.addr}, ` +
        `auth=${this.password ? 'password' : this.disableTicketing ? 'disabled' : 'default'}, ` +
        `agent=${this.enableAgent}, compression=${this.imageCompression}, ` +
        `streaming=${this.streamingVideo}, gl=${this.gl}`
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

    // Validate new optimization options
    validationErrors.push(...this.validateImageCompression(this.imageCompression))
    validationErrors.push(...this.validateWanCompression(this.jpegWanCompression, 'jpeg'))
    validationErrors.push(...this.validateWanCompression(this.zlibGlzWanCompression, 'zlib'))
    validationErrors.push(...this.validateStreamingMode(this.streamingVideo))
    validationErrors.push(...this.validateGlConfig())

    return {
      valid: validationErrors.length === 0,
      errors: validationErrors.map(e => e.message),
      validationErrors
    }
  }

  /**
   * Generates QEMU command-line arguments for this SPICE configuration.
   *
   * Builds a comprehensive SPICE option string with all optimizations:
   * - Compression: image, JPEG, zlib-glz
   * - Streaming: video detection and compression
   * - Audio: playback compression
   * - GL: OpenGL acceleration (if enabled)
   * - Agent: copy/paste, file transfer controls
   *
   * @returns Object containing args array and VGA type
   */
  generateArgs(): DisplayCommandArgs {
    const args: string[] = []

    // Build SPICE option string with all optimizations
    const spiceOpts: string[] = [
      `port=${this.port}`,
      `addr=${this.addr}`
    ]

    // Authentication
    if (this.password) {
      spiceOpts.push(`password=${this.password}`)
    } else if (this.disableTicketing) {
      spiceOpts.push('disable-ticketing=on')
    }

    // ===== Compression Options =====
    // Image compression (default: auto_glz for best balance)
    spiceOpts.push(`image-compression=${this.imageCompression}`)

    // JPEG WAN compression (default: auto)
    spiceOpts.push(`jpeg-wan-compression=${this.jpegWanCompression}`)

    // zlib-glz WAN compression (default: auto)
    spiceOpts.push(`zlib-glz-wan-compression=${this.zlibGlzWanCompression}`)

    // ===== Streaming Options =====
    // Video streaming detection (default: filter for smart detection)
    spiceOpts.push(`streaming-video=${this.streamingVideo}`)

    // ===== Audio Options =====
    // Playback compression using CELT (default: on)
    spiceOpts.push(`playback-compression=${this.playbackCompression}`)

    // ===== GL Acceleration =====
    if (this.gl) {
      spiceOpts.push('gl=on')
      if (this.rendernode) {
        spiceOpts.push(`rendernode=${this.rendernode}`)
      }
    }

    // ===== Agent Options =====
    if (this.disableCopyPaste) {
      spiceOpts.push('disable-copy-paste=on')
    }

    if (this.disableAgentFileXfer) {
      spiceOpts.push('disable-agent-file-xfer=on')
    }

    if (this.seamlessMigration) {
      spiceOpts.push('seamless-migration=on')
    }

    args.push('-spice', spiceOpts.join(','))

    // QXL VGA driver for SPICE (required for resolution adjustment)
    args.push('-vga', 'qxl')

    // Note: Guest agent devices (virtio-serial-pci, virtserialport, chardev) are NOT added here.
    // They are managed by QemuCommandBuilder.addSpice() using ensureVirtioSerial() to prevent
    // duplicate virtio-serial-pci controllers when multiple channels are configured.

    this.debug.log(`Generated optimized SPICE args: ${args.join(' ')}`)

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

  /**
   * Validates image compression mode.
   */
  private validateImageCompression(mode: SpiceImageCompression): ValidationError[] {
    const errors: ValidationError[] = []
    const validModes: SpiceImageCompression[] = ['auto_glz', 'auto_lz', 'quic', 'glz', 'lz', 'off']

    if (!validModes.includes(mode)) {
      errors.push({
        code: DisplayErrorCode.INVALID_COMPRESSION_MODE,
        message: `Invalid image compression mode: ${mode}. Must be one of: ${validModes.join(', ')}`
      })
    }

    return errors
  }

  /**
   * Validates WAN compression mode.
   */
  private validateWanCompression(mode: SpiceWanCompression, type: 'jpeg' | 'zlib'): ValidationError[] {
    const errors: ValidationError[] = []
    const validModes: SpiceWanCompression[] = ['auto', 'never', 'always']

    if (!validModes.includes(mode)) {
      errors.push({
        code: DisplayErrorCode.INVALID_COMPRESSION_MODE,
        message: `Invalid ${type} WAN compression mode: ${mode}. Must be one of: ${validModes.join(', ')}`
      })
    }

    return errors
  }

  /**
   * Validates streaming video mode.
   */
  private validateStreamingMode(mode: SpiceStreamingMode): ValidationError[] {
    const errors: ValidationError[] = []
    const validModes: SpiceStreamingMode[] = ['off', 'all', 'filter']

    if (!validModes.includes(mode)) {
      errors.push({
        code: DisplayErrorCode.INVALID_STREAMING_MODE,
        message: `Invalid streaming video mode: ${mode}. Must be one of: ${validModes.join(', ')}`
      })
    }

    return errors
  }

  /**
   * Validates GL acceleration configuration.
   */
  private validateGlConfig(): ValidationError[] {
    const errors: ValidationError[] = []

    if (this.gl && this.rendernode) {
      // Check if rendernode exists (basic validation)
      if (!fs.existsSync(this.rendernode)) {
        errors.push({
          code: DisplayErrorCode.RENDERNODE_NOT_FOUND,
          message: `GL rendernode not found: ${this.rendernode}`
        })
      }
    }

    return errors
  }
}
