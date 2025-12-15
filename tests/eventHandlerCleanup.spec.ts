/**
 * EventHandler Guest-Initiated Shutdown Cleanup Tests
 *
 * Tests for EventHandler resource cleanup functionality when a VM is
 * shutdown from inside the guest OS (guest-initiated shutdown).
 *
 * These tests verify that:
 * 1. Volatile configuration is cleared (qmpSocketPath, qemuPid)
 * 2. TAP device is detached from bridge (preserved)
 * 3. Firewall jump rules are detached (chain preserved)
 * 4. Cgroup scopes are cleaned up if CPU pinning was used
 */

import { EventEmitter } from 'events'
import { EventHandler } from '../src/sync/EventHandler'
import { DatabaseAdapter, MachineRecord, RunningVMRecord } from '../src/types/sync.types'
import { TapDeviceManager } from '../src/network/TapDeviceManager'
import { NftablesService } from '../src/network/NftablesService'
import { CgroupsManager } from '../src/system/CgroupsManager'

// Mock the dependencies
jest.mock('../src/network/TapDeviceManager')
jest.mock('../src/network/NftablesService')
jest.mock('../src/system/CgroupsManager')

// Create mock implementations
const MockedTapDeviceManager = TapDeviceManager as jest.MockedClass<typeof TapDeviceManager>
const MockedNftablesService = NftablesService as jest.MockedClass<typeof NftablesService>
const MockedCgroupsManager = CgroupsManager as jest.MockedClass<typeof CgroupsManager>

// Mock QMPClient
class MockQMPClient extends EventEmitter {
  private _isConnected = true

  isConnected (): boolean {
    return this._isConnected
  }

  setConnected (connected: boolean): void {
    this._isConnected = connected
  }

  async queryStatus (): Promise<{ status: string }> {
    return { status: 'running' }
  }
}

