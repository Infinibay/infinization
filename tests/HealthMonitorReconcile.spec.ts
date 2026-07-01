// Mock processIdentity so the PID-IDENTITY guards are controllable in unit tests.
// HealthMonitor's NON-destructive crash/reconcile decisions use the TRI-STATE
// pidIdentityState (NOT the fail-closed boolean) so a transient /proc read error
// ('unknown') does not tear down a live VM. By default a PID 'match'es its VM
// (mirrors the happy path), so the existing promotion/crash tests behave as
// before; the recycled-PID tests drive it to 'mismatch', and the regression
// tests drive it to 'unknown'. pidBelongsToVM is still mocked (true) for the
// kill paths' back-compat, though HealthMonitor no longer calls it directly.
jest.mock('../src/utils/processIdentity', () => {
  const actual = jest.requireActual('../src/utils/processIdentity')
  return {
    ...actual,
    pidBelongsToVM: jest.fn().mockReturnValue(true),
    pidIdentityState: jest.fn().mockReturnValue('match')
  }
})

import { HealthMonitor } from '../src/sync/HealthMonitor'
import { DatabaseAdapter, RunningVMRecord } from '../src/types/sync.types'
import { pidBelongsToVM, pidIdentityState } from '../src/utils/processIdentity'

const mockedPidBelongsToVM = pidBelongsToVM as jest.MockedFunction<typeof pidBelongsToVM>
const mockedPidIdentityState = pidIdentityState as jest.MockedFunction<typeof pidIdentityState>

function cfg (qemuPid: number | null): RunningVMRecord['MachineConfiguration'] {
  return {
    qemuPid,
    tapDeviceName: null,
    qmpSocketPath: null,
    guestAgentSocketPath: null,
    infiniServiceSocketPath: null
  }
}

