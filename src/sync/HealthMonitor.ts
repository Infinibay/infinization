/**
 * HealthMonitor - Periodic crash detection and resource cleanup
 *
 * This class periodically checks all VMs marked as 'running' in the database,
 * detects crashed QEMU processes, and cleans up resources.
 */

import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import {
  DatabaseAdapter,
  MachineConfigurationRecord,
  HealthMonitorConfig,
  HealthCheckResult,
  HealthCheckSummary,
  CrashEvent,
  DEFAULT_HEALTH_CHECK_INTERVAL,
  CleanupResourceType,
  CleanupStatus,
  CleanupResourceState,
  CleanupResult,
  CleanupAlertEvent,
  MAX_CLEANUP_RETRIES,
  CLEANUP_RETRY_BASE_DELAY_MS,
  CLEANUP_RETRY_MAX_DELAY_MS
} from '../types/sync.types'
import { TapDeviceManager } from '../network/TapDeviceManager'
import { NftablesService } from '../network/NftablesService'
import { Debugger } from '../utils/debug'
import { DEFAULT_PIDFILE_DIR } from '../types/lifecycle.types'

/**
 * Default configuration for HealthMonitor
 */
const DEFAULT_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: DEFAULT_HEALTH_CHECK_INTERVAL,
  enableCleanup: true
}

/**
 * Type alias for cleanup resource map keys
 */
type CleanupKey = `${CleanupResourceType}:${string}`

/**
 * Creates a typed cleanup key from resource type and identifier
 */
function makeCleanupKey (type: CleanupResourceType, identifier: string): CleanupKey {
  return `${type}:${identifier}`
}

/**
 * CleanupOrchestrator manages transactional cleanup with retry logic.
 *
 * It tracks the state of each cleanup resource through its lifecycle
 * (PENDING → SUCCESS/FAILED) and implements exponential backoff retries
 * for transient failures.
 */
class CleanupOrchestrator {
  private readonly vmId: string
  private resources: Map<CleanupKey, CleanupResourceState> = new Map()
  private debug: Debugger

  constructor (vmId: string, debug: Debugger) {
    this.vmId = vmId
    this.debug = debug
  }

  /**
   * Registers a resource for cleanup tracking
   */
  registerResource (type: CleanupResourceType, identifier: string): void {
    const key = makeCleanupKey(type, identifier)
    this.resources.set(key, {
      type,
      identifier,
      status: CleanupStatus.PENDING,
      attempts: 0
    })
  }

  /**
   * Executes a cleanup operation with retry logic
   */
  async executeCleanup (
    type: CleanupResourceType,
    identifier: string,
    cleanupFn: () => Promise<void>
  ): Promise<void> {
    const key = makeCleanupKey(type, identifier)
    let resource = this.resources.get(key)

    if (!resource) {
      // Auto-register if not already registered
      this.registerResource(type, identifier)
      resource = this.resources.get(key)!
    }

    for (let attempt = 1; attempt <= MAX_CLEANUP_RETRIES; attempt++) {
      resource.attempts = attempt
      resource.status = attempt > 1 ? CleanupStatus.RETRYING : CleanupStatus.PENDING
      resource.lastAttemptAt = new Date()

      try {
        await cleanupFn()
        resource.status = CleanupStatus.SUCCESS
        this.debug.log(`Cleanup succeeded for ${type} (${identifier})`)
        return
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        resource.lastError = errorMsg

        if (attempt < MAX_CLEANUP_RETRIES) {
          const delay = this.calculateBackoff(attempt)
          this.debug.log(`Cleanup failed for ${type}, retrying in ${delay}ms (attempt ${attempt}/${MAX_CLEANUP_RETRIES})`)
          await this.sleep(delay)
        } else {
          resource.status = CleanupStatus.FAILED
          this.debug.log('error', `Cleanup failed for ${type} after ${MAX_CLEANUP_RETRIES} attempts: ${errorMsg}`)
        }
      }
    }
  }

  /**
   * Calculates exponential backoff delay
   */
  private calculateBackoff (attempt: number): number {
    const delay = CLEANUP_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
    return Math.min(delay, CLEANUP_RETRY_MAX_DELAY_MS)
  }

