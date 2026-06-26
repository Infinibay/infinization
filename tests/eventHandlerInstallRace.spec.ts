/**
 * B3 regression — the critic-found unattended-install race.
 *
 * VMLifecycle.create() attaches BOTH the general EventHandler AND the
 * InstallationMonitor to the SAME qmpClient during an unattended install. The
 * InstallationMonitor treats the end-of-install guest SHUTDOWN as "completion"
 * via a minInstallTimeBeforeComplete/resetCount heuristic, but the general
 * EventHandler has no such heuristic and would, on the FIRST SHUTDOWN/POWERDOWN,
 * unconditionally flip the DB row to 'off' and reap QEMU — defeating the install.
 *
 * The fix is a shared "install in progress" guard: while a vmId is marked,
 * EventHandler MUST NOT flip the row to 'off' or reap QEMU on SHUTDOWN/POWERDOWN
 * (it defers to the InstallationMonitor). These tests prove:
 *   1. an install-time SHUTDOWN does NOT flip to 'off' / does NOT reap, while
 *   2. it STILL emits observability events, and
 *   3. once the guard is cleared, terminal handling resumes normally.
 *
 * Also covers the optional facade vmLock (CORE3): when provided, the destructive
 * terminal-shutdown block runs inside vmLock.runExclusive(vmId, ...).
 */

import { EventEmitter } from 'events'
import { EventHandler } from '../src/sync/EventHandler'
import { DatabaseAdapter } from '../src/types/sync.types'
import { TapDeviceManager } from '../src/network/TapDeviceManager'
import { NftablesService } from '../src/network/NftablesService'
import { CgroupsManager } from '../src/system/CgroupsManager'
import { KeyedMutex } from '../src/utils/KeyedMutex'

jest.mock('../src/network/TapDeviceManager')
jest.mock('../src/network/NftablesService')
jest.mock('../src/system/CgroupsManager')

const MockedTapDeviceManager = TapDeviceManager as jest.MockedClass<typeof TapDeviceManager>
const MockedNftablesService = NftablesService as jest.MockedClass<typeof NftablesService>
const MockedCgroupsManager = CgroupsManager as jest.MockedClass<typeof CgroupsManager>

class MockQMPClient extends EventEmitter {
  private _isConnected = true
  // The run-state queryStatus() resolves to. Defaults to running; reconnect tests
  // flip it to a terminal state to drive handleReconnect's terminal-route path.
  public statusResult: { status: string, running: boolean } = { status: 'running', running: true }
  isConnected (): boolean { return this._isConnected }
  isReconnecting (): boolean { return false }
  async queryStatus (): Promise<{ status: string, running: boolean }> {
    return this.statusResult
  }

  async disconnect (): Promise<void> {
    this._isConnected = false
  }
}

const testVmId = 'install-vm-1'
const testTapDevice = 'vnet-install1'
const testQemuPid = 4242

function makeDb (): jest.Mocked<DatabaseAdapter> {
  const db = {
    findMachine: jest.fn().mockResolvedValue({ id: testVmId, status: 'running' }),
    updateMachineStatus: jest.fn().mockResolvedValue(undefined),
    findRunningVMs: jest.fn().mockResolvedValue([
      {
        id: testVmId,
        internalName: testVmId,
        status: 'running',
        MachineConfiguration: {
          qmpSocketPath: '/var/run/qemu/install.sock',
          qemuPid: testQemuPid,
          tapDeviceName: testTapDevice,
          guestAgentSocketPath: null,
          infiniServiceSocketPath: null
        }
      }
    ]),
    findMachinesByStatuses: jest.fn().mockResolvedValue([]),
    findMachineByInternalName: jest.fn().mockResolvedValue(null),
    clearMachineConfiguration: jest.fn().mockResolvedValue(undefined),
    clearVolatileMachineConfiguration: jest.fn().mockResolvedValue(undefined)
  } as unknown as jest.Mocked<DatabaseAdapter>
  return db
}

