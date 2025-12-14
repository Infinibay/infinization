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
import { Debugger } from '../utils/debug'

/**
 * Default timeout for waiting for QEMU process to exit (30 seconds)
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

  /**
   * Creates a new EventHandler instance
   * @param db Database adapter instance for database operations
   * @param config Optional configuration options
   */
  constructor (db: DatabaseAdapter, config?: Partial<EventHandlerConfig>) {
    super()
    this.stateSync = new StateSync(db)
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.debug = new Debugger('event-handler')
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
        // For shutdown events, get the PID BEFORE updating status to 'off'
        // because findRunningVMs() filters by status='running'
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
          // NOTE: We cannot reliably distinguish "guest clicked PowerOff" from "host sent
          // system_powerdown via QMP" because both go through ACPI and produce identical
          // QMP events with guest=true. The only truly host-initiated path is when we
          // send the 'quit' command directly (reason='host-qmp-quit').
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
   * **Important distinction on shutdown sources:**
   * - `isHostQmpQuit=true`: The SHUTDOWN event resulted from us sending the QMP `quit`
   *   command directly. This is the only case where we initiated termination explicitly.
   * - `isHostQmpQuit=false`: The SHUTDOWN was triggered via ACPI (system_powerdown).
   *   This includes BOTH "guest clicked PowerOff" AND "host sent system_powerdown via QMP"
   *   because QEMU reports both identically (guest=true, reason='guest-shutdown').
   *
   * For ACPI-based shutdowns (isHostQmpQuit=false), QEMU will terminate automatically
   * after the guest OS completes its shutdown sequence. We monitor the process exit
   * but do NOT send `quit` because the socket may already be unavailable.
   *
   * For direct quit (isHostQmpQuit=true), QEMU has already been told to terminate,
   * so we just log confirmation.
   *
   * @param vmId The VM identifier
   * @param isHostQmpQuit Whether the shutdown was triggered by a direct QMP `quit` command
   * @param pid The QEMU process PID (retrieved before status update)
   */
  private async terminateQEMUProcess (vmId: string, isHostQmpQuit: boolean, pid: number | null): Promise<void> {
    const attached = this.attachedVMs.get(vmId)
    if (!attached) {
      this.debug.log(`Cannot terminate QEMU for VM ${vmId}: not attached`)
      return
    }

    if (isHostQmpQuit) {
      // Direct QMP quit - QEMU has already been told to terminate
      this.debug.log('info', `Host QMP quit for VM ${vmId} - QEMU termination already initiated`)
      return
    }

    // ACPI-based shutdown (guest or host system_powerdown) - QEMU will close automatically
    // Do NOT send quit command - the socket may already be unavailable
    this.debug.log('info', `ACPI shutdown for VM ${vmId} - waiting for QEMU to terminate naturally`)

    if (pid) {
      const exited = await this.waitForProcessExit(pid, DEFAULT_PROCESS_EXIT_TIMEOUT)
      if (exited) {
        this.debug.log('info', `QEMU process (PID ${pid}) exited naturally for VM ${vmId}`)
      } else {
        this.debug.log('warn', `QEMU process (PID ${pid}) did not exit within timeout for VM ${vmId}`)
      }
    } else {
      this.debug.log('debug', `No PID available for VM ${vmId}, cannot monitor process exit`)
    }
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