  /**
   * Sleep helper
   */
  private sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Checks if any non-DB resources have failed
   */
  hasNonDbFailures (): boolean {
    return Array.from(this.resources.values()).some(
      r => r.status === CleanupStatus.FAILED && r.type !== CleanupResourceType.DB_CONFIGURATION
    )
  }

  /**
   * Marks a resource as skipped due to upstream failures
   */
  markSkipped (type: CleanupResourceType, identifier: string, reason: string): void {
    const key = makeCleanupKey(type, identifier)
    this.resources.set(key, {
      type,
      identifier,
      status: CleanupStatus.FAILED,
      attempts: 0,
      lastError: reason
    })
  }

  /**
   * Gets the final cleanup result
   */
  getResult (): CleanupResult {
    const resourceArray = Array.from(this.resources.values())
    return {
      vmId: this.vmId,
      totalResources: resourceArray.length,
      successfulCleanups: resourceArray.filter(r => r.status === CleanupStatus.SUCCESS).length,
      failedCleanups: resourceArray.filter(r => r.status === CleanupStatus.FAILED).length,
      resources: resourceArray,
      timestamp: new Date()
    }
  }

  /**
   * Gets all failed resources
   */
  getFailedResources (): CleanupResourceState[] {
    return Array.from(this.resources.values())
      .filter(r => r.status === CleanupStatus.FAILED)
  }
}

/**
 * HealthMonitor periodically checks for crashed QEMU processes and cleans up resources.
 *
 * Features:
 * - Automatic crash detection via process liveness checks
 * - Transactional cleanup with retry logic (exponential backoff)
 * - State tracking for all cleanup operations
 * - Alert emission for persistent failures
 * - Manual cleanup retry capability
 *
 * @example
 * ```typescript
 * const adapter: DatabaseAdapter = { ... }
 * const healthMonitor = new HealthMonitor(adapter, {
 *   checkIntervalMs: 30000,
 *   enableCleanup: true,
 *   onCrashDetected: async (vmId) => {
 *     console.log(`VM ${vmId} crashed, sending notification...`)
 *   },
 *   onCleanupAlert: async (alert) => {
 *     // Send to monitoring system (e.g., PagerDuty, Slack)
 *     await notificationService.send({
 *       severity: alert.severity,
 *       message: `Cleanup failed for VM ${alert.vmId}`,
 *       resources: alert.failedResources
 *     })
 *   }
 * })
 *
 * // Start monitoring
 * await healthMonitor.start()
 *
 * // Listen for crash events with cleanup details
 * healthMonitor.on('crash', (event) => {
 *   console.log(`Crash detected: VM ${event.vmId}`)
 *   if (event.cleanupResult) {
 *     console.log(`Cleanup: ${event.cleanupResult.successfulCleanups}/${event.cleanupResult.totalResources} successful`)
 *   }
 * })
 *
 * // Listen for cleanup alerts
 * healthMonitor.on('cleanup-alert', (alert) => {
 *   console.error(`Cleanup alert for VM ${alert.vmId}:`, alert.failedResources)
 * })
 *
 * // Manual retry if needed
 * const result = await healthMonitor.retryCleanup(vmId, config)
 *
 * // Stop monitoring
 * await healthMonitor.stop()
 * ```
 */
export class HealthMonitor extends EventEmitter {
  private db: DatabaseAdapter
  private config: HealthMonitorConfig
  private intervalHandle: NodeJS.Timeout | null = null
  private isRunning: boolean = false
  private isChecking: boolean = false
  private tapManager: TapDeviceManager
  private nftables: NftablesService
  private debug: Debugger
  private readonly pidfileDir: string

  /**
   * Creates a new HealthMonitor instance
   * @param db Database adapter instance for database operations
   * @param config Optional configuration options
   */
  constructor (db: DatabaseAdapter, config?: Partial<HealthMonitorConfig>) {
    super()
    this.db = db
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.tapManager = new TapDeviceManager()
    this.nftables = new NftablesService()
    this.debug = new Debugger('health-monitor')
    this.pidfileDir = config?.pidfileDir ?? DEFAULT_PIDFILE_DIR
  }

  /**
   * Starts periodic health checks
   */
  public async start (): Promise<void> {
    if (this.isRunning) {
      this.debug.log('Health monitor already running')
      return
    }

    this.debug.log(`Starting health monitor with ${this.config.checkIntervalMs}ms interval`)
    this.isRunning = true

    // Run first check immediately
    await this.runCheck()

    // Schedule periodic checks
    this.intervalHandle = setInterval(async () => {
      await this.runCheck()
    }, this.config.checkIntervalMs)
  }