describe('B3 — EventHandler unattended-install SHUTDOWN guard', () => {
  let eventHandler: EventHandler
  let mockDb: jest.Mocked<DatabaseAdapter>
  let mockQmpClient: MockQMPClient

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb = makeDb()

    // Default cleanup-service mocks so a (mistaken) reap doesn't throw.
    MockedTapDeviceManager.prototype.detachFromBridge = jest.fn().mockResolvedValue(undefined)
    MockedNftablesService.prototype.detachJumpRules = jest.fn().mockResolvedValue(undefined)
    MockedCgroupsManager.prototype.cleanupEmptyScopes = jest.fn().mockResolvedValue(0)

    eventHandler = new EventHandler(mockDb, { enableLogging: false, emitCustomEvents: true })
    mockQmpClient = new MockQMPClient()
  })

  afterEach(async () => {
    await eventHandler.detachAll()
  })

  it('does NOT flip to off or reap QEMU on an install-time SHUTDOWN while install in progress', async () => {
    // Mark BEFORE attach, mirroring VMLifecycle.create() ordering.
    eventHandler.markInstallInProgress(testVmId)
    expect(eventHandler.isInstallInProgress(testVmId)).toBe(true)

    await eventHandler.attachToVM(testVmId, mockQmpClient as any)

    // The end-of-install guest SHUTDOWN arrives.
    mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })
    await new Promise(resolve => setTimeout(resolve, 60))

    // The row must NOT be flipped to 'off' (that would defeat the install)...
    expect(mockDb.updateMachineStatus).not.toHaveBeenCalledWith(testVmId, 'off')
    // ...and NO reap/cleanup must run (the InstallationMonitor owns completion).
    expect(MockedTapDeviceManager.prototype.detachFromBridge).not.toHaveBeenCalled()
    expect(MockedNftablesService.prototype.detachJumpRules).not.toHaveBeenCalled()
    expect(mockDb.clearVolatileMachineConfiguration).not.toHaveBeenCalled()
  })

  it('still emits observability events for an install-time SHUTDOWN', (done) => {
    eventHandler.markInstallInProgress(testVmId)
    eventHandler.attachToVM(testVmId, mockQmpClient as any).then(() => {
      eventHandler.once('vm:shutdown', (data) => {
        expect(data.vmId).toBe(testVmId)
        expect(data.event).toBe('SHUTDOWN')
        // Status is NOT advanced to 'off' under the guard.
        expect(data.newStatus).not.toBe('off')
        done()
      })
      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })
    })
  })

  it('resumes normal terminal handling once the install guard is cleared', async () => {
    eventHandler.markInstallInProgress(testVmId)
    await eventHandler.attachToVM(testVmId, mockQmpClient as any)

    // Install settles (UnattendedInstaller .finally -> clearInstallInProgress).
    eventHandler.clearInstallInProgress(testVmId)
    expect(eventHandler.isInstallInProgress(testVmId)).toBe(false)

    // A subsequent real guest power-off now reaps + flips as usual.
    mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(mockDb.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'off')
    expect(mockDb.clearVolatileMachineConfiguration).toHaveBeenCalledWith(testVmId)
    expect(MockedTapDeviceManager.prototype.detachFromBridge).toHaveBeenCalledWith(testTapDevice)
  })

  it('markInstallInProgress / clearInstallInProgress are idempotent', () => {
    expect(eventHandler.isInstallInProgress(testVmId)).toBe(false)
    eventHandler.markInstallInProgress(testVmId)
    eventHandler.markInstallInProgress(testVmId)
    expect(eventHandler.isInstallInProgress(testVmId)).toBe(true)
    eventHandler.clearInstallInProgress(testVmId)
    eventHandler.clearInstallInProgress(testVmId)
    expect(eventHandler.isInstallInProgress(testVmId)).toBe(false)
  })
})

describe('CORE3 facade vmLock — EventHandler destructive cleanup serialization', () => {
  let mockDb: jest.Mocked<DatabaseAdapter>
  let mockQmpClient: MockQMPClient

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb = makeDb()
    MockedTapDeviceManager.prototype.detachFromBridge = jest.fn().mockResolvedValue(undefined)
    MockedNftablesService.prototype.detachJumpRules = jest.fn().mockResolvedValue(undefined)
    MockedCgroupsManager.prototype.cleanupEmptyScopes = jest.fn().mockResolvedValue(0)
    mockQmpClient = new MockQMPClient()
  })

  it('runs the terminal-shutdown block inside vmLock.runExclusive when a lock is provided', async () => {
    const vmLock = new KeyedMutex()
    const runExclusiveSpy = jest.spyOn(vmLock, 'runExclusive')

    const eventHandler = new EventHandler(mockDb, { enableLogging: false, vmLock })
    await eventHandler.attachToVM(testVmId, mockQmpClient as any)

    mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(runExclusiveSpy).toHaveBeenCalledWith(testVmId, expect.any(Function))
    // The cleanup still happened (under the lock).
    expect(mockDb.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'off')
    await eventHandler.detachAll()
  })

  it('behaves identically (no locking) when no vmLock is provided', async () => {
    const eventHandler = new EventHandler(mockDb, { enableLogging: false })
    await eventHandler.attachToVM(testVmId, mockQmpClient as any)

    mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(mockDb.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'off')
    await eventHandler.detachAll()
  })
})

