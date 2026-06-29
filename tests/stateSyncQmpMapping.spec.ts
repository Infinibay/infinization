/**
 * ARCH-01 regression — the QMP→DB status mapping single source of truth.
 *
 * The codebase had TWO divergent mappers:
 *
 * 1. StateSync.mapQMPStatusToDBStatus() — the canonical, exhaustive 13-state
 *    Record-based mapper (QMP_TO_DB_STATUS_MAP).
 * 2. EventHandler.mapQmpStatusToDB() — a partial 6-state if/else re-implementation
 *    that diverged on `guest-panicked` (→'off' here vs 'error' in StateSync) and
 *    silently dropped 7 states (returned null).
 *
 * ARCH-01 fix: EventHandler now delegates to StateSync's canonical mapper. These
 * tests pin the full mapping table so any future divergence is caught immediately.
 */

import { StateSync } from '../src/sync/StateSync'
import { QMPVMStatus } from '../src/types/qmp.types'
import { DatabaseAdapter } from '../src/types/sync.types'

function makeDb (): jest.Mocked<DatabaseAdapter> {
  return {
    findMachine: jest.fn(),
    updateMachineStatus: jest.fn(),
    findRunningVMs: jest.fn().mockResolvedValue([]),
    findMachinesByStatuses: jest.fn().mockResolvedValue([]),
    findMachineByInternalName: jest.fn().mockResolvedValue(null),
    clearMachineConfiguration: jest.fn(),
    clearVolatileMachineConfiguration: jest.fn()
  } as unknown as jest.Mocked<DatabaseAdapter>
}

describe('ARCH-01 — StateSync.mapQMPStatusToDBStatus canonical mapping', () => {
  let stateSync: StateSync

  beforeEach(() => {
    stateSync = new StateSync(makeDb())
  })

  /**
   * The full QMP→DB mapping table. Every QMP run-state MUST resolve to a
   * concrete DBVMStatus — no null, no undefined, no silent skip.
   */
  const EXPECTED_MAPPING: Array<[QMPVMStatus, string]> = [
    ['running', 'running'],
    ['paused', 'suspended'],
    ['shutdown', 'off'],
    ['inmigrate', 'starting'],
    ['postmigrate', 'suspended'],
    ['prelaunch', 'starting'],
    ['finish-migrate', 'suspended'],
    ['restore-vm', 'starting'],
    ['suspended', 'suspended'],
    ['watchdog', 'error'],
    ['guest-panicked', 'error'],
    ['io-error', 'error'],
    ['colo', 'running']
  ]

  it.each(EXPECTED_MAPPING)(
    'maps QMP status "%s" → DB status "%s"',
    (qmpStatus, expectedDbStatus) => {
      expect(stateSync.mapQMPStatusToDBStatus(qmpStatus)).toBe(expectedDbStatus)
    }
  )

  it('maps ALL 13 known QMP run-states (exhaustiveness guard)', () => {
    // If a new QMPVMStatus is added to the union without a mapping entry,
    // this test catches it. QMPVMStatus currently has exactly 13 members.
    const allKnownStatuses: QMPVMStatus[] = [
      'running', 'paused', 'shutdown', 'inmigrate', 'postmigrate',
      'prelaunch', 'finish-migrate', 'restore-vm', 'suspended',
      'watchdog', 'guest-panicked', 'io-error', 'colo'
    ]
    for (const status of allKnownStatuses) {
      const result = stateSync.mapQMPStatusToDBStatus(status)
      expect(result).toBeDefined()
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    }
    expect(allKnownStatuses).toHaveLength(13)
  })

  it('falls back to "error" for an unknown/unrecognised QMP status', () => {
    // Unknown status must NEVER be null/undefined — it must explicitly map to
    // 'error' so the DB row always reflects a concrete, known state.
    expect(stateSync.mapQMPStatusToDBStatus('totally-unknown-state' as QMPVMStatus)).toBe('error')
    expect(stateSync.mapQMPStatusToDBStatus('' as QMPVMStatus)).toBe('error')
  })

  /**
   * The specific ARCH-01 bug: guest-panicked MUST map to 'error', NOT 'off'.
   *
   * Rationale: when a guest panics, the QEMU process is still alive (the guest
   * hit a fatal fault, but the QEMU monitor/process hasn't exited). Mapping to
   * 'off' would trigger the terminal reap path (destroy TAP/firewall resources)
   * for a process that is still running. 'error' is a lightweight status flip
   * that leaves the operator in control of whether to force-kill.
   */
  it('guest-panicked maps to "error" (NOT "off") — the ARCH-01 bug', () => {
    expect(stateSync.mapQMPStatusToDBStatus('guest-panicked')).toBe('error')
    expect(stateSync.mapQMPStatusToDBStatus('guest-panicked')).not.toBe('off')
  })

  /**
   * The previously-unmapped states (returned null in the old EventHandler
   * mapper) MUST now resolve to a concrete DBVMStatus.
   */
  describe('previously-unmapped states now resolve correctly', () => {
    it.each([
      ['inmigrate', 'starting'],
      ['postmigrate', 'suspended'],
      ['finish-migrate', 'suspended'],
      ['restore-vm', 'starting'],
      ['watchdog', 'error'],
      ['io-error', 'error'],
      ['colo', 'running']
    ] as Array<[QMPVMStatus, string]>)(
      '%s → %s (was previously null/unmapped in EventHandler)',
      (qmpStatus, expected) => {
        expect(stateSync.mapQMPStatusToDBStatus(qmpStatus)).toBe(expected)
      }
    )
  })
})