  /**
   * Stops periodic health checks
   */
  public async stop (): Promise<void> {
    if (!this.isRunning) {
      return
    }

    this.debug.log('Stopping health monitor')
    this.isRunning = false

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  /**
   * Checks if the health monitor is running
   */
  public isMonitoring (): boolean {
    return this.isRunning
  }

  /**
   * Runs a single health check cycle on all running VMs
   * @returns Summary of health check results
   */
  public async checkAllVMs (): Promise<HealthCheckSummary> {
    const timestamp = new Date()
    const results: HealthCheckResult[] = []
    let alive = 0
    let crashed = 0
    let errors = 0

    try {
      // Query all VMs marked as running with their configuration
      const runningVMs = await this.db.findRunningVMs()

      this.debug.log(`Checking ${runningVMs.length} running VMs`)

      for (const vm of runningVMs) {
        const pid = vm.MachineConfiguration?.qemuPid
        const checkResult: HealthCheckResult = {
          vmId: vm.id,
          pid: pid ?? null,
          isAlive: false,
          status: vm.status,
          timestamp
        }

        if (pid === null || pid === undefined) {
          // No PID recorded, can't check
          this.debug.log(`VM ${vm.id} has no PID recorded, skipping`)
          checkResult.isAlive = true // Assume alive if we can't check
          results.push(checkResult)
          alive++
          continue
        }

        try {
          const isAlive = this.isProcessAlive(pid)
          checkResult.isAlive = isAlive

          if (isAlive) {
            alive++
          } else {
            crashed++
            await this.handleCrashedVM(vm.id, pid, vm.MachineConfiguration)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error'
          this.debug.log('error', `Error checking VM ${vm.id}: ${message}`)
          errors++
          checkResult.isAlive = true // Assume alive on error
        }

        results.push(checkResult)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.debug.log('error', `Health check cycle failed: ${message}`)
      this.emit('error', { message, timestamp })
    }

    const summary: HealthCheckSummary = {
      totalChecked: results.length,
      alive,
      crashed,
      errors,
      timestamp,
      results
    }

    if (crashed > 0) {
      this.debug.log(`Health check complete: ${alive} alive, ${crashed} crashed, ${errors} errors`)
    }

    return summary
  }

  /**
   * Checks if a specific VM process is alive
   *
   * @param vmId The VM identifier
   * @param pid The process ID to check
   * @returns True if the process is alive
   */
  public checkVM (vmId: string, pid: number): boolean {
    this.debug.log(`Checking VM ${vmId} with PID ${pid}`)
    return this.isProcessAlive(pid)
  }

  /**
   * Checks if a process is alive using kill -0 and /proc/{pid}/stat
   *
   * This method checks both process existence and zombie status.
   * A process in zombie state (Z) is not truly alive - it has exited
   * but its parent hasn't collected its exit status yet.
   *
   * @param pid The process ID to check
   * @returns True if the process exists and is not a zombie
   */
  private isProcessAlive (pid: number): boolean {
    try {
      // First check: process.kill with signal 0 checks if process exists
      // without actually sending a signal
      process.kill(pid, 0)

      // Second check: verify process is not a zombie by reading /proc/{pid}/stat
      // The third field in /proc/{pid}/stat is the process state:
      // R = running, S = sleeping, D = disk sleep, Z = zombie, T = stopped
      const statPath = `/proc/${pid}/stat`
      if (fs.existsSync(statPath)) {
        try {
          const stat = fs.readFileSync(statPath, 'utf8')
          // Parse the stat file - format: "pid (comm) state ..."
          // We need to handle cases where comm contains spaces or parentheses
          const closeParen = stat.lastIndexOf(')')
          if (closeParen > 0 && stat.length > closeParen + 2) {
            const state = stat.charAt(closeParen + 2)
            if (state === 'Z') {
              this.debug.log('warn', `PID ${pid} is a zombie process - treating as dead`)
              return false
            }
          }
        } catch {
          // If we can't read /proc/{pid}/stat, fall through to assume alive
          this.debug.log('warn', `Could not read /proc/${pid}/stat for zombie check`)
        }
      }

      return true
    } catch (err) {
      const error = err as NodeJS.ErrnoException

      // ESRCH: No such process - the process is definitely dead
      if (error.code === 'ESRCH') {
        return false
      }

      // EPERM: Permission denied - process exists but we can't signal it (still alive)
      if (error.code === 'EPERM') {
        return true
      }

      // For any other unexpected error, log a warning and assume alive
      // to avoid false-positive crash detection
      this.debug.log('error', `Unexpected error checking PID ${pid}: ${error.code} - ${error.message}`)
      return true
    }
  }

  /**
   * Handles a crashed VM by updating status and cleaning up resources
   */
  private async handleCrashedVM (
    vmId: string,
    pid: number,
    config: MachineConfigurationRecord | null
  ): Promise<void> {
    const detectedAt = new Date()
    this.debug.log(`Crash detected for VM ${vmId} (PID ${pid})`)

    let cleanupResult: CleanupResult | null = null

    try {
      // Update database status to 'off'
      await this.db.updateMachineStatus(vmId, 'off')
      this.debug.log(`VM ${vmId} status updated to 'off'`)

      // Cleanup resources if enabled
      if (this.config.enableCleanup && config) {
        cleanupResult = await this.cleanupVMResources(vmId, config)
      }

      // Call custom handler if provided
      if (this.config.onCrashDetected) {
        await this.config.onCrashDetected(vmId)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.debug.log('error', `Failed to handle crashed VM ${vmId}: ${message}`)
    }

    // Emit crash event with cleanup details
    const crashEvent: CrashEvent = {
      vmId,
      pid,
      lastKnownStatus: 'running',
      detectedAt,
      cleanupPerformed: cleanupResult !== null,
      cleanupResult: cleanupResult ?? undefined
    }

    this.emit('crash', crashEvent)
  }

  /**
   * Cleans up resources for a crashed VM with retry logic and state tracking
   *
   * @param vmId The VM identifier
   * @param config The machine configuration with resource identifiers
   * @returns Cleanup result with status of all operations
   */
  private async cleanupVMResources (
    vmId: string,
    config: MachineConfigurationRecord
  ): Promise<CleanupResult> {
    this.debug.log(`Starting transactional cleanup for VM ${vmId}`)

    const orchestrator = new CleanupOrchestrator(vmId, this.debug)

    // TAP device cleanup - detach from bridge but preserve for reuse
    // This enables persistent TAP devices across crash/restart cycles
    if (config.tapDeviceName) {
      await orchestrator.executeCleanup(
        CleanupResourceType.TAP_DEVICE,
        config.tapDeviceName,
        async () => {
          await this.tapManager.detachFromBridge(config.tapDeviceName!)
        }
      )
    }

    // Firewall chain cleanup - detach jump rules but preserve chain and rules
    // Chain persists for reuse when VM restarts
    await orchestrator.executeCleanup(
      CleanupResourceType.FIREWALL_CHAIN,
      vmId,
      async () => {
        await this.nftables.detachJumpRules(vmId)
      }
    )

    // QMP socket cleanup
    if (config.qmpSocketPath) {
      await orchestrator.executeCleanup(
        CleanupResourceType.QMP_SOCKET,
        config.qmpSocketPath,
        async () => {
          if (fs.existsSync(config.qmpSocketPath!)) {
            fs.unlinkSync(config.qmpSocketPath!)
          }
        }
      )
    }

    // Guest agent socket cleanup
    if (config.guestAgentSocketPath) {
      await orchestrator.executeCleanup(
        CleanupResourceType.QMP_SOCKET,
        config.guestAgentSocketPath,
        async () => {
          if (fs.existsSync(config.guestAgentSocketPath!)) {
            fs.unlinkSync(config.guestAgentSocketPath!)
          }
        }
      )
    }

    // InfiniService socket cleanup
    if (config.infiniServiceSocketPath) {
      await orchestrator.executeCleanup(
        CleanupResourceType.QMP_SOCKET,
        config.infiniServiceSocketPath,
        async () => {
          if (fs.existsSync(config.infiniServiceSocketPath!)) {
            fs.unlinkSync(config.infiniServiceSocketPath!)
          }
        }
      )
    }

    // Pidfile cleanup - derive path from qmpSocketPath
    // qmpSocketPath: /path/to/sockets/{internalName}.sock
    // pidfilePath: {pidfileDir}/{internalName}.pid
    if (config.qmpSocketPath) {
      const socketBasename = path.basename(config.qmpSocketPath, '.sock')
      const pidfilePath = path.join(this.pidfileDir, `${socketBasename}.pid`)
      await orchestrator.executeCleanup(
        CleanupResourceType.PIDFILE,
        pidfilePath,
        async () => {
          if (fs.existsSync(pidfilePath)) {
            // Verify the pidfile points to a dead process before deleting
            // This prevents accidentally deleting pidfiles for processes that are still running
            try {
              const pidContent = fs.readFileSync(pidfilePath, 'utf8').trim()
              const pid = parseInt(pidContent, 10)
              if (!isNaN(pid)) {
                // Check if process is still alive
                try {
                  process.kill(pid, 0)
                  // Process is still alive - this shouldn't happen but log warning
                  this.debug.log('warn', `Pidfile ${pidfilePath} points to alive process ${pid} - skipping cleanup`)
                  return
                } catch {
                  // Process is dead, safe to delete pidfile
                }
              }
            } catch {
              // Error reading pidfile - safe to delete
            }
            fs.unlinkSync(pidfilePath)
            this.debug.log(`Deleted orphan pidfile: ${pidfilePath}`)
          }
        }
      )
    }

    // Database configuration cleanup - skip if upstream resources failed
    // This preserves configuration for compensation/manual retry
    if (orchestrator.hasNonDbFailures()) {
      this.debug.log(
        `Skipping DB configuration cleanup for VM ${vmId} due to upstream resource cleanup failures`
      )
      orchestrator.markSkipped(
        CleanupResourceType.DB_CONFIGURATION,
        vmId,
        'Skipped due to upstream resource cleanup failures'
      )
    } else {
      // Clear volatile configuration but preserve tapDeviceName for persistent TAP reuse
      await orchestrator.executeCleanup(
        CleanupResourceType.DB_CONFIGURATION,
        vmId,
        async () => {
          await this.db.clearVolatileMachineConfiguration(vmId)
        }
      )
    }

    const result = orchestrator.getResult()

    // Log summary
    this.debug.log(
      `Cleanup completed for VM ${vmId}: ${result.successfulCleanups}/${result.totalResources} successful, ${result.failedCleanups} failed`
    )

    // Emit alert if there are failures
    if (result.failedCleanups > 0) {
      this.emitCleanupAlert(vmId, orchestrator.getFailedResources())
    }

    return result
  }

  /**
   * Emits a cleanup alert for failed resources
   */
  private emitCleanupAlert (vmId: string, failedResources: CleanupResourceState[]): void {
    const severity = failedResources.length >= 3 ? 'error' : 'warning'

    const alertEvent: CleanupAlertEvent = {
      vmId,
      failedResources,
      timestamp: new Date(),
      severity
    }

    this.debug.log('error',
      `ALERT: Cleanup failures for VM ${vmId}: ${failedResources.map(r => r.type).join(', ')}`
    )

    // Emit event for external monitoring systems
    this.emit('cleanup-alert', alertEvent)

    // Call custom alert handler if provided
    if (this.config.onCleanupAlert) {
      this.config.onCleanupAlert(alertEvent).catch(err => {
        const message = err instanceof Error ? err.message : 'Unknown error'
        this.debug.log('error', `Alert handler failed: ${message}`)
      })
    }
  }

  /**
   * Manually retry cleanup for a VM with failed resources.
   * Useful for operations teams to retry after fixing underlying issues.
   *
   * @param vmId The VM identifier
   * @param config The machine configuration with resource identifiers
   * @returns Cleanup result with updated state
   */
  public async retryCleanup (
    vmId: string,
    config: MachineConfigurationRecord
  ): Promise<CleanupResult> {
    this.debug.log(`Manual cleanup retry requested for VM ${vmId}`)
    return await this.cleanupVMResources(vmId, config)
  }

  /**
   * Runs a single health check cycle with re-entrancy guard
   */
  private async runCheck (): Promise<void> {
    // Prevent overlapping check cycles
    if (this.isChecking) {
      this.debug.log('Health check already in progress, skipping')
      return
    }

    this.isChecking = true
    try {
      await this.checkAllVMs()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.debug.log('error', `Health check failed: ${message}`)
      // Don't stop monitoring on errors
    } finally {
      this.isChecking = false
    }
  }
}