// LOW fix — a reconnect that re-syncs to a TERMINAL run-state must NOT bare-write
// 'off'. It must route through the SAME terminal-shutdown path a live SHUTDOWN
// uses (reap + cleanupVMResources), under the facade vmLock, and it must respect
// the B3 install-in-progress guard. The pre-fix behavior leaked the VM's
// TAP/firewall and could stomp an in-progress install.
describe('Reconnect re-sync to a terminal state routes through handleTerminalShutdown', () => {
  let eventHandler: EventHandler
  let mockDb: jest.Mocked<DatabaseAdapter>
  let mockQmpClient: MockQMPClient

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb = makeDb()
    MockedTapDeviceManager.prototype.detachFromBridge = jest.fn().mockResolvedValue(undefined)
    MockedNftablesService.prototype.detachJumpRules = jest.fn().mockResolvedValue(undefined)
    MockedCgroupsManager.prototype.cleanupEmptyScopes = jest.fn().mockResolvedValue(0)
    mockQmpClient = new MockQMPClient()
  })

  afterEach(async () => {
    await eventHandler.detachAll()
  })

  it('runs cleanup + flips off (NOT a bare write) when reconnect resolves to a terminal state', async () => {
    eventHandler = new EventHandler(mockDb, { enableLogging: false, emitCustomEvents: true })
    await eventHandler.attachToVM(testVmId, mockQmpClient as any)

    // The VM powered off during the QMP blip.
    mockQmpClient.statusResult = { status: 'shutdown', running: false }

    const reconnected = jest.fn()
    eventHandler.on('vm:reconnect', reconnected)

    mockQmpClient.emit('reconnect')
    await new Promise(resolve => setTimeout(resolve, 80))

    // Routed through handleTerminalShutdown: status flipped to 'off' AND the full
    // resource cleanup ran (TAP detached, firewall jump rules detached, volatile
    // config cleared) — NOT a bare status-only write.
    expect(mockDb.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'off')
    expect(mockDb.clearVolatileMachineConfiguration).toHaveBeenCalledWith(testVmId)
    expect(MockedTapDeviceManager.prototype.detachFromBridge).toHaveBeenCalledWith(testTapDevice)
    expect(MockedNftablesService.prototype.detachJumpRules).toHaveBeenCalledWith(testVmId)
    // The reconnect event still fires for the backend.
    expect(reconnected).toHaveBeenCalledWith({ vmId: testVmId })
  })

  it('routes the terminal shutdown through vmLock.runExclusive when a lock is provided', async () => {
    const vmLock = new KeyedMutex()
    const runExclusiveSpy = jest.spyOn(vmLock, 'runExclusive')

    eventHandler = new EventHandler(mockDb, { enableLogging: false, vmLock })
    await eventHandler.attachToVM(testVmId, mockQmpClient as any)

    mockQmpClient.statusResult = { status: 'guest-panicked', running: false }
    mockQmpClient.emit('reconnect')
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(runExclusiveSpy).toHaveBeenCalledWith(testVmId, expect.any(Function))
    expect(mockDb.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'off')
    expect(MockedTapDeviceManager.prototype.detachFromBridge).toHaveBeenCalledWith(testTapDevice)
  })

  it('does NOT reap/flip off when reconnect resolves to terminal while install in progress', async () => {
    eventHandler = new EventHandler(mockDb, { enableLogging: false, emitCustomEvents: true })
    eventHandler.markInstallInProgress(testVmId)
    await eventHandler.attachToVM(testVmId, mockQmpClient as any)

    // A reconnect during the unattended install resolves to terminal (end-of-
    // install power-off). It must be deferred to InstallationMonitor, NOT reaped.
    mockQmpClient.statusResult = { status: 'shutdown', running: false }

    const reconnected = jest.fn()
    eventHandler.on('vm:reconnect', reconnected)

    mockQmpClient.emit('reconnect')
    await new Promise(resolve => setTimeout(resolve, 80))

    // Install guard suppresses the terminal teardown entirely.
    expect(mockDb.updateMachineStatus).not.toHaveBeenCalledWith(testVmId, 'off')
    expect(mockDb.clearVolatileMachineConfiguration).not.toHaveBeenCalled()
    expect(MockedTapDeviceManager.prototype.detachFromBridge).not.toHaveBeenCalled()
    expect(MockedNftablesService.prototype.detachJumpRules).not.toHaveBeenCalled()
    // The reconnect event still fires.
    expect(reconnected).toHaveBeenCalledWith({ vmId: testVmId })
  })

  it('keeps the lightweight status re-sync for a NON-terminal reconnect state', async () => {
    eventHandler = new EventHandler(mockDb, { enableLogging: false })
    await eventHandler.attachToVM(testVmId, mockQmpClient as any)

    // Live guest is suspended/paused after the blip — non-terminal: a plain
    // status re-sync, no reap/cleanup.
    mockQmpClient.statusResult = { status: 'paused', running: false }
    mockQmpClient.emit('reconnect')
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(mockDb.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'suspended')
    expect(mockDb.updateMachineStatus).not.toHaveBeenCalledWith(testVmId, 'off')
    expect(mockDb.clearVolatileMachineConfiguration).not.toHaveBeenCalled()
    expect(MockedTapDeviceManager.prototype.detachFromBridge).not.toHaveBeenCalled()
  })
})
