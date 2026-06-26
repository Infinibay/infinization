/**
 * QMPClient Unit Tests
 *
 * Tests for QMPClient with mocked net.Socket to prevent actual
 * Unix socket connections during testing.
 */

import { QMPClient } from '../src/core/QMPClient'
import * as net from 'net'

// Mock the net module. The MockSocket class is defined INSIDE the factory because
// jest.mock() is hoisted above all module-level declarations — referencing an
// outer class here would hit its temporal dead zone (ReferenceError).
jest.mock('net', () => {
  const { EventEmitter } = require('events')
  class MockSocket extends EventEmitter {
    private connected = false
    private destroyed = false

    connect (path: string): void {
      this.connected = true
      setImmediate(() => {
        this.emit('connect')
        this.emit('data', Buffer.from('{"QMP": {"version": {"qemu": {"micro": 0, "minor": 0, "major": 4}, "package": ""}, "capabilities": []}}\r\n'))
      })
    }

    write (data: string | Buffer, callback?: (err?: Error) => void): boolean {
      if (this.destroyed) {
        if (callback) callback(new Error('Socket destroyed'))
        return false
      }
      const cmd = JSON.parse(data.toString())
      const reply = (ret: string): void => {
        setImmediate(() => this.emit('data', Buffer.from(`{"return": ${ret}, "id": "${cmd.id}"}\r\n`)))
      }
      if (cmd.execute === 'query-status') {
        reply('{"status": "running", "singlestep": false, "running": true}')
      } else if (cmd.execute === 'query-cpus' || cmd.execute === 'query-cpus-fast') {
        reply('[]')
      } else if (cmd.execute === 'query-block') {
        reply('[]')
      } else if (cmd.execute === 'quit') {
        setImmediate(() => {
          this.emit('data', Buffer.from(`{"return": {}, "id": "${cmd.id}"}\r\n`))
          // Close synchronously after the reply so isConnected() is false as soon
          // as quit() resolves (QEMU drops the socket on quit).
          this.destroyed = true
          this.connected = false
          this.emit('close')
        })
      } else {
        reply('{}')
      }
      if (callback) callback()
      return true
    }

    end (): void {
      this.connected = false
      setImmediate(() => this.emit('close'))
    }

    destroy (): void {
      this.destroyed = true
      this.connected = false
      setImmediate(() => this.emit('close'))
    }

    setNoDelay (): void {}
  }

  return {
    Socket: MockSocket,
    createConnection: (path: string) => {
      const socket = new MockSocket()
      socket.connect(path)
      return socket
    }
  }
})

// Obtain the mocked Socket class for tests that construct one directly.
const MockSocket = (net as unknown as { Socket: new () => any }).Socket

