/**
 * EventHandler - Listens to QMP events and updates database automatically
 *
 * This class wraps QMPClient instances, subscribes to VM state change events,
 * and automatically updates the database when events occur.
 */

import { EventEmitter } from 'events'
import { QMPClient } from '../core/QMPClient'
import { QMPEventType, QMPTimestamp, QMPShutdownEventData } from '../types/qmp.types'
import {
  DatabaseAdapter,
  DBVMStatus,
  EventHandlerConfig,
  VMEventData
} from '../types/sync.types'
import { StateSync } from './StateSync'
import { TapDeviceManager } from '../network/TapDeviceManager'
import { NftablesService } from '../network/NftablesService'
import { CgroupsManager } from '../system/CgroupsManager'
import { Debugger } from '../utils/debug'

/**
 * Default timeout for waiting for QEMU process to exit (30 seconds).
 *
 * This is a conservative timeout for monitoring guest-initiated shutdowns.
 * Host-initiated shutdowns via VMLifecycle.stop() use a configurable timeout
 * (default 30s, backend typically uses 120s for graceful operations).
 *
 * If this timeout expires during guest-initiated shutdown, it indicates:
 * 1. Guest OS is taking longer than expected to shutdown
 * 2. Guest OS does not support ACPI powerdown
 * 3. QEMU process is hung (requires manual investigation)
 *
 * Note: EventHandler does NOT force-kill on timeout (unlike VMLifecycle.stop()).
 * This is intentional - guest-initiated shutdowns should complete naturally,
 * and if they don't, manual investigation is warranted rather than force-kill.
 */
const DEFAULT_PROCESS_EXIT_TIMEOUT = 30000

/**
 * Interval for polling process status (100ms)
 */
const PROCESS_POLL_INTERVAL = 100

/**
 * Default configuration for EventHandler
 */
const DEFAULT_CONFIG: EventHandlerConfig = {
  enableLogging: true,
  emitCustomEvents: true
}

/**
 * QMP events that trigger state updates
 */
const STATE_CHANGE_EVENTS: QMPEventType[] = [
  'SHUTDOWN',
  'POWERDOWN',
  'RESET',
  'STOP',
  'RESUME',
  'SUSPEND',
  'WAKEUP'
]

/**
 * Mapping from QMP events to database status
 */
const EVENT_TO_STATUS: Partial<Record<QMPEventType, DBVMStatus>> = {
  'SHUTDOWN': 'off',
  'POWERDOWN': 'off',
  'STOP': 'suspended',
  'RESUME': 'running',
  'SUSPEND': 'suspended',
  'WAKEUP': 'running'
}

/**
 * Internal structure for tracking attached VMs
 */
interface AttachedVM {
  qmpClient: QMPClient
  listeners: Map<string, (...args: unknown[]) => void>
}

/**
 * EventHandler automatically updates database when QMP events occur.
 *
 * @example
 * ```typescript
 * const adapter: DatabaseAdapter = { ... }
 * const eventHandler = new EventHandler(adapter)
 * const qmpClient = new QMPClient('/var/run/qemu/vm1.sock')
 *
 * await qmpClient.connect()
 * await eventHandler.attachToVM('vm-123', qmpClient)
 *
 * // Listen for custom events
 * eventHandler.on('vm:shutdown', (data) => {
 *   console.log(`VM ${data.vmId} shut down`)
 * })
 *
 * // Later, cleanup
 * await eventHandler.detachFromVM('vm-123')
 * ```
 */
export class EventHandler extends EventEmitter {
  private stateSync: StateSync
  private config: EventHandlerConfig
  private attachedVMs: Map<string, AttachedVM> = new Map()
  private debug: Debugger

  // Resource cleanup services (created internally like HealthMonitor pattern)
  private readonly tapManager: TapDeviceManager
  private readonly nftables: NftablesService
  private readonly cgroupsManager: CgroupsManager

