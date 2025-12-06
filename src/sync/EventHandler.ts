/**
 * EventHandler - Listens to QMP events and updates database automatically
 *
 * This class wraps QMPClient instances, subscribes to VM state change events,
 * and automatically updates the database when events occur.
 */

import { EventEmitter } from 'events'
import { QMPClient } from '../core/QMPClient'
import { QMPEventType, QMPTimestamp } from '../types/qmp.types'
import {
  DatabaseAdapter,
  DBVMStatus,
  EventHandlerConfig,
  VMEventData
} from '../types/sync.types'
import { StateSync } from './StateSync'
import { Debugger } from '../utils/debug'

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
        // Update database
        const result = await this.stateSync.updateStatusDirect(vmId, newStatus)

        if (result.success && this.config.enableLogging) {
          this.debug.log(`VM ${vmId} status updated: ${result.previousStatus} → ${result.newStatus}`)
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
}
