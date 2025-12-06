/**
 * StateSync - Synchronizes VM state between QMP and PostgreSQL
 *
 * This class provides mapping functions and synchronization operations
 * to ensure the database always reflects the actual QEMU VM state.
 */

import { QMPClient } from '../core/QMPClient'
import { QMPVMStatus } from '../types/qmp.types'
import {
  DatabaseAdapter,
  DBVMStatus,
  SyncResult,
  SyncErrorCode,
  isValidQMPStatus
} from '../types/sync.types'
import { Debugger } from '../utils/debug'

/**
 * Mapping from QMP status values to database status values
 */
const QMP_TO_DB_STATUS_MAP: Record<QMPVMStatus, DBVMStatus> = {
  'running': 'running',
  'paused': 'suspended',
  'shutdown': 'off',
  'inmigrate': 'building',
  'postmigrate': 'building',
  'prelaunch': 'building',
  'finish-migrate': 'building',
  'restore-vm': 'building',
  'suspended': 'suspended',
  'watchdog': 'error',
  'guest-panicked': 'error',
  'io-error': 'error',
  'colo': 'running'
}

/**
 * StateSync provides synchronization between QMP protocol and database.
 *
 * @example
 * ```typescript
 * const adapter: DatabaseAdapter = {
 *   findMachine: (id) => prisma.machine.findUnique({ where: { id }, select: { id: true, status: true } }),
 *   updateMachineStatus: (id, status) => prisma.machine.update({ where: { id }, data: { status } }),
 *   findRunningVMs: () => prisma.machine.findMany({ where: { status: 'running' }, ... }),
 *   clearMachineConfiguration: (machineId) => prisma.machineConfiguration.updateMany({ ... })
 * }
 *
 * const stateSync = new StateSync(adapter)
 * const qmpClient = new QMPClient('/var/run/qemu/vm1.sock')
 *
 * await qmpClient.connect()
 * const result = await stateSync.syncState('vm-123', qmpClient)
 * console.log(`Status updated: ${result.previousStatus} → ${result.newStatus}`)
 * ```
 */
export class StateSync {
  private db: DatabaseAdapter
  private debug: Debugger

  /**
   * Creates a new StateSync instance
   * @param db Database adapter instance for database operations
   */
  constructor (db: DatabaseAdapter) {
    this.db = db
    this.debug = new Debugger('state-sync')
  }

  /**
   * Maps a QMP status value to a database status value
   *
   * @param qmpStatus The QMP status to map
   * @returns The corresponding database status
   *
   * @example
   * ```typescript
   * stateSync.mapQMPStatusToDBStatus('running')   // 'running'
   * stateSync.mapQMPStatusToDBStatus('paused')    // 'suspended'
   * stateSync.mapQMPStatusToDBStatus('shutdown')  // 'off'
   * ```
   */
  public mapQMPStatusToDBStatus (qmpStatus: QMPVMStatus): DBVMStatus {
    // Validate the QMP status first
    if (!isValidQMPStatus(qmpStatus)) {
      this.debug.log('error', `Unknown QMP status received: ${qmpStatus}, mapping to 'error'`)
      return 'error'
    }

    const mappedStatus = QMP_TO_DB_STATUS_MAP[qmpStatus]
    if (mappedStatus === undefined) {
      // This shouldn't happen if isValidQMPStatus passed, but handle it explicitly
      this.debug.log('error', `QMP status '${qmpStatus}' not in mapping table, defaulting to 'error'`)
      return 'error'
    }

    return mappedStatus
  }

