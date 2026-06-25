import { HealthMonitor } from '../src/sync/HealthMonitor'
import { DatabaseAdapter, RunningVMRecord } from '../src/types/sync.types'

function cfg (qemuPid: number | null): RunningVMRecord['MachineConfiguration'] {
  return {
    qemuPid,
    tapDeviceName: null,
    qmpSocketPath: null,
    guestAgentSocketPath: null,
    infiniServiceSocketPath: null
  }
}

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

function monitor (db: DatabaseAdapter): HealthMonitor {
  // enableCleanup:false so the reconciler never touches TAP/nftables in unit tests.
  return new HealthMonitor(db, { checkIntervalMs: 999999, enableCleanup: false })
}

describe('HealthMonitor.reconcileTransientStates', () => {
  it("promotes a stale 'starting' VM with a live pid to 'running'", async () => {
    const db = makeDb({
      findMachinesByStatuses: jest.fn().mockResolvedValue([{ id: 'vm1', status: 'starting', MachineConfiguration: cfg(1234) }])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(true)

    const s = await m.reconcileTransientStates()
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm1', 'running')
    expect(s.promotedToRunning).toEqual(['vm1'])
    expect(db.clearVolatileMachineConfiguration).not.toHaveBeenCalled()
  })

  it("resets a stale 'starting' VM with no live pid to 'off' (TAP preserved)", async () => {
    const db = makeDb({
      findMachinesByStatuses: jest.fn().mockResolvedValue([{ id: 'vm1', status: 'starting', MachineConfiguration: cfg(1234) }])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(false)

    const s = await m.reconcileTransientStates()
    expect(db.clearVolatileMachineConfiguration).toHaveBeenCalledWith('vm1')
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm1', 'off')
    expect(db.clearMachineConfiguration).not.toHaveBeenCalled() // never clears tapDeviceName
    expect(s.resetToOff).toEqual(['vm1'])
  })

  it("parks a stale 'rebuilding' VM (no live pid) in 'error'", async () => {
    const db = makeDb({
      findMachinesByStatuses: jest.fn().mockResolvedValue([{ id: 'vm1', status: 'rebuilding', MachineConfiguration: cfg(null) }])
    })
    const m = monitor(db)

    const s = await m.reconcileTransientStates()
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm1', 'error')
    expect(s.resetToError).toEqual(['vm1'])
  })

  it('no transient VMs -> no writes', async () => {
    const db = makeDb()
    const m = monitor(db)
    const s = await m.reconcileTransientStates()
    expect(s.totalChecked).toBe(0)
    expect(db.updateMachineStatus).not.toHaveBeenCalled()
  })

  it('a per-VM failure is recorded as skipped; other VMs still processed', async () => {
    const db = makeDb({
      findMachinesByStatuses: jest.fn().mockResolvedValue([
        { id: 'bad', status: 'starting', MachineConfiguration: cfg(1) },
        { id: 'good', status: 'starting', MachineConfiguration: cfg(2) }
      ]),
      updateMachineStatus: jest.fn().mockImplementation((id: string) =>
        id === 'bad' ? Promise.reject(new Error('db down')) : Promise.resolve()
      )
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(true)

    const s = await m.reconcileTransientStates()
    expect(s.skipped).toEqual(['bad'])
    expect(s.promotedToRunning).toEqual(['good'])
  })
})
