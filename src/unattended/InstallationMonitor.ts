/**
 * InstallationMonitor - Monitors unattended OS installation via QMP events
 *
 * This class handles QMP event monitoring during OS installation, tracking
 * installation phases, detecting completion or failure, and implementing
 * timeout mechanisms for long-running installations.
 *
 * @example
 * ```typescript
 * const monitor = new InstallationMonitor(qmpClient, {
 *   timeout: 60 * 60 * 1000,  // 60 minutes
 *   maxResets: 5,
 *   checkInterval: 5000
 * })
 *
 * monitor.on('progress', (progress) => {
 *   console.log(`Phase: ${progress.phase} - ${progress.message}`)
 * })
 *
 * const result = await monitor.start()
 * if (result.success) {
 *   console.log('Installation completed!')
 * }
 * ```
 */

import { EventEmitter } from 'events'
import { QMPClient } from '../core/QMPClient'
import { Debugger } from '../utils/debug'
import {
  InstallationPhase,
  InstallationProgress,
  InstallationResult,
  MonitorConfig,
  UnattendedError,
  UnattendedErrorCode,
  DEFAULT_INSTALLATION_TIMEOUT,
  DEFAULT_MAX_RESETS,
  DEFAULT_CHECK_INTERVAL,
  isUnattendedError
} from '../types/unattended.types'

/**
 * Default configuration for installation monitoring
 */
const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  timeout: DEFAULT_INSTALLATION_TIMEOUT,
  maxResets: DEFAULT_MAX_RESETS,
  checkInterval: DEFAULT_CHECK_INTERVAL
}

/**
 * InstallationMonitor tracks and manages the unattended OS installation process
 * through QMP event monitoring.
 */
export class InstallationMonitor extends EventEmitter {
  private readonly debug: Debugger
  private readonly qmpClient: QMPClient
  private readonly config: MonitorConfig

  // Monitoring state
  private running: boolean = false
  private startTime: number = 0
  private resetCount: number = 0
  private currentPhase: InstallationPhase = 'installing'
  private phases: InstallationProgress[] = []
  private timeoutTimer: NodeJS.Timeout | null = null
  private checkTimer: NodeJS.Timeout | null = null

  // Promise resolution handles
  private resolveMonitor: ((result: InstallationResult) => void) | null = null
  private rejectMonitor: ((error: Error) => void) | null = null

  // Event handlers (stored for cleanup)
  private shutdownHandler: ((data: unknown, timestamp: unknown) => void) | null = null
  private resetHandler: ((data: unknown, timestamp: unknown) => void) | null = null
  private powerdownHandler: ((data: unknown, timestamp: unknown) => void) | null = null
  private disconnectHandler: (() => void) | null = null