  /**
   * Synchronizes VM state from QMP to database
   *
   * Queries the current QMP status and updates the database accordingly.
   *
   * @param vmId The VM identifier in the database
   * @param qmpClient Connected QMPClient instance for the VM
   * @returns SyncResult with success status and state transition details
   */
  public async syncState (vmId: string, qmpClient: QMPClient): Promise<SyncResult> {
    const timestamp = new Date()

    this.debug.log(`Syncing state for VM ${vmId}`)

    // Get current DB status
    let previousStatus: string
    try {
      const machine = await this.db.findMachine(vmId)

      if (!machine) {
        this.debug.log('error', `VM ${vmId} not found in database`)
        return {
          success: false,
          vmId,
          previousStatus: 'unknown',
          newStatus: 'unknown',
          timestamp,
          error: SyncErrorCode.VM_NOT_FOUND
        }
      }

      previousStatus = machine.status
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.debug.log('error', `Database error: ${message}`)
      return {
        success: false,
        vmId,
        previousStatus: 'unknown',
        newStatus: 'unknown',
        timestamp,
        error: SyncErrorCode.DB_ERROR
      }
    }

    // Query QMP status
    let qmpStatus: QMPVMStatus
    try {
      if (!qmpClient.isConnected()) {
        this.debug.log('error', `QMP client not connected for VM ${vmId}`)
        return {
          success: false,
          vmId,
          previousStatus,
          newStatus: previousStatus,
          timestamp,
          error: SyncErrorCode.QMP_UNAVAILABLE
        }
      }

      const statusInfo = await qmpClient.queryStatus()
      qmpStatus = statusInfo.status
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.debug.log('error', `QMP query failed: ${message}`)
      return {
        success: false,
        vmId,
        previousStatus,
        newStatus: previousStatus,
        timestamp,
        error: SyncErrorCode.QMP_UNAVAILABLE
      }
    }

    // Map and update
    const newStatus = this.mapQMPStatusToDBStatus(qmpStatus)

    if (newStatus === previousStatus) {
      this.debug.log(`VM ${vmId} status unchanged: ${newStatus}`)
      return {
        success: true,
        vmId,
        previousStatus,
        newStatus,
        timestamp
      }
    }

    // Update database
    try {
      await this.updateVMStatus(vmId, newStatus)
      this.debug.log(`VM ${vmId} status updated: ${previousStatus} → ${newStatus}`)
      return {
        success: true,
        vmId,
        previousStatus,
        newStatus,
        timestamp
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.debug.log('error', `Failed to update status: ${message}`)
      return {
        success: false,
        vmId,
        previousStatus,
        newStatus,
        timestamp,
        error: SyncErrorCode.DB_ERROR
      }
    }
  }

  /**
   * Updates VM status in the database
   *
   * @param vmId The VM identifier
   * @param status The new status to set
   */
  public async updateVMStatus (vmId: string, status: string): Promise<void> {
    this.debug.log(`Updating VM ${vmId} status to ${status}`)
    await this.db.updateMachineStatus(vmId, status)
  }

  /**
   * Gets the current VM status from the database
   *
   * @param vmId The VM identifier
   * @returns The current status string
   * @throws Error if VM not found
   */
  public async getVMStatus (vmId: string): Promise<string> {
    const machine = await this.db.findMachine(vmId)

    if (!machine) {
      throw new Error(`VM ${vmId} not found`)
    }

    return machine.status
  }

  /**
   * Updates VM status directly without QMP query
   *
   * Use this when the new status is already known (e.g., from an event).
   *
   * @param vmId The VM identifier
   * @param newStatus The new status to set
   * @returns SyncResult with success status
   */
  public async updateStatusDirect (vmId: string, newStatus: DBVMStatus): Promise<SyncResult> {
    const timestamp = new Date()

    try {
      const previousStatus = await this.getVMStatus(vmId)

      if (previousStatus === newStatus) {
        return {
          success: true,
          vmId,
          previousStatus,
          newStatus,
          timestamp
        }
      }

      await this.updateVMStatus(vmId, newStatus)

      this.debug.log(`VM ${vmId} status updated: ${previousStatus} → ${newStatus}`)

      return {
        success: true,
        vmId,
        previousStatus,
        newStatus,
        timestamp
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.debug.log('error', `Direct update failed: ${message}`)

      const errorCode = message.includes('not found')
        ? SyncErrorCode.VM_NOT_FOUND
        : SyncErrorCode.DB_ERROR

      return {
        success: false,
        vmId,
        previousStatus: 'unknown',
        newStatus,
        timestamp,
        error: errorCode
      }
    }
  }
}
