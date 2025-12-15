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
   * Gets the QEMU process PID for a VM from the database.
   *
   * This method searches through running VMs to find the PID.
   * Note: This is primarily used during shutdown handling to monitor process exit.
   *
   * @param vmId The VM identifier
   * @returns The PID if found, null otherwise
   */
  public async getVMPid (vmId: string): Promise<number | null> {
    // Search in running VMs to find the PID
    // This includes VMs that may still be in 'running' status during shutdown
    const runningVMs = await this.db.findRunningVMs()
    const vm = runningVMs.find(v => v.id === vmId)
    return vm?.MachineConfiguration?.qemuPid ?? null
  }

  /**
   * Gets VM information needed for resource cleanup.
   *
   * This method retrieves the TAP device name and CPU pinning status
   * which are needed during shutdown cleanup (either host-initiated via
   * VMLifecycle.stop() or guest-initiated via EventHandler).
   *
   * @param vmId The VM identifier
   * @returns Object with tapDeviceName and hasCpuPinning, or null if VM not found
   */
  public async getVMInfo (vmId: string): Promise<{
    tapDeviceName: string | null
    hasCpuPinning: boolean
  } | null> {
    this.debug.log(`getVMInfo: ${vmId}`)

    // Search in running VMs to find the configuration
    // This includes VMs that may still be in 'running' status during shutdown
    const runningVMs = await this.db.findRunningVMs()
    const vm = runningVMs.find(v => v.id === vmId)

    if (!vm) {
      this.debug.log('info', `VM ${vmId} not found in running VMs for info retrieval`)
      return null
    }

    return {
      tapDeviceName: vm.MachineConfiguration?.tapDeviceName ?? null,
      // Note: cpuPinning info is not in the RunningVMRecord type, so we default to false
      // The cleanup is best-effort anyway - orphaned cgroup scopes get cleaned up opportunistically
      hasCpuPinning: false
    }
  }

  /**
   * Clears volatile machine configuration (qmpSocketPath, qemuPid).
   *
   * This method clears only the volatile configuration that changes each time
   * the VM starts. The TAP device name is preserved for persistent TAP device
   * reuse across stop/start cycles.
   *
   * Used during:
   * - Normal VM stop via VMLifecycle.stop()
   * - Guest-initiated shutdown cleanup via EventHandler
   *
   * @param vmId The VM identifier
   * @throws Error if database operation fails
   *
   * @see PrismaAdapter.clearVolatileMachineConfiguration()
   */
  public async clearVolatileMachineConfiguration (vmId: string): Promise<void> {
    this.debug.log(`clearVolatileMachineConfiguration: ${vmId}`)
    await this.db.clearVolatileMachineConfiguration(vmId)
    this.debug.log('info', `Volatile configuration cleared for VM ${vmId}`)
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
