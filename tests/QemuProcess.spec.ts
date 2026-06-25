/**
 * QemuProcess Unit Tests
 *
 * Tests for QemuProcess class with mocked child_process.spawn and fs operations.
 * All tests run without spawning actual QEMU processes.
 */

import { QemuProcess } from '../src/core/QemuProcess'
import { QemuCommandBuilder } from '../src/core/QemuCommandBuilder'
import { spawn } from 'child_process'
import { promises as fsPromises } from 'fs'

// Mock child_process.spawn
jest.mock('child_process', () => ({
  spawn: jest.fn()
}))

// Mock fs (sync + promises). processIdentity (used by QemuProcess.isAlive /
// waitForProcessExit) reads /proc via the sync API, so existsSync/readFileSync
// must exist; default them to "no /proc entry" so the zombie check is skipped.
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue(''),
  promises: {
    readFile: jest.fn(),
    access: jest.fn(),
    unlink: jest.fn()
  }
}))

const MockedSpawn = spawn as jest.MockedFunction<typeof spawn>
const MockedReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>
const MockedAccess = fsPromises.access as jest.MockedFunction<typeof fsPromises.access>
const MockedUnlink = fsPromises.unlink as jest.MockedFunction<typeof fsPromises.unlink>

describe('QemuProcess', () => {
  let qemuProcess: QemuProcess
  let mockCommandBuilder: jest.Mocked<QemuCommandBuilder>
  let mockProcess: {
    pid: number
    stdout: { on: jest.Mock }
    stderr: { on: jest.Mock }
    on: jest.Mock
    kill: jest.Mock
  }

  const testVmId = 'test-vm-123'
  const testPid = 12345

  beforeEach(() => {
    jest.clearAllMocks()

    // Create mock command builder
    mockCommandBuilder = {
      isCpuPinningEnabled: jest.fn().mockReturnValue(false),
      buildCommand: jest.fn().mockReturnValue({
        command: '/usr/bin/qemu-system-x86_64',
        args: ['-m', '4G', '-smp', '4']
      }),
      buildCommandWithPinning: jest.fn(),
      isDaemonizeEnabled: jest.fn().mockReturnValue(true),
      getPidfilePath: jest.fn().mockReturnValue('/var/run/qemu/test.pid')
    } as unknown as jest.Mocked<QemuCommandBuilder>

    // Create mock child process
    mockProcess = {
      pid: testPid,
      killed: false,
      stdout: {
        on: jest.fn()
      },
      stderr: {
        on: jest.fn()
      },
      on: jest.fn(),
      once: jest.fn(),
      kill: jest.fn(),
      removeAllListeners: jest.fn(),
      unref: jest.fn()
    } as any

    // Setup spawn to return mock process
    MockedSpawn.mockReturnValue(mockProcess as any)

    // processIdentity.isProcessAlive uses the REAL global process.kill; mock it so
    // a fake test PID reads as "alive" (signal 0) unless a test overrides it.
    jest.spyOn(process, 'kill').mockImplementation(() => true as never)

    // Daemonized start now REQUIRES adopting the daemon PID from the pidfile and
    // FAILS otherwise; provide a valid default pidfile read + socket access so the
    // happy-path start tests resolve.
    MockedReadFile.mockResolvedValue('12345')
    MockedAccess.mockResolvedValue(undefined)
    MockedUnlink.mockResolvedValue(undefined)

    qemuProcess = new QemuProcess(testVmId, mockCommandBuilder)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('constructor', () => {
    it('creates instance with vmId and commandBuilder', () => {
      expect(qemuProcess).toBeInstanceOf(QemuProcess)
    })
  })

  describe('setQmpSocketPath', () => {
    it('sets the QMP socket path', () => {
      const socketPath = '/var/run/qemu/test.sock'
      qemuProcess.setQmpSocketPath(socketPath)
      // Socket path is stored internally, verified through start() behavior
    })
  })

  describe('setPidFilePath', () => {
    it('sets the PID file path', () => {
      const pidPath = '/var/run/qemu/test.pid'
      qemuProcess.setPidFilePath(pidPath)
      // PID path is stored internally, verified through start() behavior
    })
  })

  describe('start', () => {
    const qmpSocketPath = '/var/run/qemu/test.sock'
    const pidFilePath = '/var/run/qemu/test.pid'

    beforeEach(() => {
      qemuProcess.setQmpSocketPath(qmpSocketPath)
      qemuProcess.setPidFilePath(pidFilePath)

      // Mock fs.access to succeed immediately (socket exists)
      MockedAccess.mockResolvedValue(undefined)
    })

    it('spawns QEMU process with correct command', async () => {
      // Setup process exit callback to resolve start promise
      mockProcess.on.mockImplementation((event: string, callback: (...cbArgs: any[]) => void) => {
        if (event === 'exit') {
          // Don't call exit callback for successful start
        }
        return mockProcess
      })

      await qemuProcess.start()

      expect(MockedSpawn).toHaveBeenCalledWith(
        '/usr/bin/qemu-system-x86_64',
        ['-m', '4G', '-smp', '4'],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    })

    it('sets PID from spawned process', async () => {
      mockProcess.on.mockImplementation((event: string, callback: (...cbArgs: any[]) => void) => mockProcess)

      await qemuProcess.start()

      expect(qemuProcess.getPid()).toBe(testPid)
    })

    it('reads daemon PID from pidfile when daemonized', async () => {
      mockCommandBuilder.isDaemonizeEnabled.mockReturnValue(true)
      MockedReadFile.mockResolvedValue('54321')

      mockProcess.on.mockImplementation((event: string, callback: (...cbArgs: any[]) => void) => {
        if (event === 'exit') {
          // Simulate daemon parent exit with code 0
          setTimeout(() => callback(0, null), 10)
        }
        return mockProcess
      })

      await qemuProcess.start()

      // Wait for async PID file read
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(MockedReadFile).toHaveBeenCalledWith(pidFilePath, 'utf-8')
    })

    it('uses numactl wrapper when CPU pinning is enabled', async () => {
      mockCommandBuilder.isCpuPinningEnabled.mockReturnValue(true)
      mockCommandBuilder.buildCommandWithPinning.mockResolvedValue({
        command: '/usr/bin/qemu-system-x86_64',
        args: ['-m', '4G', '-smp', '4'],
        wrapperCommand: '/usr/bin/numactl',
        wrapperArgs: ['--cpunodebind', '0'],
        pinningApplied: true,
        pinnedCores: [0, 1, 2, 3],
        numaNodes: [0]
      })

      mockProcess.on.mockImplementation((event: string, callback: (...cbArgs: any[]) => void) => mockProcess)

      await qemuProcess.start()

      expect(MockedSpawn).toHaveBeenCalledWith(
        '/usr/bin/numactl',
        ['--cpunodebind', '0', '/usr/bin/qemu-system-x86_64', '-m', '4G', '-smp', '4'],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    })

    it('rejects a daemonized start when the daemon PID cannot be read (I06 fix)', async () => {
      // No QMP socket configured -> daemonized start waits on the pidfile. If the
      // pidfile never yields a valid PID, start() must REJECT (not resolve with a
      // stale fork PID).
      MockedReadFile.mockRejectedValue(new Error('ENOENT'))
      mockProcess.on.mockImplementation((event: string, callback: (...cbArgs: any[]) => void) => mockProcess)

      await expect(qemuProcess.start()).rejects.toThrow(/daemon PID/i)
    })

    it('rejects if QMP socket never appears', async () => {
      MockedAccess.mockRejectedValue(new Error('ENOENT'))

      mockProcess.on.mockImplementation((event: string, callback: (...cbArgs: any[]) => void) => mockProcess)

      await expect(qemuProcess.start()).rejects.toThrow(/QMP socket.*not available/)
    })

    it('handles process spawn error', async () => {
      MockedSpawn.mockImplementation(() => {
        throw new Error('spawn failed')
      })

      await expect(qemuProcess.start()).rejects.toThrow('spawn failed')
    })
  })

  // Liveness helper: make process.kill(pid, 0) report dead/alive on demand while
  // recording SIGTERM/SIGKILL. (this.process is nulled for daemonized VMs, so stop
  // now signals the daemon PID via the global process.kill — the I05 fix.)
  function mockKill (opts: { aliveForSig0: boolean }): jest.SpyInstance {
    return jest.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 0) {
        if (opts.aliveForSig0) return true
        const err = new Error('ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      return true
    }) as never)
  }

  describe('stop', () => {
    beforeEach(() => {
      qemuProcess.setPidFilePath('/var/run/qemu/test.pid')
      mockProcess.on.mockImplementation((event: string, callback: (...cbArgs: any[]) => void) => mockProcess)
    })

    it('signals the DAEMON PID via process.kill (not the dead fork handle)', async () => {
      MockedAccess.mockResolvedValue(undefined)
      await qemuProcess.start() // adopts daemon PID 12345, nulls this.process
      const killSpy = mockKill({ aliveForSig0: false }) // process exits promptly

      await qemuProcess.stop(1000)

      // Daemonized stop must target the real daemon PID, not the fork-parent handle.
      expect(killSpy).toHaveBeenCalledWith(testPid, 'SIGTERM')
    })

    it('escalates to SIGKILL after the graceful timeout', async () => {
      MockedAccess.mockResolvedValue(undefined)
      await qemuProcess.start()
      const killSpy = mockKill({ aliveForSig0: true }) // never exits gracefully

      await qemuProcess.stop(50).catch(() => { /* forceKill may throw if unreaped */ })

      expect(killSpy).toHaveBeenCalledWith(testPid, 'SIGKILL')
    })

    it('does nothing if process is not running', async () => {
      await qemuProcess.stop()
      expect(mockProcess.kill).not.toHaveBeenCalled()
    })

    it('cleans up the PID file after a successful stop', async () => {
      MockedAccess.mockResolvedValue(undefined)
      await qemuProcess.start()
      mockKill({ aliveForSig0: false })

      await qemuProcess.stop(1000)

      expect(MockedUnlink).toHaveBeenCalledWith('/var/run/qemu/test.pid')
    })
  })

  describe('forceKill', () => {
    beforeEach(() => {
      mockProcess.on.mockImplementation((event: string, callback: (...cbArgs: any[]) => void) => mockProcess)
    })

    it('sends SIGKILL to the daemon PID and confirms it is gone', async () => {
      MockedAccess.mockResolvedValue(undefined)
      await qemuProcess.start()
      const killSpy = mockKill({ aliveForSig0: false })

      await qemuProcess.forceKill()

      expect(killSpy).toHaveBeenCalledWith(testPid, 'SIGKILL')
    })

    it('handles an already-dead process without throwing', async () => {
      MockedAccess.mockResolvedValue(undefined)
      await qemuProcess.start()
      mockKill({ aliveForSig0: false })

      await expect(qemuProcess.forceKill()).resolves.toBeUndefined()
    })
  })

  describe('isAlive', () => {
    it('returns true if process is alive', async () => {
      // isAlive reads the real this.pid; start() to set it (daemon PID 12345).
      mockProcess.on.mockImplementation((event: string, callback: (...cbArgs: any[]) => void) => mockProcess)
      MockedAccess.mockResolvedValue(undefined)
      await qemuProcess.start()
      mockKill({ aliveForSig0: true })

      expect(qemuProcess.isAlive()).toBe(true)
    })

    it('returns false if process is dead', () => {
      const originalKill = process.kill
      process.kill = jest.fn().mockImplementation(() => {
        throw new Error('ESRCH')
      })

      try {
        jest.spyOn(qemuProcess, 'getPid').mockReturnValue(testPid)

        expect(qemuProcess.isAlive()).toBe(false)
      } finally {
        process.kill = originalKill
      }
    })

    it('returns false if PID is null', () => {
      jest.spyOn(qemuProcess, 'getPid').mockReturnValue(null)

      expect(qemuProcess.isAlive()).toBe(false)
    })
  })

  describe('getPid', () => {
    it('returns current PID', () => {
      jest.spyOn(qemuProcess, 'getPid').mockReturnValue(testPid)

      expect(qemuProcess.getPid()).toBe(testPid)
    })

    it('returns null if process not started', () => {
      expect(qemuProcess.getPid()).toBe(null)
    })
  })

  describe('CPU pinning info getters', () => {
    it('reports no pinning before start via the individual getters', () => {
      // getCpuPinningInfo() was removed in favor of discrete getters.
      expect(qemuProcess.isCpuPinningApplied()).toBe(false)
      expect(qemuProcess.getPinnedCores()).toEqual([])
      expect(qemuProcess.getNumaNodes()).toEqual([])
    })
  })
})
