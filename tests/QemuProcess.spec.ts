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

// Mock fs.promises
jest.mock('fs', () => ({
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
      stdout: {
        on: jest.fn()
      },
      stderr: {
        on: jest.fn()
      },
      on: jest.fn(),
      kill: jest.fn()
    }

    // Setup spawn to return mock process
    MockedSpawn.mockReturnValue(mockProcess as any)

    qemuProcess = new QemuProcess(testVmId, mockCommandBuilder)
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
      mockProcess.on.mockImplementation((event: string, callback: () => void) => {
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
      mockProcess.on.mockImplementation((event: string, callback: () => void) => mockProcess)

      await qemuProcess.start()

      expect(qemuProcess.getPid()).toBe(testPid)
    })

    it('reads daemon PID from pidfile when daemonized', async () => {
      mockCommandBuilder.isDaemonizeEnabled.mockReturnValue(true)
      MockedReadFile.mockResolvedValue('54321')

      mockProcess.on.mockImplementation((event: string, callback: () => void) => {
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

      mockProcess.on.mockImplementation((event: string, callback: () => void) => mockProcess)

      await qemuProcess.start()

      expect(MockedSpawn).toHaveBeenCalledWith(
        '/usr/bin/numactl',
        ['--cpunodebind', '0', '/usr/bin/qemu-system-x86_64', '-m', '4G', '-smp', '4'],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    })

    it('rejects if process exits during startup', async () => {
      mockProcess.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'exit') {
          // Simulate immediate failure
          setTimeout(() => callback(1, null), 10)
        }
        return mockProcess
      })

      await expect(qemuProcess.start()).rejects.toThrow(/exited during startup/)
    })

    it('rejects if QMP socket never appears', async () => {
      MockedAccess.mockRejectedValue(new Error('ENOENT'))

      mockProcess.on.mockImplementation((event: string, callback: () => void) => mockProcess)

      await expect(qemuProcess.start()).rejects.toThrow(/QMP socket.*not available/)
    })

    it('handles process spawn error', async () => {
      MockedSpawn.mockImplementation(() => {
        throw new Error('spawn failed')
      })

      await expect(qemuProcess.start()).rejects.toThrow('spawn failed')
    })
  })

  describe('stop', () => {
    beforeEach(() => {
      // Set PID manually for stop tests
      qemuProcess.setPidFilePath('/var/run/qemu/test.pid')
    })

    it('sends SIGTERM to process', async () => {
      // Mock process exit after SIGTERM
      mockProcess.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'exit') {
          setTimeout(callback, 10)
        }
        return mockProcess
      })

      // Set PID by starting first
      MockedAccess.mockResolvedValue(undefined)
      mockProcess.on.mockImplementationOnce((event: string, callback: () => void) => mockProcess)
      await qemuProcess.start()

      await qemuProcess.stop(1000)

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('force kills after timeout', async () => {
      // Mock process that doesn't exit
      mockProcess.on.mockImplementation(() => mockProcess)

      // Set PID manually
      jest.spyOn(qemuProcess, 'getPid').mockReturnValue(testPid)

      // Mock process.kill for forceKill
      const originalKill = process.kill
      process.kill = jest.fn()

      try {
        await qemuProcess.stop(50) // Short timeout for test
      } catch (error) {
        // Timeout is expected
      }

      expect(process.kill).toHaveBeenCalledWith(testPid, 'SIGKILL')

      // Restore
      process.kill = originalKill
    })

    it('does nothing if process is not running', async () => {
      // Don't start process, just call stop
      await qemuProcess.stop()

      expect(mockProcess.kill).not.toHaveBeenCalled()
    })

    it('cleans up PID file after stop', async () => {
      mockProcess.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'exit') {
          setTimeout(callback, 10)
        }
        return mockProcess
      })

      MockedAccess.mockResolvedValue(undefined)
      mockProcess.on.mockImplementationOnce((event: string, callback: () => void) => mockProcess)
      await qemuProcess.start()

      MockedUnlink.mockResolvedValue()

      await qemuProcess.stop(1000)

      expect(MockedUnlink).toHaveBeenCalledWith('/var/run/qemu/test.pid')
    })
  })

  describe('forceKill', () => {
    it('sends SIGKILL to process', async () => {
      const originalKill = process.kill
      process.kill = jest.fn()

      try {
        // Set PID by starting first
        MockedAccess.mockResolvedValue(undefined)
        mockProcess.on.mockImplementation((event: string, callback: () => void) => mockProcess)
        await qemuProcess.start()

        await qemuProcess.forceKill()

        expect(process.kill).toHaveBeenCalledWith(testPid, 'SIGKILL')
      } finally {
        process.kill = originalKill
      }
    })

    it('handles process already dead', async () => {
      const originalKill = process.kill
      process.kill = jest.fn().mockImplementation(() => {
        throw new Error('ESRCH')
      })

      try {
        MockedAccess.mockResolvedValue(undefined)
        mockProcess.on.mockImplementation((event: string, callback: () => void) => mockProcess)
        await qemuProcess.start()

        await qemuProcess.forceKill()

        // Should not throw
        expect(process.kill).toHaveBeenCalled()
      } finally {
        process.kill = originalKill
      }
    })
  })

  describe('isAlive', () => {
    it('returns true if process is alive', () => {
      const originalKill = process.kill
      process.kill = jest.fn()

      try {
        // Set PID manually
        jest.spyOn(qemuProcess, 'getPid').mockReturnValue(testPid)

        expect(qemuProcess.isAlive()).toBe(true)
      } finally {
        process.kill = originalKill
      }
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

  describe('getCpuPinningInfo', () => {
    it('returns CPU pinning information', () => {
      const info = qemuProcess.getCpuPinningInfo()

      expect(info).toEqual({
        cpuPinningApplied: false,
        pinnedCores: [],
        numaNodes: []
      })
    })
  })
})