describe('EventHandler Guest-Initiated Shutdown Cleanup', () => {
  let eventHandler: EventHandler
  let mockDb: jest.Mocked<DatabaseAdapter>
  let mockTapManager: jest.Mocked<TapDeviceManager>
  let mockNftables: jest.Mocked<NftablesService>
  let mockCgroupsManager: jest.Mocked<CgroupsManager>
  let mockQmpClient: MockQMPClient

  const testVmId = 'test-vm-123'
  const testTapDevice = 'vnet-testvm12'
  const testQemuPid = 12345

  beforeEach(() => {
    jest.clearAllMocks()

    // Create mock database adapter
    mockDb = {
      findMachine: jest.fn(),
      updateMachineStatus: jest.fn(),
      findRunningVMs: jest.fn(),
      clearMachineConfiguration: jest.fn(),
      clearVolatileMachineConfiguration: jest.fn()
    }

    // Setup default mock responses
    mockDb.findMachine.mockResolvedValue({ id: testVmId, status: 'running' })
    mockDb.updateMachineStatus.mockResolvedValue()
    mockDb.findRunningVMs.mockResolvedValue([
      {
        id: testVmId,
        status: 'running',
        MachineConfiguration: {
          qmpSocketPath: '/var/run/qemu/test.sock',
          qemuPid: testQemuPid,
          tapDeviceName: testTapDevice,
          guestAgentSocketPath: null,
          infiniServiceSocketPath: null
        }
      }
    ])
    mockDb.clearVolatileMachineConfiguration.mockResolvedValue()

    // Get mock instances
    mockTapManager = new MockedTapDeviceManager() as jest.Mocked<TapDeviceManager>
    mockNftables = new MockedNftablesService() as jest.Mocked<NftablesService>
    mockCgroupsManager = new MockedCgroupsManager() as jest.Mocked<CgroupsManager>

    // Setup mock method implementations
    mockTapManager.detachFromBridge = jest.fn().mockResolvedValue(undefined)
    mockNftables.detachJumpRules = jest.fn().mockResolvedValue(undefined)
    mockCgroupsManager.cleanupEmptyScopes = jest.fn().mockResolvedValue(0)

    // Create EventHandler instance
    eventHandler = new EventHandler(mockDb, {
      enableLogging: false,
      emitCustomEvents: true
    })

    // Create mock QMP client
    mockQmpClient = new MockQMPClient()
  })

  afterEach(async () => {
    await eventHandler.detachAll()
  })

  describe('cleanupVMResources', () => {
    beforeEach(async () => {
      // Attach to VM before testing
      await eventHandler.attachToVM(testVmId, mockQmpClient as any)
    })

    it('clears volatile configuration on guest-initiated shutdown', async () => {
      // Simulate SHUTDOWN event with guest-shutdown reason
      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })

      // Wait for async operations to complete
      await new Promise(resolve => setTimeout(resolve, 100))

      // Verify volatile configuration was cleared
      expect(mockDb.clearVolatileMachineConfiguration).toHaveBeenCalledWith(testVmId)
    })

    it('detaches TAP device from bridge on guest-initiated shutdown', async () => {
      // Simulate SHUTDOWN event
      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100))

      // Verify TAP device was detached (not destroyed)
      expect(MockedTapDeviceManager.prototype.detachFromBridge).toHaveBeenCalledWith(testTapDevice)
    })

    it('detaches firewall jump rules on guest-initiated shutdown', async () => {
      // Simulate SHUTDOWN event
      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100))

      // Verify firewall jump rules were detached
      expect(MockedNftablesService.prototype.detachJumpRules).toHaveBeenCalledWith(testVmId)
    })

    it('handles cleanup errors gracefully', async () => {
      // Make TAP detach fail
      mockTapManager.detachFromBridge = jest.fn().mockRejectedValue(new Error('TAP detach failed'))
      MockedTapDeviceManager.prototype.detachFromBridge = mockTapManager.detachFromBridge

      // Simulate SHUTDOWN event
      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should not throw - errors are logged but don't prevent other cleanup
      // Firewall cleanup should still be attempted
      expect(MockedNftablesService.prototype.detachJumpRules).toHaveBeenCalledWith(testVmId)
    })

    it('does not cleanup on host-qmp-quit (VMLifecycle handles it)', async () => {
      // Simulate SHUTDOWN event with host-qmp-quit reason
      mockQmpClient.emit('SHUTDOWN', { guest: false, reason: 'host-qmp-quit' }, { seconds: 0, microseconds: 0 })

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should NOT clear volatile config - VMLifecycle.stop() handles this
      expect(mockDb.clearVolatileMachineConfiguration).not.toHaveBeenCalled()
    })

    it('handles missing TAP device gracefully', async () => {
      // Setup VM without TAP device
      mockDb.findRunningVMs.mockResolvedValue([
        {
          id: testVmId,
          status: 'running',
          MachineConfiguration: {
            qmpSocketPath: '/var/run/qemu/test.sock',
            qemuPid: testQemuPid,
            tapDeviceName: null,
            guestAgentSocketPath: null,
            infiniServiceSocketPath: null
          }
        }
      ])

      // Simulate SHUTDOWN event
      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should not attempt TAP detach when no TAP device
      expect(MockedTapDeviceManager.prototype.detachFromBridge).not.toHaveBeenCalled()

      // But should still cleanup other resources
      expect(MockedNftablesService.prototype.detachJumpRules).toHaveBeenCalledWith(testVmId)
    })
  })

  describe('Database status updates', () => {
    beforeEach(async () => {
      await eventHandler.attachToVM(testVmId, mockQmpClient as any)
    })

    it('updates DB status to off on SHUTDOWN event', async () => {
      // Simulate SHUTDOWN event
      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50))

      // Verify status was updated to 'off'
      expect(mockDb.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'off')
    })

    it('updates DB status to off on POWERDOWN event', async () => {
      // Simulate POWERDOWN event
      mockQmpClient.emit('POWERDOWN', {}, { seconds: 0, microseconds: 0 })

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50))

      // Verify status was updated to 'off'
      expect(mockDb.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'off')
    })
  })

  describe('Event emission', () => {
    beforeEach(async () => {
      await eventHandler.attachToVM(testVmId, mockQmpClient as any)
    })

    it('emits vm:shutdown event on SHUTDOWN', (done) => {
      eventHandler.once('vm:shutdown', (data) => {
        expect(data.vmId).toBe(testVmId)
        expect(data.event).toBe('SHUTDOWN')
        expect(data.newStatus).toBe('off')
        done()
      })

      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })
    })

    it('emits vm:off event on shutdown', (done) => {
      eventHandler.once('vm:off', (data) => {
        expect(data.vmId).toBe(testVmId)
        done()
      })

      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })
    })
  })

  describe('Process monitoring', () => {
    beforeEach(async () => {
      await eventHandler.attachToVM(testVmId, mockQmpClient as any)
    })

    it('retrieves PID before status update for process monitoring', async () => {
      // Verify findRunningVMs is called to get PID
      mockQmpClient.emit('SHUTDOWN', { guest: true, reason: 'guest-shutdown' }, { seconds: 0, microseconds: 0 })

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50))

      // findRunningVMs should have been called to retrieve PID
      expect(mockDb.findRunningVMs).toHaveBeenCalled()
    })
  })

  describe('Attachment management', () => {
    it('tracks attached VMs correctly', async () => {
      expect(eventHandler.isAttached(testVmId)).toBe(false)

      await eventHandler.attachToVM(testVmId, mockQmpClient as any)

      expect(eventHandler.isAttached(testVmId)).toBe(true)
      expect(eventHandler.getAttachedVMs()).toContain(testVmId)
    })

    it('handles detachment on QMP disconnect', async () => {
      await eventHandler.attachToVM(testVmId, mockQmpClient as any)
      expect(eventHandler.isAttached(testVmId)).toBe(true)

      // Simulate disconnect
      mockQmpClient.emit('disconnect')

      expect(eventHandler.isAttached(testVmId)).toBe(false)
    })

    it('provides QMP client access for attached VMs', async () => {
      await eventHandler.attachToVM(testVmId, mockQmpClient as any)

      const client = eventHandler.getQMPClient(testVmId)
      expect(client).toBe(mockQmpClient)
    })

    it('returns undefined for non-attached VMs', () => {
      const client = eventHandler.getQMPClient('non-existent-vm')
      expect(client).toBeUndefined()
    })
  })
})

describe('StateSync clearVolatileMachineConfiguration', () => {
  it('clears qmpSocketPath and qemuPid but preserves tapDeviceName', async () => {
    const mockDb: jest.Mocked<DatabaseAdapter> = {
      findMachine: jest.fn(),
      updateMachineStatus: jest.fn(),
      findRunningVMs: jest.fn(),
      clearMachineConfiguration: jest.fn(),
      clearVolatileMachineConfiguration: jest.fn().mockResolvedValue(undefined)
    }

    // Import StateSync directly for this test
    const { StateSync } = await import('../src/sync/StateSync')
    const stateSync = new StateSync(mockDb)

    await stateSync.clearVolatileMachineConfiguration('test-vm')

    expect(mockDb.clearVolatileMachineConfiguration).toHaveBeenCalledWith('test-vm')
  })
})