  /**
   * Creates a new EventHandler instance.
   *
   * EventHandler listens to QMP events and:
   * 1. Updates database status when VM state changes
   * 2. Performs resource cleanup on guest-initiated shutdowns
   *
   * Resource cleanup includes:
   * - Clearing volatile configuration (qmpSocketPath, qemuPid)
   * - Detaching TAP device from bridge (preserved for restart)
   * - Detaching firewall jump rules (chain preserved)
   * - Cleaning up empty cgroup scopes
   *
   * @param db Database adapter instance for database operations
   * @param config Optional configuration options
   */
  constructor (db: DatabaseAdapter, config?: Partial<EventHandlerConfig>) {
    super()
    this.stateSync = new StateSync(db)
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.debug = new Debugger('event-handler')

    // Create service instances for resource cleanup (stateless, safe to create new instances)
    this.tapManager = new TapDeviceManager()
    this.nftables = new NftablesService()
    this.cgroupsManager = new CgroupsManager()
  }

  /**
   * Attaches event listeners to a QMP client for a specific VM
   *
   * @param vmId The VM identifier in the database
   * @param qmpClient Connected QMPClient instance
   */
  public async attachToVM (vmId: string, qmpClient: QMPClient): Promise<void> {
    if (this.attachedVMs.has(vmId)) {
      this.debug.log(`VM ${vmId} already attached, skipping`)
      return
    }

    this.debug.log(`Attaching to VM ${vmId}`)

    const listeners = new Map<string, (...args: unknown[]) => void>()

    // Create listeners for each state change event
    for (const eventType of STATE_CHANGE_EVENTS) {
      const listener = (data: unknown, timestamp: QMPTimestamp) => {
        this.handleEvent(vmId, eventType, data, timestamp)
      }

      listeners.set(eventType, listener as (...args: unknown[]) => void)
      qmpClient.on(eventType, listener)
    }

    // Track the disconnect event
    const disconnectListener = () => {
      this.handleDisconnect(vmId)
    }
    listeners.set('disconnect', disconnectListener)
    qmpClient.on('disconnect', disconnectListener)

    this.attachedVMs.set(vmId, { qmpClient, listeners })

    this.debug.log(`Attached to VM ${vmId}, listening for ${STATE_CHANGE_EVENTS.length} events`)
  }

  /**
   * Detaches event listeners from a VM
   *
   * @param vmId The VM identifier to detach
   */
  public async detachFromVM (vmId: string): Promise<void> {
    const attached = this.attachedVMs.get(vmId)
    if (!attached) {
      this.debug.log(`VM ${vmId} not attached, skipping detach`)
      return
    }

    this.debug.log(`Detaching from VM ${vmId}`)

    this.removeListeners(attached)
    this.attachedVMs.delete(vmId)

    this.debug.log(`Detached from VM ${vmId}`)
  }

  /**
   * Removes all listeners from an attached VM
   */
  private removeListeners (attached: AttachedVM): void {
    for (const [eventType, listener] of attached.listeners) {
      attached.qmpClient.off(eventType, listener)
    }
  }

  /**
   * Detaches from all VMs
   */
  public async detachAll (): Promise<void> {
    this.debug.log('Detaching from all VMs')

    const vmIds = Array.from(this.attachedVMs.keys())
    for (const vmId of vmIds) {
      await this.detachFromVM(vmId)
    }
  }

  /**
   * Gets the list of attached VM IDs
   */
  public getAttachedVMs (): string[] {
    return Array.from(this.attachedVMs.keys())
  }

  /**
   * Checks if a VM is currently attached
   */
  public isAttached (vmId: string): boolean {
    return this.attachedVMs.has(vmId)
  }

  /**
   * Gets the QMP client for an attached VM.
   * Returns undefined if the VM is not attached.
   *
   * @param vmId The VM identifier
   * @returns The QMPClient instance or undefined
   */
  public getQMPClient (vmId: string): QMPClient | undefined {
    return this.attachedVMs.get(vmId)?.qmpClient
  }

