import {
  pidBelongsToVM,
  pidIdentityState,
  isProcessAlive,
  waitForProcessExit,
  forceKillProcess
} from '../src/utils/processIdentity'

const isLinux = process.platform === 'linux'
const DEAD_PID = 2_000_000_000

describe('processIdentity', () => {
  const realPlatform = process.platform

  afterEach(() => {
    jest.restoreAllMocks()
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  describe('pidBelongsToVM', () => {
    it('returns true on non-linux (cannot verify /proc)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(pidBelongsToVM(1234, 'vm-internal')).toBe(true)
    })

    it('returns false for an empty token (fail-closed)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      expect(pidBelongsToVM(1234, '')).toBe(false)
    })

    // The current test runner is a node process, NOT qemu-system — so even though
    // the PID is alive and the token matches, the qemu-system guard must reject it.
    ;(isLinux ? it : it.skip)('rejects a live NON-qemu process (qemu-system guard)', () => {
      expect(pidBelongsToVM(process.pid, 'node')).toBe(false)
    })

    ;(isLinux ? it : it.skip)('returns false when /proc entry is gone (already exited)', () => {
      expect(pidBelongsToVM(DEAD_PID, 'vm-internal')).toBe(false)
    })
  })

  describe('pidIdentityState (tri-state, non-destructive)', () => {
    it("returns 'unknown' on non-linux (cannot read /proc)", () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(pidIdentityState(1234, 'vm-internal')).toBe('unknown')
    })

    it("returns 'unknown' for an empty token (cannot verify)", () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      expect(pidIdentityState(1234, '')).toBe('unknown')
    })

    // The runner is a node process, NOT qemu-system: a readable cmdline that is a
    // DIFFERENT process must be 'mismatch' (definitive), not 'unknown'.
    ;(isLinux ? it : it.skip)("returns 'mismatch' for a live NON-qemu process", () => {
      expect(pidIdentityState(process.pid, 'node')).toBe('mismatch')
    })

    // A gone process (ENOENT) is a LIVENESS fact, not identity: report 'unknown'
    // here and let isProcessAlive own "gone" so the liveness branch reaps it.
    ;(isLinux ? it : it.skip)("returns 'unknown' (not mismatch) when /proc entry is gone", () => {
      expect(pidIdentityState(DEAD_PID, 'vm-internal')).toBe('unknown')
    })

    // A TRANSIENT, non-definitive read error (here EACCES) must be 'unknown' so a
    // caller does NOT tear down a live VM on a flaky read.
    ;(isLinux ? it : it.skip)("returns 'unknown' on a transient (non-ENOENT) /proc read error", () => {
      const fs = require('fs') as typeof import('fs')
      jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        const err = new Error('permission denied') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      })
      expect(pidIdentityState(process.pid, 'vm-internal')).toBe('unknown')
    })

    // A readable cmdline that contains qemu-system AND the token is a 'match'.
    ;(isLinux ? it : it.skip)("returns 'match' for a readable qemu-system cmdline containing the token", () => {
      const fs = require('fs') as typeof import('fs')
      jest.spyOn(fs, 'readFileSync').mockReturnValue(
        Buffer.from('qemu-system-x86_64\0-name\0my-vm-token\0', 'utf8')
      )
      expect(pidIdentityState(1234, 'my-vm-token')).toBe('match')
    })
  })

  describe('isProcessAlive', () => {
    it('returns false for a definitely-dead pid', () => {
      expect(isProcessAlive(DEAD_PID)).toBe(false)
    })

    it('returns true for the current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true)
    })
  })

  describe('forceKillProcess', () => {
    // On linux the current process is alive but is not qemu-system, so identity
    // verification fails and NO destructive signal must be sent (PID-reuse guard).
    ;(isLinux ? it : it.skip)('SKIPS the kill (no signal) when identity cannot be verified', async () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as never)

      const result = await forceKillProcess(process.pid, 'definitely-not-in-this-cmdline-xyz')

      expect(result.skipped).toBe(true)
      expect(result.signalled).toBe(false)
      const destructive = killSpy.mock.calls.filter(([, sig]) => sig === 'SIGTERM' || sig === 'SIGKILL')
      expect(destructive).toHaveLength(0)
    })

    it('reports a dead pid as gone (ESRCH) without throwing', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' }) // skip /proc identity on non-linux
      const result = await forceKillProcess(DEAD_PID, 'x')
      expect(result.confirmedGone).toBe(true)
    })
  })

  describe('waitForProcessExit', () => {
    it('resolves true immediately for a dead pid', async () => {
      await expect(waitForProcessExit(DEAD_PID, 500)).resolves.toBe(true)
    })
  })
})