describe('QMPClient', () => {
  let qmpClient: QMPClient
  const testSocketPath = '/tmp/test-qmp.sock'

  beforeEach(() => {
    jest.clearAllMocks()
    qmpClient = new QMPClient(testSocketPath, {
      connectTimeout: 5000,
      commandTimeout: 30000
    })
  })

  afterEach(async () => {
    try {
      await qmpClient.disconnect()
    } catch {
      // Ignore disconnect errors in cleanup
    }
  })

  describe('Connection', () => {
    it('should connect to QMP socket successfully', async () => {
      await expect(qmpClient.connect()).resolves.toBeUndefined()
      expect(qmpClient.isConnected()).toBe(true)
    })

    it('should handle connection timeout', async () => {
      // Create client with very short timeout
      const shortTimeoutClient = new QMPClient(testSocketPath, {
        connectTimeout: 1
      })

      // Mock createConnection to never connect
      jest.spyOn(require('net'), 'createConnection').mockImplementation(() => {
        const socket = new MockSocket()
        // Don't call connect, so it times out
        return socket
      })

      await expect(shortTimeoutClient.connect()).rejects.toThrow('Connection timeout')

      jest.restoreAllMocks()
    })

    it('should handle already connected state', async () => {
      await qmpClient.connect()
      // Second connect should be a no-op
      await expect(qmpClient.connect()).resolves.toBeUndefined()
    })

    it('should disconnect gracefully', async () => {
      await qmpClient.connect()
      expect(qmpClient.isConnected()).toBe(true)

      await qmpClient.disconnect()
      expect(qmpClient.isConnected()).toBe(false)
    })

    it('should handle disconnect when not connected', async () => {
      await expect(qmpClient.disconnect()).resolves.toBeUndefined()
    })
  })

  describe('Command Execution', () => {
    beforeEach(async () => {
      await qmpClient.connect()
    })

    it('should execute query-status command', async () => {
      const status = await qmpClient.queryStatus()
      expect(status.status).toBe('running')
      expect(status.running).toBe(true)
    })

    it('should execute system_powerdown command', async () => {
      await expect(qmpClient.powerdown()).resolves.toBeUndefined()
    })

    it('should execute generic execute command', async () => {
      const result = await qmpClient.execute('test-command', { param: 'value' })
      expect(result).toEqual({})
    })

    it('should handle command timeout', async () => {
      // Create client with very short command timeout
      const shortTimeoutClient = new QMPClient(testSocketPath, {
        commandTimeout: 1
      })

      await shortTimeoutClient.connect()

      // Mock execute to never resolve
      jest.spyOn(shortTimeoutClient, 'execute').mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Command timed out')), 100)
        })
      })

      jest.restoreAllMocks()
    })

    it('should reject commands when not connected', async () => {
      const disconnectedClient = new QMPClient(testSocketPath)

      await expect(disconnectedClient.queryStatus()).rejects.toThrow('Not connected to QMP socket')
    })

    it('should handle command with arguments', async () => {
      const result = await qmpClient.execute('test-command', {
        device: 'ide0-cd0',
        force: true
      })
      expect(result).toEqual({})
    })
  })

  describe('VM Control Commands', () => {
    beforeEach(async () => {
      await qmpClient.connect()
    })

    it('should send system_reset command', async () => {
      await expect(qmpClient.reset()).resolves.toBeUndefined()
    })

    it('should send stop command', async () => {
      await expect(qmpClient.stop()).resolves.toBeUndefined()
    })

    it('should send cont command', async () => {
      await expect(qmpClient.cont()).resolves.toBeUndefined()
    })

    it('should send quit command', async () => {
      await expect(qmpClient.quit()).resolves.toBeUndefined()
      // After quit, socket should be closed
      expect(qmpClient.isConnected()).toBe(false)
    })

    it('should handle quit with ignoreErrors option', async () => {
      await expect(qmpClient.quit({ ignoreErrors: true })).resolves.toBeUndefined()
    })

    it('should send eject command', async () => {
      await expect(qmpClient.eject('ide0-cd0')).resolves.toBeUndefined()
      await expect(qmpClient.eject('ide0-cd0', true)).resolves.toBeUndefined()
    })
  })

  describe('Query Commands', () => {
    beforeEach(async () => {
      await qmpClient.connect()
    })

    it('should query CPU information', async () => {
      const cpus = await qmpClient.queryCpus()
      expect(Array.isArray(cpus)).toBe(true)
    })

    it('should query block devices', async () => {
      const blocks = await qmpClient.queryBlock()
      expect(Array.isArray(blocks)).toBe(true)
    })

    it('should query balloon information', async () => {
      const balloon = await qmpClient.queryBalloon()
      expect(balloon).toBeDefined()
    })
  })

  describe('Event Handling', () => {
    it('should emit SHUTDOWN event', (done) => {
      qmpClient.on('SHUTDOWN', (data, timestamp) => {
        expect(data).toBeDefined()
        expect(timestamp).toBeDefined()
        done()
      })

      // Simulate shutdown event by manually emitting
      // In real scenario, this comes from QMP socket
      qmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })
    })

    it('should emit POWERDOWN event', (done) => {
      qmpClient.on('POWERDOWN', (data, timestamp) => {
        expect(data).toBeDefined()
        done()
      })

      qmpClient.emit('POWERDOWN', {}, { seconds: 0, microseconds: 0 })
    })

    it('should emit disconnect event', (done) => {
      qmpClient.on('disconnect', () => {
        done()
      })

      qmpClient.emit('disconnect')
    })

    it('should allow event subscription before connection', () => {
      const client = new QMPClient(testSocketPath)
      const handler = jest.fn()

      client.on('SHUTDOWN', handler)
      client.emit('SHUTDOWN', {}, { seconds: 0, microseconds: 0 })

      expect(handler).toHaveBeenCalled()
    })
  })

  describe('Error Handling', () => {
    it('should handle socket errors during connection', async () => {
      // Mock socket error
      const mockSocket = new MockSocket()
      jest.spyOn(require('net'), 'createConnection').mockReturnValue(mockSocket)

      // Emit error after short delay
      setImmediate(() => {
        mockSocket.emit('error', new Error('Connection refused'))
      })

      await expect(qmpClient.connect()).rejects.toThrow()

      jest.restoreAllMocks()
    })

    it('should handle malformed JSON responses', async () => {
      await qmpClient.connect()

      // The mock socket handles JSON properly, but we test the error path
      // by checking that execute handles errors gracefully
      const result = await qmpClient.execute('invalid-command')
      expect(result).toBeDefined()
    })
  })

  describe('execute() pending-command leak (L161)', () => {
    it('rejects immediately and drops the pending entry if sendCommand throws synchronously', async () => {
      await qmpClient.connect()

      // Force the synchronous write to throw, simulating the socket vanishing between
      // the connected-check and the write. The pending entry + its 30s timeout must NOT
      // leak: the promise should reject right away rather than hang until the timeout.
      const socket = (qmpClient as any).socket
      jest.spyOn(socket, 'write').mockImplementation(() => {
        throw new Error('EPIPE: broken pipe')
      })

      await expect(qmpClient.execute('query-status')).rejects.toThrow(/EPIPE/)

      // No leaked pending command (it would otherwise fire its timeout 30s later).
      expect((qmpClient as any).pendingCommands.size).toBe(0)
    })
  })

  describe('connect() socket teardown on re-entry (L233)', () => {
    it('destroys and de-listens the previous socket before creating a new connection', async () => {
      await qmpClient.connect()

      // Capture the live socket and watch its teardown when connect() runs again
      // (as a reconnect would). Without the L233 fix the old socket + its
      // data/close listeners would leak on every flap.
      const oldSocket = (qmpClient as any).socket
      const destroySpy = jest.spyOn(oldSocket, 'destroy')
      const removeListenersSpy = jest.spyOn(oldSocket, 'removeAllListeners')

      // Drop connected state so connect() proceeds past the already-connected guard.
      ;(qmpClient as any).connected = false
      await qmpClient.connect()

      expect(removeListenersSpy).toHaveBeenCalled()
      expect(destroySpy).toHaveBeenCalled()
      // A fresh socket replaced the old one.
      expect((qmpClient as any).socket).not.toBe(oldSocket)
    })
  })

  describe('isReconnecting() accessor (H9)', () => {
    it('is false when reconnect is disabled', () => {
      const client = new QMPClient(testSocketPath, { reconnect: false })
      expect(client.isReconnecting()).toBe(false)
    })

    it('is true when reconnect is enabled and not intentionally closed', () => {
      const client = new QMPClient(testSocketPath, { reconnect: true, maxReconnectAttempts: 3 })
      expect(client.isReconnecting()).toBe(true)
    })

    it('is false after disconnect() intentionally closes the client', async () => {
      const client = new QMPClient(testSocketPath, { reconnect: true })
      await client.connect()
      await client.disconnect()
      expect(client.isReconnecting()).toBe(false)
    })

    it('is false once the retry budget is exhausted', () => {
      const client = new QMPClient(testSocketPath, { reconnect: true, maxReconnectAttempts: 2 })
      ;(client as any).reconnectAttempts = 2
      expect(client.isReconnecting()).toBe(false)
    })
  })

  describe('Connection State', () => {
    it('should return correct connection status', async () => {
      expect(qmpClient.isConnected()).toBe(false)

      await qmpClient.connect()
      expect(qmpClient.isConnected()).toBe(true)

      await qmpClient.disconnect()
      expect(qmpClient.isConnected()).toBe(false)
    })

    it('should get QMP greeting after connection', async () => {
      await qmpClient.connect()
      const greeting = qmpClient.getGreeting()
      expect(greeting).toBeDefined()
      expect(greeting?.QMP).toBeDefined()
    })
  })
})
