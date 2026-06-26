// Verifies that HealthMonitor reclaims leaked cgroup scopes (qemu-<pid>.scope,
// created when a VM is CPU-pinned) during crash cleanup. Before the fix,
// cleanupVMResources cleaned TAP/firewall/sockets/pidfile/DB but never the cgroup
// scope, so a pinned VM leaked a scope on every crash.

// Mock CgroupsManager so we can spy on cleanupEmptyScopes() without touching the
// real cgroupfs. The HealthMonitor instantiates `new CgroupsManager()` internally.
const cleanupEmptyScopesMock = jest.fn().mockResolvedValue(2)
jest.mock('../src/system/CgroupsManager', () => ({
  CgroupsManager: jest.fn().mockImplementation(() => ({
    cleanupEmptyScopes: cleanupEmptyScopesMock
  }))
}))

// Mock TapDeviceManager / NftablesService so cleanup never touches the host.
jest.mock('../src/network/TapDeviceManager', () => ({
  TapDeviceManager: jest.fn().mockImplementation(() => ({
    detachFromBridge: jest.fn().mockResolvedValue(undefined)
  }))
}))
jest.mock('../src/network/NftablesService', () => ({
  NftablesService: jest.fn().mockImplementation(() => ({
    detachJumpRules: jest.fn().mockResolvedValue(undefined)
  }))
}))

import { HealthMonitor } from '../src/sync/HealthMonitor'
import { DatabaseAdapter, RunningVMRecord } from '../src/types/sync.types'

function makeDb (overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
    findMachine: jest.fn(),
    updateMachineStatus: jest.fn().mockResolvedValue(undefined),
    findRunningVMs: jest.fn().mockResolvedValue([]),
    findMachinesByStatuses: jest.fn().mockResolvedValue([]),
    clearMachineConfiguration: jest.fn().mockResolvedValue(undefined),
    clearVolatileMachineConfiguration: jest.fn().mockResolvedValue(undefined),
    findMachineByInternalName: jest.fn(),
    ...overrides
  } as unknown as DatabaseAdapter
}

// A CPU-pinned VM that crashed: its DB pid is dead so checkAllVMs routes it
// through handleCrashedVM -> cleanupVMResources.
function pinnedCrashedVM (): RunningVMRecord {
  return {
    id: 'vm-pinned',
    status: 'running',
    internalName: 'int-vm-pinned',
    MachineConfiguration: {
      qemuPid: 5555,
      tapDeviceName: 'tap-pinned',
      qmpSocketPath: null,
      guestAgentSocketPath: null,
      infiniServiceSocketPath: null
    }
  } as unknown as RunningVMRecord
}

beforeEach(() => {
  cleanupEmptyScopesMock.mockClear()
})

describe('HealthMonitor cgroup scope reclaim on cleanup', () => {
  it('invokes cleanupEmptyScopes() during crash cleanup of a CPU-pinned VM', async () => {
    const db = makeDb({
      findRunningVMs: jest.fn().mockResolvedValue([pinnedCrashedVM()])
    })
    // enableCleanup MUST be true so handleCrashedVM runs cleanupVMResources.
    const m = new HealthMonitor(db, { checkIntervalMs: 999999, enableCleanup: true })
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(false) // dead pid => crash path

    const summary = await m.checkAllVMs()

    expect(summary.crashed).toBe(1)
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm-pinned', 'off')
    // The scope reclaim ran as part of cleanupVMResources.
    expect(cleanupEmptyScopesMock).toHaveBeenCalledTimes(1)
  })

  it('a failing cleanupEmptyScopes() does not fail the rest of the cleanup', async () => {
    cleanupEmptyScopesMock.mockRejectedValueOnce(new Error('cgroupfs unavailable'))
    const db = makeDb({
      findRunningVMs: jest.fn().mockResolvedValue([pinnedCrashedVM()])
    })
    const m = new HealthMonitor(db, { checkIntervalMs: 999999, enableCleanup: true })
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(false)

    const summary = await m.checkAllVMs()

    // Crash still handled; DB still reset despite the scope-reclaim failure.
    expect(summary.crashed).toBe(1)
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm-pinned', 'off')
    expect(cleanupEmptyScopesMock).toHaveBeenCalledTimes(1)
  })
})
