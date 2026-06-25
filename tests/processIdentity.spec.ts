import {
  pidBelongsToVM,
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