  /**
   * Creates a new InstallationMonitor instance
   *
   * @param qmpClient - Connected QMPClient instance
   * @param config - Optional monitoring configuration
   */
  constructor (qmpClient: QMPClient, config?: Partial<MonitorConfig>) {
    super()
    this.debug = new Debugger('installation-monitor')
    this.qmpClient = qmpClient
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config }
  }

  /**
   * Starts monitoring the installation process
   *
   * @returns Promise that resolves when installation completes or fails
   */
  public async start (): Promise<InstallationResult> {
    if (this.running) {
      throw new UnattendedError(
        UnattendedErrorCode.INVALID_CONFIG,
        'Monitor is already running'
      )
    }

    if (!this.qmpClient.isConnected()) {
      throw new UnattendedError(
        UnattendedErrorCode.QMP_ERROR,
        'QMP client is not connected'
      )
    }

    this.running = true
    this.startTime = Date.now()
    this.resetCount = 0
    this.phases = []

    this.debug.log('Starting installation monitoring')
    this.updatePhase('installing', 'Installation in progress')

    return new Promise((resolve, reject) => {
      this.resolveMonitor = resolve
      this.rejectMonitor = reject

      // Attach QMP event listeners
      this.attachEventListeners()

      // Start timeout monitoring
      this.startTimeoutMonitoring()
    })
  }

  /**
   * Stops the installation monitor
   */
  public stop (): void {
    if (!this.running) {
      return
    }

    this.debug.log('Stopping installation monitor')
    this.running = false
    this.detachEventListeners()
    this.clearTimers()
  }

  /**
   * Returns whether the monitor is currently running
   */
  public isRunning (): boolean {
    return this.running
  }

  /**
   * Returns the current installation phase
   */
  public getCurrentPhase (): InstallationPhase {
    return this.currentPhase
  }

  /**
   * Returns all recorded phases
   */
  public getPhases (): InstallationProgress[] {
    return [...this.phases]
  }

  /**
   * Returns the elapsed time in milliseconds
   */
  public getElapsedTime (): number {
    if (this.startTime === 0) {
      return 0
    }
    return Date.now() - this.startTime
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Attaches event listeners to the QMP client
   */
  private attachEventListeners (): void {
    // SHUTDOWN event - typically indicates installation completed
    this.shutdownHandler = (data: unknown, timestamp: unknown) => {
      this.handleShutdown(data, timestamp)
    }
    this.qmpClient.on('SHUTDOWN', this.shutdownHandler)

    // RESET event - may indicate installation phase transition or failure
    this.resetHandler = (data: unknown, timestamp: unknown) => {
      this.handleReset(data, timestamp)
    }
    this.qmpClient.on('RESET', this.resetHandler)

    // POWERDOWN event - guest OS initiated shutdown
    this.powerdownHandler = (data: unknown, timestamp: unknown) => {
      this.handlePowerdown(data, timestamp)
    }
    this.qmpClient.on('POWERDOWN', this.powerdownHandler)

    // Disconnect event - QMP connection lost
    this.disconnectHandler = () => {
      this.handleDisconnect()
    }
    this.qmpClient.on('disconnect', this.disconnectHandler)
  }

  /**
   * Detaches event listeners from the QMP client
   */
  private detachEventListeners (): void {
    if (this.shutdownHandler) {
      this.qmpClient.off('SHUTDOWN', this.shutdownHandler)
      this.shutdownHandler = null
    }
    if (this.resetHandler) {
      this.qmpClient.off('RESET', this.resetHandler)
      this.resetHandler = null
    }
    if (this.powerdownHandler) {
      this.qmpClient.off('POWERDOWN', this.powerdownHandler)
      this.powerdownHandler = null
    }
    if (this.disconnectHandler) {
      this.qmpClient.off('disconnect', this.disconnectHandler)
      this.disconnectHandler = null
    }
  }

  /**
   * Starts the timeout monitoring timers
   */
  private startTimeoutMonitoring (): void {
    // Absolute timeout
    this.timeoutTimer = setTimeout(() => {
      this.handleTimeout()
    }, this.config.timeout)

    // Periodic check interval
    this.checkTimer = setInterval(() => {
      this.checkTimeout()
    }, this.config.checkInterval)
  }

  /**
   * Clears all timers
   */
  private clearTimers (): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
    }
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
  }

  /**
   * Handles SHUTDOWN QMP event
   */
  private handleShutdown (_data: unknown, _timestamp: unknown): void {
    this.debug.log('Received SHUTDOWN event')

    // SHUTDOWN during installation typically means installation completed
    // and the VM is rebooting or shutting down for the first time
    this.updatePhase('completing', 'Installation completing, system shutting down')

    // Complete the installation successfully
    this.completeInstallation(true)
  }

  /**
   * Handles RESET QMP event
   */
  private handleReset (_data: unknown, _timestamp: unknown): void {
    this.resetCount++
    this.debug.log(`Received RESET event (count: ${this.resetCount})`)

    // Some resets are normal during installation (Windows restarts multiple times)
    // but too many resets might indicate a problem
    if (this.resetCount > this.config.maxResets) {
      this.debug.log('error', `Too many resets (${this.resetCount}), failing installation`)
      this.failInstallation(
        new UnattendedError(
          UnattendedErrorCode.INSTALLATION_RESET_LIMIT_EXCEEDED,
          `Installation failed: exceeded maximum reset count (${this.config.maxResets}). ` +
          `The VM may be stuck in a boot loop or installation failure loop.`
        )
      )
      return
    }

    // Update phase to indicate a reset occurred
    this.updatePhase('installing', `Installation in progress (reset ${this.resetCount})`)
  }

  /**
   * Handles POWERDOWN QMP event
   */
  private handlePowerdown (_data: unknown, _timestamp: unknown): void {
    this.debug.log('Received POWERDOWN event')

    // POWERDOWN during installation typically means installation completed
    // and the guest OS initiated a graceful shutdown
    this.updatePhase('completing', 'Installation completing, graceful shutdown')

    // Complete the installation successfully
    this.completeInstallation(true)
  }

  /**
   * Handles QMP disconnect event
   */
  private handleDisconnect (): void {
    this.debug.log('error', 'QMP connection lost during installation')

    // If we're still monitoring, this is an error
    if (this.running) {
      this.failInstallation(
        new UnattendedError(
          UnattendedErrorCode.QMP_ERROR,
          'QMP connection lost during installation'
        )
      )
    }
  }

  /**
   * Handles installation timeout
   */
  private handleTimeout (): void {
    this.debug.log('error', 'Installation timeout reached')

    this.failInstallation(
      new UnattendedError(
        UnattendedErrorCode.INSTALLATION_TIMEOUT,
        `Installation timed out after ${this.config.timeout}ms`
      )
    )
  }

  /**
   * Periodic timeout check (for logging/progress updates)
   */
  private checkTimeout (): void {
    const elapsed = this.getElapsedTime()
    const remaining = this.config.timeout - elapsed
    const percentComplete = Math.min(100, Math.floor((elapsed / this.config.timeout) * 100))

    this.debug.log(`Installation progress: ${percentComplete}% (${Math.floor(remaining / 1000)}s remaining)`)

    // Emit progress event for external consumers
    this.emit('timeout-check', {
      elapsed,
      remaining,
      percentComplete
    })
  }

  /**
   * Updates the current phase and emits progress event
   */
  private updatePhase (phase: InstallationPhase, message: string, error?: Error): void {
    this.currentPhase = phase

    const progress: InstallationProgress = {
      phase,
      message,
      timestamp: new Date(),
      error
    }

    this.phases.push(progress)
    this.debug.log(`Phase: ${phase} - ${message}`)

    // Emit progress event
    this.emit('progress', progress)
  }

  /**
   * Completes the installation successfully
   */
  private completeInstallation (success: boolean): void {
    if (!this.running) {
      return
    }

    this.updatePhase('completed', 'Installation completed successfully')
    this.stop()

    const result: InstallationResult = {
      success,
      isoPath: '', // Will be set by UnattendedInstaller
      duration: this.getElapsedTime(),
      phases: this.phases
    }

    this.emit('complete', result)

    if (this.resolveMonitor) {
      this.resolveMonitor(result)
      this.resolveMonitor = null
      this.rejectMonitor = null
    }
  }

  /**
   * Fails the installation with an error
   */
  private failInstallation (error: Error): void {
    if (!this.running) {
      return
    }

    this.updatePhase('failed', error.message, error)
    this.stop()

    const result: InstallationResult = {
      success: false,
      isoPath: '', // Will be set by UnattendedInstaller
      duration: this.getElapsedTime(),
      phases: this.phases,
      error
    }

    this.emit('error', error)
    this.emit('complete', result)

    if (this.resolveMonitor) {
      // We resolve with a failed result rather than rejecting
      // This allows the caller to handle the failure gracefully
      this.resolveMonitor(result)
      this.resolveMonitor = null
      this.rejectMonitor = null
    }
  }
}