  /**
   * Handles a QMP event
   */
  private async handleEvent (
    vmId: string,
    event: QMPEventType,
    data: unknown,
    timestamp: QMPTimestamp
  ): Promise<void> {
    if (this.config.enableLogging) {
      this.debug.log(`Event ${event} received for VM ${vmId}`)
    }

    try {
      // Get current status
      let previousStatus: string
      try {
        previousStatus = await this.stateSync.getVMStatus(vmId)
      } catch {
        previousStatus = 'unknown'
      }

      // Determine new status based on event
      const newStatus = EVENT_TO_STATUS[event]

      if (newStatus) {
        // CRITICAL: Get PID BEFORE updating status to 'off'.
        // Reason: findRunningVMs() filters by status='running', so if we update
        // status first, we won't be able to retrieve the PID for process monitoring.
        // This ensures we can track QEMU termination even after DB status changes.
        let qemuPid: number | null = null
        if (newStatus === 'off' && (event === 'SHUTDOWN' || event === 'POWERDOWN')) {
          qemuPid = await this.stateSync.getVMPid(vmId)
          this.debug.log('debug', `Retrieved PID ${qemuPid} for VM ${vmId} before status update`)
        }

        // Update database
        const result = await this.stateSync.updateStatusDirect(vmId, newStatus)

        if (result.success && this.config.enableLogging) {
          this.debug.log(`VM ${vmId} status updated: ${result.previousStatus} → ${result.newStatus}`)
        }

        // When VM shuts down, handle QEMU process termination
        if (newStatus === 'off' && (event === 'SHUTDOWN' || event === 'POWERDOWN')) {
          // Determine shutdown type from QMP event data.
          // IMPORTANT QEMU LIMITATION: We cannot reliably distinguish between:
          //   1. Guest clicked PowerOff inside VM
          //   2. Host sent system_powerdown via QMP
          // Both produce identical events: {guest: true, reason: 'guest-shutdown'}
          //
          // The ONLY distinguishable case is direct quit command:
          //   - Host sent 'quit' via QMP → {guest: false, reason: 'host-qmp-quit'}
          //
          // For ACPI shutdowns (cases 1 & 2), QEMU will exit automatically after
          // guest completes shutdown. We monitor the process but do NOT send quit.
          const shutdownData = data as QMPShutdownEventData | undefined
          const isHostQmpQuit = shutdownData?.reason === 'host-qmp-quit'

          this.debug.log('info', `Shutdown event - isHostQmpQuit: ${isHostQmpQuit}, reason: ${shutdownData?.reason ?? 'unknown'}`)
          await this.terminateQEMUProcess(vmId, isHostQmpQuit, qemuPid)
        }
      } else if (event === 'RESET') {
        // RESET doesn't change status, just log it
        if (this.config.enableLogging) {
          this.debug.log(`VM ${vmId} reset, status remains running`)
        }
      }

      // Emit custom events for backend integration
      if (this.config.emitCustomEvents) {
        const eventData: VMEventData = {
          vmId,
          event,
          previousStatus,
          newStatus: newStatus ?? previousStatus,
          timestamp: new Date(timestamp.seconds * 1000 + timestamp.microseconds / 1000),
          qmpData: data
        }

        // Emit specific QMP event (e.g., vm:shutdown, vm:stop)
        this.emit(`vm:${event.toLowerCase()}`, eventData)

        // Emit higher-level status events for easier consumption
        if (newStatus === 'off') {
          this.emit('vm:off', eventData)
        } else if (newStatus === 'suspended') {
          this.emit('vm:suspended', eventData)
        } else if (newStatus === 'running') {
          this.emit('vm:running', eventData)
        }

        // Emit generic event
        this.emit('vm:event', eventData)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.debug.log('error', `Failed to handle event ${event} for VM ${vmId}: ${message}`)

      // Emit error event
      this.emit('error', { vmId, event, error: message })
    }
  }

  /**
   * Handles QMP client disconnect
   */
  private handleDisconnect (vmId: string): void {
    this.debug.log(`QMP client disconnected for VM ${vmId}`)

    // Get the attached VM and remove listeners before deleting
    const attached = this.attachedVMs.get(vmId)
    if (attached) {
      this.removeListeners(attached)
      this.attachedVMs.delete(vmId)
    }

    // Emit disconnect event
    this.emit('vm:disconnect', { vmId, timestamp: new Date() })
  }

  /**
   * Handles QEMU process termination after a SHUTDOWN/POWERDOWN event.
   *
   * ## Shutdown Flow Context
   *
   * When a SHUTDOWN event is received, QEMU has initiated termination via ACPI.
   * The complete flow is:
   * 1. ACPI powerdown signal sent to guest (via system_powerdown or guest click)
   * 2. Guest OS runs shutdown scripts, flushes buffers, unmounts filesystems
   * 3. Guest completes shutdown
   * 4. QEMU exits automatically (no -no-shutdown flag configured)
   * 5. This handler monitors exit and cleans up resources
   *
   * ## Important Distinction on Shutdown Sources
   *
   * - `isHostQmpQuit=true`: SHUTDOWN resulted from direct QMP `quit` command.
   *   This is the only case where we explicitly initiated termination.
   * - `isHostQmpQuit=false`: SHUTDOWN was triggered via ACPI (system_powerdown).
   *   This includes BOTH "guest clicked PowerOff" AND "host sent system_powerdown via QMP"
   *   because QEMU reports both identically (guest=true, reason='guest-shutdown').
   *
   * ## Resource Cleanup
   *
   * For guest-initiated shutdowns (or host ACPI shutdowns where VMLifecycle.stop()
   * wasn't called), this handler performs cleanup that VMLifecycle.stop() would
   * normally do:
   * - Clear volatile configuration (qmpSocketPath, qemuPid) - TAP preserved
   * - Detach TAP device from bridge (device preserved for restart)
   * - Detach firewall jump rules (chain and rules preserved)
   * - Clean up empty cgroup scopes (opportunistic)
   *
   * This ensures VM resources are properly released regardless of shutdown source.
   *
   * ## Why quit() is NOT Called
   *
   * After ACPI shutdown, QEMU exits automatically. Calling quit() would be:
   * 1. Redundant - QEMU already terminating
   * 2. Risky - socket may be unavailable (race condition)
   * 3. Data-lossy - quit() is immediate, bypassing guest flush
   *
   * @param vmId The VM identifier
   * @param isHostQmpQuit Whether the shutdown was triggered by a direct QMP `quit` command
   * @param pid The QEMU process PID (retrieved before status update)
   *
   * @see VMLifecycle.stop() for host-initiated shutdown flow
   * @see QMPClient.powerdown() for ACPI shutdown command
   */
  private async terminateQEMUProcess (vmId: string, isHostQmpQuit: boolean, pid: number | null): Promise<void> {
    const attached = this.attachedVMs.get(vmId)
    if (!attached) {
      this.debug.log(`Cannot terminate QEMU for VM ${vmId}: not attached`)
      return
    }

    if (isHostQmpQuit) {
      // Direct QMP quit - QEMU has already been told to terminate
      // No cleanup needed here - the caller (likely VMLifecycle.stop()) handles cleanup
      this.debug.log('info', `Host QMP quit for VM ${vmId} - QEMU termination already initiated by caller`)
      return
    }

    // ACPI-based shutdown (guest or host system_powerdown) - QEMU will close automatically
    // Do NOT send quit command - the socket may already be unavailable
    this.debug.log('info', `ACPI shutdown detected for VM ${vmId} - QEMU will exit automatically (no -no-shutdown flag, no quit command needed)`)

    const startTime = Date.now()

    if (pid) {
      const exited = await this.waitForProcessExit(pid, DEFAULT_PROCESS_EXIT_TIMEOUT)
      const elapsed = Date.now() - startTime
      if (exited) {
        this.debug.log('info', `✓ QEMU process (PID ${pid}) exited cleanly after ACPI shutdown for VM ${vmId} (took ${elapsed}ms)`)
      } else {
        this.debug.log('warn', `⚠ QEMU process (PID ${pid}) did not exit within ${DEFAULT_PROCESS_EXIT_TIMEOUT}ms for VM ${vmId}. This may indicate:
  1. Guest OS is taking longer than expected to shutdown
  2. Guest OS does not support ACPI powerdown
  3. QEMU process is hung (requires manual investigation)`)
        // Note: We do NOT force-kill here. Guest-initiated shutdowns should complete
        // naturally, and hung processes warrant investigation rather than force-kill.
        // VMLifecycle.stop() handles force-kill for host-initiated shutdowns with timeout.
      }
    } else {
      this.debug.log('debug', `No PID available for VM ${vmId}, cannot monitor process exit`)
    }

    // Perform resource cleanup for guest-initiated shutdowns
    // This mirrors the cleanup logic in VMLifecycle.stop() to ensure
    // consistent state regardless of shutdown source (host vs guest)
    await this.cleanupVMResources(vmId)
  }

  /**
   * Cleans up VM resources after shutdown.
   *
   * This method performs the same cleanup as VMLifecycle.stop() to ensure
   * consistent state regardless of whether shutdown was host-initiated
   * (via PowerOff mutation) or guest-initiated (via guest OS shutdown).
   *
   * Cleanup includes:
   * - Clear volatile configuration (qmpSocketPath, qemuPid) - TAP name preserved
   * - Detach TAP device from bridge (device preserved for restart)
   * - Detach firewall jump rules (chain and rules preserved)
   * - Clean up empty cgroup scopes (opportunistic, best-effort)
   *
   * All operations are best-effort with error logging - cleanup failures
   * should not prevent the shutdown from being considered complete.
   *
   * @param vmId The VM identifier
   */
  private async cleanupVMResources (vmId: string): Promise<void> {
    this.debug.log('info', `Cleaning up resources for VM ${vmId} after guest-initiated shutdown`)

    // 1. Get TAP device name before clearing volatile config
    let tapDeviceName: string | null = null
    let hasCpuPinning = false
    try {
      const vmInfo = await this.stateSync.getVMInfo(vmId)
      tapDeviceName = vmInfo?.tapDeviceName ?? null
      hasCpuPinning = vmInfo?.hasCpuPinning ?? false
    } catch (error) {
      this.debug.log('warn', `Failed to retrieve VM info for cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 2. Clear volatile configuration (qmpSocketPath, qemuPid)
    // Note: tapDeviceName is preserved for persistent TAP device reuse on restart
    try {
      await this.stateSync.clearVolatileMachineConfiguration(vmId)
      this.debug.log('info', `Cleared volatile configuration for VM ${vmId}`)
    } catch (error) {
      this.debug.log('warn', `Failed to clear volatile configuration: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 3. Detach TAP device from bridge (persistent - not destroyed)
    // The TAP device persists for reuse when VM restarts
    if (tapDeviceName) {
      try {
        await this.tapManager.detachFromBridge(tapDeviceName)
        this.debug.log('info', `Detached TAP device ${tapDeviceName} from bridge`)
      } catch (error) {
        this.debug.log('warn', `Failed to detach TAP device: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 4. Detach firewall jump rules (chain and rules persist)
    // Only the routing from TAP to chain is removed; firewall rules survive stop/start
    try {
      await this.nftables.detachJumpRules(vmId)
      this.debug.log('info', `Detached firewall jump rules for VM ${vmId}`)
    } catch (error) {
      this.debug.log('warn', `Failed to detach firewall jump rules: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 5. Cleanup empty cgroup scopes if CPU pinning was used (best-effort)
    // Since scopes are named by PID, we do opportunistic cleanup of any empty scopes
    if (hasCpuPinning) {
      try {
        const cleanedCount = await this.cgroupsManager.cleanupEmptyScopes()
        if (cleanedCount > 0) {
          this.debug.log('info', `Cleaned up ${cleanedCount} empty cgroup scope(s)`)
        }
      } catch (error) {
        this.debug.log('warn', `Failed to cleanup cgroup scopes: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    this.debug.log('info', `Completed resource cleanup for VM ${vmId} after guest-initiated shutdown`)
  }

  /**
   * Waits for a process to exit by polling its status.
   *
   * @param pid The process ID to monitor
   * @param timeout Maximum time to wait in milliseconds
   * @returns true if process exited, false if timeout reached
   */
  private async waitForProcessExit (pid: number, timeout: number): Promise<boolean> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      if (!this.isProcessAlive(pid)) {
        return true
      }
      await this.sleep(PROCESS_POLL_INTERVAL)
    }

    return false
  }

  /**
   * Checks if a process is still alive.
   *
   * @param pid The process ID to check
   * @returns true if process is alive, false otherwise
   */
  private isProcessAlive (pid: number): boolean {
    try {
      // Signal 0 doesn't kill the process, just checks if it exists
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Async sleep helper.
   */
  private sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