function vm (id: string, status: string, qemuPid: number | null, internalName = `int-${id}`): RunningVMRecord {
  return { id, status, internalName, MachineConfiguration: cfg(qemuPid) } as unknown as RunningVMRecord
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

beforeEach(() => {
  mockedPidBelongsToVM.mockReset().mockReturnValue(true)
  mockedPidIdentityState.mockReset().mockReturnValue('match')
})

describe('HealthMonitor.reconcileTransientStates', () => {
  it("promotes a stale 'starting' VM with a live pid to 'running'", async () => {
    const db = makeDb({
      findMachinesByStatuses: jest.fn().mockResolvedValue([vm('vm1', 'starting', 1234)])
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
      findMachinesByStatuses: jest.fn().mockResolvedValue([vm('vm1', 'starting', 1234)])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(false)

    const s = await m.reconcileTransientStates()
    expect(db.clearVolatileMachineConfiguration).toHaveBeenCalledWith('vm1')
    // The demotion is guarded so it can never clobber a terminal 'error'.
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm1', 'off', { onlyIfNotIn: ['error'] })
    expect(db.clearMachineConfiguration).not.toHaveBeenCalled() // never clears tapDeviceName
    expect(s.resetToOff).toEqual(['vm1'])
  })

  it("parks a stale 'rebuilding' VM (no live pid) in 'error'", async () => {
    const db = makeDb({
      findMachinesByStatuses: jest.fn().mockResolvedValue([vm('vm1', 'rebuilding', null)])
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
        vm('bad', 'starting', 1),
        vm('good', 'starting', 2)
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

  // H7: PID-reuse / host-reboot recovery. The stored qemuPid is alive but the
  // kernel recycled it onto an UNRELATED process — promoting to 'running' would
  // corrupt state permanently. Identity check must veto the promote and fall
  // through to the dead-PID branch.
  it("does NOT promote a 'starting' VM whose live pid is NOT its QEMU (recycled PID -> 'off')", async () => {
    const db = makeDb({
      findMachinesByStatuses: jest.fn().mockResolvedValue([vm('vm1', 'starting', 4242)])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(true) // PID is alive...
    mockedPidIdentityState.mockReturnValue('mismatch')    // ...but DEFINITIVELY not our QEMU

    const s = await m.reconcileTransientStates()

    expect(s.promotedToRunning).toEqual([])
    expect(db.updateMachineStatus).not.toHaveBeenCalledWith('vm1', 'running')
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm1', 'off', { onlyIfNotIn: ['error'] })
    expect(db.clearVolatileMachineConfiguration).toHaveBeenCalledWith('vm1')
    expect(s.resetToOff).toEqual(['vm1'])
    expect(mockedPidIdentityState).toHaveBeenCalledWith(4242, 'int-vm1')
  })

  it("parks a 'rebuilding' VM whose live pid is a recycled foreign PID in 'error'", async () => {
    const db = makeDb({
      findMachinesByStatuses: jest.fn().mockResolvedValue([vm('vm1', 'rebuilding', 4242)])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(true)
    mockedPidIdentityState.mockReturnValue('mismatch')

    const s = await m.reconcileTransientStates()

    expect(s.promotedToRunning).toEqual([])
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm1', 'error')
    expect(s.resetToError).toEqual(['vm1'])
  })

  // LOW regression: a TRANSIENT /proc read failure during reconcile must NOT
  // falsely demote a live VM. The PID is alive but identity is 'unknown' — we
  // neither promote (might be foreign) NOR demote/cleanup (might be a live VM
  // whose /proc read just flaked). The VM is SKIPPED for this cycle; the boolean
  // pidBelongsToVM would have collapsed 'unknown' to false and torn it down.
  it("SKIPS (does not demote/cleanup) a transient-state VM whose live pid identity is 'unknown'", async () => {
    const db = makeDb({
      findMachinesByStatuses: jest.fn().mockResolvedValue([vm('vm1', 'starting', 4242)])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(true) // PID is alive...
    mockedPidIdentityState.mockReturnValue('unknown')     // ...but the /proc read flaked

    const s = await m.reconcileTransientStates()

    // Not promoted, but ALSO not demoted: no terminal write, no volatile clear.
    expect(s.promotedToRunning).toEqual([])
    expect(s.resetToOff).toEqual([])
    expect(s.resetToError).toEqual([])
    expect(s.skipped).toEqual(['vm1'])
    expect(db.updateMachineStatus).not.toHaveBeenCalled()
    expect(db.clearVolatileMachineConfiguration).not.toHaveBeenCalled()
    expect(mockedPidIdentityState).toHaveBeenCalledWith(4242, 'int-vm1')
  })
})

describe('HealthMonitor.checkAllVMs crash detection (H8 PID-reuse)', () => {
  it('treats a VM whose DB pid is alive-but-not-ours as crashed (resets to off)', async () => {
    const db = makeDb({
      findRunningVMs: jest.fn().mockResolvedValue([vm('vm1', 'running', 4242)])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(true) // recycled PID is alive...
    mockedPidIdentityState.mockReturnValue('mismatch')     // ...DEFINITIVELY not our QEMU

    const summary = await m.checkAllVMs()

    expect(summary.alive).toBe(0)
    expect(summary.crashed).toBe(1)
    expect(summary.results[0].isAlive).toBe(false)
    // handleCrashedVM resets the stuck-'running' row to 'off'
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm1', 'off', { onlyIfNotIn: ['error'] })
    expect(mockedPidIdentityState).toHaveBeenCalledWith(4242, 'int-vm1')
  })

  it('keeps a VM alive when its DB pid is alive AND belongs to it', async () => {
    const db = makeDb({
      findRunningVMs: jest.fn().mockResolvedValue([vm('vm1', 'running', 1234)])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(true)
    mockedPidIdentityState.mockReturnValue('match')

    const summary = await m.checkAllVMs()

    expect(summary.alive).toBe(1)
    expect(summary.crashed).toBe(0)
    expect(db.updateMachineStatus).not.toHaveBeenCalled()
  })

  // LOW regression: a TRANSIENT /proc read failure (EMFILE/EACCES under load)
  // makes identity 'unknown'. The process is ALIVE, so the VM must be treated as
  // ALIVE/ours — NOT torn down, NOT flipped to 'off'. The old fail-closed boolean
  // collapsed this transient error to false and false-crashed a live VM.
  it("does NOT tear down a LIVE VM when its pid identity is 'unknown' (transient /proc read error)", async () => {
    const db = makeDb({
      findRunningVMs: jest.fn().mockResolvedValue([vm('vm1', 'running', 1234)])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(true) // process is alive...
    mockedPidIdentityState.mockReturnValue('unknown')     // ...but the /proc read flaked

    const summary = await m.checkAllVMs()

    expect(summary.alive).toBe(1)
    expect(summary.crashed).toBe(0)
    expect(summary.results[0].isAlive).toBe(true)
    // No teardown: status not flipped to 'off', no volatile clear.
    expect(db.updateMachineStatus).not.toHaveBeenCalled()
    expect(db.clearVolatileMachineConfiguration).not.toHaveBeenCalled()
    expect(mockedPidIdentityState).toHaveBeenCalledWith(1234, 'int-vm1')
  })

  it('does not call pidIdentityState when the process is already dead', async () => {
    const db = makeDb({
      findRunningVMs: jest.fn().mockResolvedValue([vm('vm1', 'running', 1234)])
    })
    const m = monitor(db)
    jest.spyOn(m, 'isProcessAlive').mockReturnValue(false)

    const summary = await m.checkAllVMs()

    expect(summary.crashed).toBe(1)
    expect(mockedPidIdentityState).not.toHaveBeenCalled() // short-circuit on dead liveness
    expect(db.updateMachineStatus).toHaveBeenCalledWith('vm1', 'off', { onlyIfNotIn: ['error'] })
  })
})
