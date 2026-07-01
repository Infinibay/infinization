/**
 * VMLifecycle Unit Tests (rewritten for the service-injection architecture)
 *
 * This suite was rewritten from the ground up (H12). The legacy version was
 * `describe.skip` because it:
 *   - auto-mocked the fluent QemuCommandBuilder so the builder chain returned
 *     undefined (every `.setX().setY()` call threw),
 *   - used the pre-multi-disk FLAT VMConfigRecord/config shape, and
 *   - asserted behavior this hardening pass deliberately changed (it expected
 *     cleanup to call qemuProcess.stop() + nftables.detachJumpRules(), whereas
 *     the current cleanup() force-kills and removes the whole VM chain;
 *     it ignored origin-aware cleanup, always-apply firewall, fail-closed
 *     firewall posture, and reused-TAP non-destruction).
 *
 * The rewrite drives the REAL constructor. VMLifecycle constructs its services
 * (TapDeviceManager / NftablesService / QemuImgService / CgroupsManager)
 * INTERNALLY, so we jest.mock() those modules and recover the singleton mock
 * instance the constructor created. PrismaAdapter + EventHandler are passed in.
 * QMPClient / QemuProcess are mocked. QemuCommandBuilder keeps its FLUENT chain
 * (every builder method returns `this`) so buildQemuCommand() works.
 *
 * It focuses on the high-value state-machine paths the audit named:
 *   1. create() rolls back resources on EACH throw point.
 *   2. start() never DESTROYS a reused persistent TAP on failure (detach only).
 *   3. stop() escalates graceful powerdown -> force-kill on timeout.
 *   4. getStatus() consistency (db-running vs process-alive).
 *   5. fetchFirewallRules() fails CLOSED ('drop' default; re-throws real DB errors).
 *
 * No real QEMU processes, sockets, ports, /proc reads, or host mutations occur:
 * fs and process.kill are mocked, and the host-IO private helpers are stubbed.
 *
 * LEGACY CASES DROPPED (could not be salvaged against the current architecture):
 *   - "cleanup calls qemuProcess.stop()" / "detachFromBridge + detachJumpRules"
 *     assertions — current cleanup() force-kills and removeVMChain()s instead;
 *     replaced with the real cleanup contract (forceKill + removeVMChain +
 *     conditional destroy).
 *   - orphan-pidfile process.kill(pid,0) cases — superseded by the identity-gated
 *     pidBelongsToVM check (covered by the dedicated processIdentity suite).
 *   - flat-config validateDisplayPort cases — kept, but rebuilt on the nested
 *     multi-disk config shape.
 */

import { VMLifecycle } from '../src/core/VMLifecycle'
import { QemuProcess } from '../src/core/QemuProcess'
import { QMPClient } from '../src/core/QMPClient'
import { TapDeviceManager } from '../src/network/TapDeviceManager'
import { NftablesService } from '../src/network/NftablesService'
import { QemuImgService } from '../src/storage/QemuImgService'
import { CgroupsManager } from '../src/system/CgroupsManager'
import { PrismaAdapter } from '../src/db/PrismaAdapter'
import { EventHandler } from '../src/sync/EventHandler'
import { VMCreateConfig, LifecycleError, LifecycleErrorCode } from '../src/types/lifecycle.types'
import { PrismaAdapterError, PrismaAdapterErrorCode } from '../src/types/db.types'
import { EventEmitter } from 'events'

// QemuCommandBuilder is intentionally NOT auto-mocked: we provide a real fluent
// stub below so the builder chain (setMachine().setCpu()...) returns `this`.
jest.mock('../src/core/QemuProcess')
jest.mock('../src/core/QMPClient')
jest.mock('../src/network/TapDeviceManager')
jest.mock('../src/network/NftablesService')
jest.mock('../src/storage/QemuImgService')
jest.mock('../src/system/CgroupsManager')
jest.mock('fs')

const MockedQemuProcess = QemuProcess as jest.MockedClass<typeof QemuProcess>
const MockedQMPClient = QMPClient as jest.MockedClass<typeof QMPClient>
const MockedTapDeviceManager = TapDeviceManager as jest.MockedClass<typeof TapDeviceManager>
const MockedNftablesService = NftablesService as jest.MockedClass<typeof NftablesService>
const MockedQemuImgService = QemuImgService as jest.MockedClass<typeof QemuImgService>
const MockedCgroupsManager = CgroupsManager as jest.MockedClass<typeof CgroupsManager>

// fs is mocked; give the methods VMLifecycle touches sane defaults per-test.
const fs = require('fs')

const testVmId = 'test-vm-123'
const testInternalName = 'vm-test123'
const testTapDevice = 'vnet-testvm12'
const testBridge = 'virbr0'
const testQemuPid = 12345

/**
 * Fluent QMP client mock (EventEmitter-based so attachToVM-style wiring works).
 * Every method is a jest.fn so calls can be asserted / overridden per-test.
 */
class MockQMPClient extends EventEmitter {
  isConnected = jest.fn((): boolean => true)
  connect = jest.fn(async (): Promise<void> => {})
  disconnect = jest.fn(async (): Promise<void> => {})
  queryStatus = jest.fn(async (): Promise<{ status: string }> => ({ status: 'running' }))
  powerdown = jest.fn(async (): Promise<void> => {})
  reset = jest.fn(async (): Promise<void> => {})
  cont = jest.fn(async (): Promise<void> => {})
  stop = jest.fn(async (): Promise<void> => {})
  execute = jest.fn(async (): Promise<unknown> => ({}))
}

/** A nested multi-disk VMCreateConfig matching the current shape. */
function makeCreateConfig (overrides: Partial<VMCreateConfig> = {}): VMCreateConfig {
  return {
    vmId: testVmId,
    name: 'Test VM',
    internalName: testInternalName,
    os: 'ubuntu',
    cpuCores: 4,
    ramGB: 8,
    disks: [{ sizeGB: 50, format: 'qcow2', bus: 'virtio', cache: 'writeback' }],
    bridge: testBridge,
    displayType: 'spice',
    displayPort: 5901,
    ...overrides
  }
}

/** A VMConfigRecord-shaped DB row for start/stop/status flows. */
function makeVmRow (overrides: Record<string, any> = {}): any {
  return {
    id: testVmId,
    status: 'off',
    name: 'Test VM',
    internalName: testInternalName,
    os: 'ubuntu',
    cpuCores: 4,
    ramGB: 8,
    diskSizeGB: 50,
    gpuPciAddress: null,
    version: 1,
    firewallRuleSet: null,
    department: null,
    configuration: {
      qmpSocketPath: '/var/run/qemu/vm-test123.sock',
      qemuPid: testQemuPid,
      tapDeviceName: testTapDevice,
      diskPaths: ['/var/lib/infinibay/disks/vm-test123.qcow2'],
      machineType: 'q35',
      cpuModel: 'host',
      diskBus: 'virtio',
      networkModel: 'virtio-net-pci',
      graphicProtocol: 'spice',
      graphicPort: 5901
    },
    ...overrides
  }
}

describe('VMLifecycle', () => {
  let lifecycle: VMLifecycle
  let mockPrisma: jest.Mocked<PrismaAdapter>
  let mockEventHandler: jest.Mocked<EventHandler>
  let mockQemuProcess: jest.Mocked<QemuProcess>
  let mockQmpClient: MockQMPClient
  // Internally-constructed services, recovered from the mocked class instances.
  let tapManager: jest.Mocked<TapDeviceManager>
  let nftables: jest.Mocked<NftablesService>
  let qemuImg: jest.Mocked<QemuImgService>
  let cgroups: jest.Mocked<CgroupsManager>

  let originalKill: typeof process.kill

  beforeEach(() => {
    jest.clearAllMocks()

    // ---- fs defaults: no orphan resources, unlinks/reads are inert ----------
    fs.existsSync = jest.fn().mockReturnValue(false)
    fs.unlinkSync = jest.fn()
    // readFileSync throwing => cleanup()'s pidfile-reap treats the pidfile as
    // "already gone" and sends no signal (keeps the reap hermetic).
    fs.readFileSync = jest.fn(() => { throw new Error('ENOENT') })
    fs.mkdirSync = jest.fn()
    fs.statSync = jest.fn(() => ({ isSocket: () => true }))

    // ---- never let the shared process-identity helpers touch the real host --
    originalKill = process.kill
    process.kill = jest.fn() as any

    // ---- prisma (injected) --------------------------------------------------
    mockPrisma = {
      updateMachineStatus: jest.fn().mockResolvedValue(undefined),
      updateMachineConfiguration: jest.fn().mockResolvedValue(undefined),
      clearVolatileMachineConfiguration: jest.fn().mockResolvedValue(undefined),
      clearMachineConfiguration: jest.fn().mockResolvedValue(undefined),
      findMachineWithConfig: jest.fn().mockResolvedValue(makeVmRow()),
      transitionVMStatus: jest.fn().mockResolvedValue({ vmConfig: makeVmRow({ status: 'starting' }), newVersion: 2 }),
      getFirewallRules: jest.fn().mockResolvedValue([]),
      getFirewallRulesSplit: jest.fn().mockResolvedValue({ departmentRules: [], vmRules: [] }),
      getDepartmentFirewallPolicy: jest.fn().mockResolvedValue('BLOCK_ALL')
    } as unknown as jest.Mocked<PrismaAdapter>

    // ---- event handler (injected) ------------------------------------------
    mockEventHandler = {
      attachToVM: jest.fn().mockResolvedValue(undefined),
      detachFromVM: jest.fn().mockResolvedValue(undefined),
      getQMPClient: jest.fn().mockReturnValue(undefined),
      markInstallInProgress: jest.fn(),
      clearInstallInProgress: jest.fn()
    } as unknown as jest.Mocked<EventHandler>

    // ---- QemuProcess mock instance -----------------------------------------
    mockQemuProcess = {
      setQmpSocketPath: jest.fn(),
      setPidFilePath: jest.fn(),
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      forceKill: jest.fn().mockResolvedValue(undefined),
      isAlive: jest.fn().mockReturnValue(true),
      getPid: jest.fn().mockReturnValue(testQemuPid)
    } as unknown as jest.Mocked<QemuProcess>
    MockedQemuProcess.mockImplementation(() => mockQemuProcess)

    // ---- QMPClient mock instance -------------------------------------------
    mockQmpClient = new MockQMPClient()
    ;(MockedQMPClient as any).mockImplementation(() => mockQmpClient)

    // ---- Internally-constructed services: capture singleton mock instances --
    MockedTapDeviceManager.mockClear()
    MockedNftablesService.mockClear()
    MockedQemuImgService.mockClear()
    MockedCgroupsManager.mockClear()

    // Construct the lifecycle (constructor does `new TapDeviceManager()` etc.).
    lifecycle = new VMLifecycle(mockPrisma, mockEventHandler, undefined, {
      diskDir: '/var/lib/infinibay/disks',
      qmpSocketDir: '/var/run/qemu',
      pidfileDir: '/var/run/qemu'
    })

    // Recover the instances the constructor created (mockImplementation auto-
    // returns a jest.Mocked instance per `new`); configure their methods.
    tapManager = MockedTapDeviceManager.mock.instances[0] as jest.Mocked<TapDeviceManager>
    nftables = MockedNftablesService.mock.instances[0] as jest.Mocked<NftablesService>
    qemuImg = MockedQemuImgService.mock.instances[0] as jest.Mocked<QemuImgService>
    cgroups = MockedCgroupsManager.mock.instances[0] as jest.Mocked<CgroupsManager>

    tapManager.create = jest.fn().mockResolvedValue(testTapDevice)
    tapManager.configure = jest.fn().mockResolvedValue(undefined)
    tapManager.exists = jest.fn().mockResolvedValue(false)
    tapManager.hasCarrier = jest.fn().mockResolvedValue(true)
    tapManager.attachToBridge = jest.fn().mockResolvedValue(undefined)
    tapManager.detachFromBridge = jest.fn().mockResolvedValue(undefined)
    tapManager.bringDown = jest.fn().mockResolvedValue(undefined)
    tapManager.destroy = jest.fn().mockResolvedValue(undefined)
    tapManager.getDeviceState = jest.fn().mockResolvedValue('UP')

    nftables.createVMChain = jest.fn().mockResolvedValue('chain')
    nftables.ensureVMChain = jest.fn().mockResolvedValue('chain')
    nftables.applyRules = jest.fn().mockResolvedValue({ success: true })
    nftables.applyRulesIfChanged = jest.fn().mockResolvedValue({ changed: true })
    nftables.attachJumpRules = jest.fn().mockResolvedValue(undefined)
    nftables.detachJumpRules = jest.fn().mockResolvedValue(undefined)
    nftables.removeVMChain = jest.fn().mockResolvedValue(undefined)

    qemuImg.createImage = jest.fn().mockResolvedValue(undefined)

    cgroups.validateCores = jest.fn().mockResolvedValue(undefined)
    cgroups.applyCpuPinning = jest.fn().mockResolvedValue({ applied: true })
    cgroups.cleanupEmptyScopes = jest.fn().mockResolvedValue(0)

    // ---- stub host-IO private helpers (no real ports / sockets / /proc) -----
    jest.spyOn(lifecycle as any, 'findAvailableDisplayPort').mockResolvedValue(5901)
    jest.spyOn(lifecycle as any, 'isPortAvailable').mockResolvedValue(true)
    jest.spyOn(lifecycle as any, 'waitForSocket').mockResolvedValue(undefined)
    jest.spyOn(lifecycle as any, 'verifyTapConnection').mockResolvedValue(undefined)
    jest.spyOn(lifecycle as any, 'isProcessAlive').mockReturnValue(true)
    jest.spyOn(lifecycle as any, 'pidBelongsToVM').mockReturnValue(true)
    jest.spyOn(lifecycle as any, 'forceKillProcess').mockResolvedValue(true)
    // sleep() short-circuit so cleanup()'s 500/200/200ms waits don't slow tests.
    jest.spyOn(lifecycle as any, 'sleep').mockResolvedValue(undefined)
  })

  afterEach(() => {
    process.kill = originalKill
  })

  // ==========================================================================
  // create() — happy path
  // ==========================================================================
  describe('create', () => {
    it('creates a VM, wiring disk/tap/firewall/qemu/qmp/db in order', async () => {
      const result = await lifecycle.create(makeCreateConfig())

      expect(qemuImg.createImage).toHaveBeenCalledWith(
        expect.objectContaining({ path: expect.stringContaining(testInternalName), sizeGB: 50 })
      )
      expect(tapManager.create).toHaveBeenCalledWith(testVmId, testBridge)
      expect(tapManager.configure).toHaveBeenCalledWith(testTapDevice, testBridge)
      // Firewall ALWAYS applied (even with zero explicit rules).
      expect(nftables.createVMChain).toHaveBeenCalledWith(testVmId, testTapDevice)
      expect(nftables.applyRules).toHaveBeenCalled()
      expect(mockQemuProcess.start).toHaveBeenCalled()
      expect(mockQmpClient.connect).toHaveBeenCalled()
      // Row marked 'starting' before spawn (H3), then 'running' on success.
      expect(mockPrisma.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'starting')
      expect(mockPrisma.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'running')
      expect(result.success).toBe(true)
      expect(result.tapDevice).toBe(testTapDevice)
      expect(result.vmId).toBe(testVmId)
    })

    it('creates one image per disk for a multi-disk config', async () => {
      await lifecycle.create(makeCreateConfig({
        disks: [{ sizeGB: 50 }, { sizeGB: 100 }, { sizeGB: 20 }]
      }))
      expect(qemuImg.createImage).toHaveBeenCalledTimes(3)
    })

    it('applies the fail-closed terminal posture when no explicit action given', async () => {
      // BLOCK_ALL department => derived defaultAction 'drop' is passed to applyRules.
      mockPrisma.getDepartmentFirewallPolicy.mockResolvedValue('BLOCK_ALL')
      await lifecycle.create(makeCreateConfig())
      const args = (nftables.applyRules as jest.Mock).mock.calls[0]
      expect(args[args.length - 1]).toBe('drop')
    })

    it('passes accept as the terminal action for an ALLOW_ALL department', async () => {
      mockPrisma.getDepartmentFirewallPolicy.mockResolvedValue('ALLOW_ALL')
      await lifecycle.create(makeCreateConfig())
      const args = (nftables.applyRules as jest.Mock).mock.calls[0]
      expect(args[args.length - 1]).toBe('accept')
    })

    it('applies CPU pinning when configured', async () => {
      await lifecycle.create(makeCreateConfig({ cpuPinning: [0, 1, 2, 3] }))
      expect(cgroups.validateCores).toHaveBeenCalledWith([0, 1, 2, 3])
      expect(cgroups.applyCpuPinning).toHaveBeenCalledWith(testQemuPid, [0, 1, 2, 3])
    })

    it('rejects invalid CPU pinning before allocating any resources', async () => {
      cgroups.validateCores.mockRejectedValueOnce(new Error('Invalid CPU cores'))
      await expect(lifecycle.create(makeCreateConfig({ cpuPinning: [999] })))
        .rejects.toThrow(LifecycleError)
      // No resources should have been provisioned.
      expect(qemuImg.createImage).not.toHaveBeenCalled()
      expect(tapManager.create).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // create() — ROLLBACK on each throw point (audit #1)
  // ==========================================================================
  describe('create() rollback', () => {
    it('rolls back the TAP + chain created so far when QEMU spawn throws', async () => {
      mockQemuProcess.start.mockRejectedValueOnce(new Error('QEMU failed to start'))

      await expect(lifecycle.create(makeCreateConfig())).rejects.toThrow(LifecycleError)

      // cleanup() force-kills (NOT graceful stop), removes the whole VM chain,
      // brings the TAP down then destroys it (origin=create, not reused).
      expect(mockQemuProcess.forceKill).toHaveBeenCalled()
      expect(mockQemuProcess.stop).not.toHaveBeenCalled()
      expect(nftables.removeVMChain).toHaveBeenCalledWith(testVmId)
      expect(tapManager.bringDown).toHaveBeenCalledWith(testTapDevice)
      expect(tapManager.destroy).toHaveBeenCalledWith(testTapDevice)
      // create-origin cleanup wipes config and marks the row 'error'.
      expect(mockPrisma.clearMachineConfiguration).toHaveBeenCalledWith(testVmId)
      expect(mockPrisma.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'error')
    })

    it('reaps earlier resources when a LATER db write throws', async () => {
      // Disk + TAP + chain + QEMU + QMP all succeed; the final config write fails.
      mockPrisma.updateMachineConfiguration.mockRejectedValueOnce(new Error('DB write failed'))

      await expect(lifecycle.create(makeCreateConfig())).rejects.toThrow(LifecycleError)

      expect(mockQmpClient.disconnect).toHaveBeenCalled()
      expect(mockQemuProcess.forceKill).toHaveBeenCalled()
      expect(nftables.removeVMChain).toHaveBeenCalledWith(testVmId)
      expect(tapManager.destroy).toHaveBeenCalledWith(testTapDevice)
      expect(mockPrisma.clearMachineConfiguration).toHaveBeenCalledWith(testVmId)
    })

    it('does not provision QEMU when disk creation fails, and still cleans up', async () => {
      qemuImg.createImage.mockRejectedValueOnce(new Error('Disk creation failed'))

      await expect(lifecycle.create(makeCreateConfig())).rejects.toThrow(LifecycleError)

      // QEMU was never spawned (failure happened before spawn).
      expect(mockQemuProcess.start).not.toHaveBeenCalled()
      // No TAP/chain were created yet, so destroy/removeVMChain run harmlessly;
      // the DB row is finalized to 'error'.
      expect(mockPrisma.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'error')
    })

    it('cleans up QEMU + QMP when the QMP connect throws', async () => {
      ;(mockQmpClient.connect as jest.Mock).mockRejectedValueOnce(new Error('QMP connection failed'))

      await expect(lifecycle.create(makeCreateConfig())).rejects.toThrow(LifecycleError)

      expect(mockQemuProcess.forceKill).toHaveBeenCalled()
      expect(nftables.removeVMChain).toHaveBeenCalledWith(testVmId)
      expect(tapManager.destroy).toHaveBeenCalledWith(testTapDevice)
    })
  })

  // ==========================================================================
  // start() — reused persistent TAP must NEVER be destroyed on failure (audit #2)
  // ==========================================================================
  describe('start() reused-TAP non-destruction', () => {
    beforeEach(() => {
      // Row says 'off' (re-startable) with a persistent TAP recorded.
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'off' }))
      // The persistent TAP already exists => start() REUSES it (tapWasReused=true).
      tapManager.exists.mockResolvedValue(true)
      tapManager.hasCarrier.mockResolvedValue(false)
      // Disk images must "exist" so start() proceeds past the disk check to the
      // TAP/QEMU stage; sockets/pidfiles stay absent (no orphan-conflict path).
      fs.existsSync = jest.fn((p: string) => typeof p === 'string' && p.endsWith('.qcow2'))
    })

    it('detaches (never destroys) a reused TAP when start fails', async () => {
      mockQemuProcess.start.mockRejectedValueOnce(new Error('spawn failed'))

      await expect(lifecycle.start(testVmId)).rejects.toThrow(LifecycleError)

      // Reused TAP: bringDown is fine, but destroy() must NOT be called.
      expect(tapManager.bringDown).toHaveBeenCalledWith(testTapDevice)
      expect(tapManager.destroy).not.toHaveBeenCalled()
      // start-origin cleanup is RECOVERABLE: volatile clear + reset to 'off'
      // (never wipe persistent config, never mark 'error').
      expect(mockPrisma.clearVolatileMachineConfiguration).toHaveBeenCalledWith(testVmId)
      expect(mockPrisma.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'off')
      expect(mockPrisma.clearMachineConfiguration).not.toHaveBeenCalled()
    })

    it('DOES destroy a freshly-created TAP when start fails (not reused)', async () => {
      // No existing TAP => start() creates a new one (tapWasReused stays false).
      tapManager.exists.mockResolvedValue(false)
      tapManager.create.mockResolvedValue(testTapDevice)
      mockQemuProcess.start.mockRejectedValueOnce(new Error('spawn failed'))

      await expect(lifecycle.start(testVmId)).rejects.toThrow(LifecycleError)

      expect(tapManager.destroy).toHaveBeenCalledWith(testTapDevice)
    })

    it('reattaches the reused TAP to the bridge only AFTER firewall is applied', async () => {
      await lifecycle.start(testVmId)

      // Firewall posture installed, then deferred bridge attach.
      expect(nftables.applyRulesIfChanged).toHaveBeenCalled()
      expect(tapManager.attachToBridge).toHaveBeenCalledWith(testTapDevice, testBridge)
      const applyOrder = (nftables.applyRulesIfChanged as jest.Mock).mock.invocationCallOrder[0]
      const attachOrder = (tapManager.attachToBridge as jest.Mock).mock.invocationCallOrder[0]
      expect(attachOrder).toBeGreaterThan(applyOrder)
    })
  })

  // ==========================================================================
  // stop() — graceful powerdown escalates to force-kill (audit #3)
  // ==========================================================================
  describe('stop', () => {
    beforeEach(() => {
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'running' }))
      fs.existsSync = jest.fn().mockReturnValue(true) // QMP socket present
    })

    it('stops gracefully via ACPI powerdown when the guest exits in time', async () => {
      ;(lifecycle as any).isProcessAlive.mockReturnValue(true)
      jest.spyOn(lifecycle as any, 'waitForProcessExit').mockResolvedValue(true)

      const result = await lifecycle.stop(testVmId)

      expect(mockQmpClient.powerdown).toHaveBeenCalled()
      expect((lifecycle as any).forceKillProcess).not.toHaveBeenCalled()
      // stop() demotes to 'off' but guards against clobbering a terminal 'error'.
      expect(mockPrisma.updateMachineStatus).toHaveBeenCalledWith(testVmId, 'off', { onlyIfNotIn: ['error'] })
      // TAP detached from bridge (persistent) — NOT destroyed.
      expect(tapManager.detachFromBridge).toHaveBeenCalledWith(testTapDevice)
      expect(tapManager.destroy).not.toHaveBeenCalled()
      expect(result.success).toBe(true)
      expect(result.forced).toBe(false)
    })

    it('escalates to force-kill when ACPI powerdown times out', async () => {
      ;(lifecycle as any).isProcessAlive.mockReturnValue(true)
      jest.spyOn(lifecycle as any, 'waitForProcessExit').mockResolvedValue(false)

      const result = await lifecycle.stop(testVmId, { timeout: 100, force: true })

      expect(mockQmpClient.powerdown).toHaveBeenCalled()
      expect((lifecycle as any).forceKillProcess).toHaveBeenCalledWith(testQemuPid, testInternalName)
      expect(result.success).toBe(true)
      expect(result.forced).toBe(true)
    })

    it('skips QMP entirely when the process is already dead', async () => {
      ;(lifecycle as any).isProcessAlive.mockReturnValue(false)

      const result = await lifecycle.stop(testVmId)

      expect(mockQmpClient.powerdown).not.toHaveBeenCalled()
      expect((lifecycle as any).forceKillProcess).not.toHaveBeenCalled()
      expect(mockPrisma.clearVolatileMachineConfiguration).toHaveBeenCalledWith(testVmId)
      expect(result.success).toBe(true)
    })
  })

  // ==========================================================================
  // getStatus() — consistency (audit #4)
  // ==========================================================================
  describe('getStatus', () => {
    it('reports consistent=true when db-running and process alive', async () => {
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'running' }))
      ;(lifecycle as any).isProcessAlive.mockReturnValue(true)
      mockEventHandler.getQMPClient.mockReturnValue(mockQmpClient as any)

      const status = await lifecycle.getStatus(testVmId)

      expect(status.status).toBe('running')
      expect(status.processAlive).toBe(true)
      expect(status.consistent).toBe(true)
      expect(status.qmpStatus).toBe('running')
    })

    it('reports consistent=false when db says running but process is dead', async () => {
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'running' }))
      ;(lifecycle as any).isProcessAlive.mockReturnValue(false)

      const status = await lifecycle.getStatus(testVmId)

      expect(status.status).toBe('running')
      expect(status.processAlive).toBe(false)
      expect(status.consistent).toBe(false)
    })

    it('reports consistent=true when db-off and process dead', async () => {
      mockPrisma.findMachineWithConfig.mockResolvedValue(
        makeVmRow({ status: 'off', configuration: { ...makeVmRow().configuration, qemuPid: null } })
      )
      ;(lifecycle as any).isProcessAlive.mockReturnValue(false)

      const status = await lifecycle.getStatus(testVmId)

      expect(status.status).toBe('off')
      expect(status.processAlive).toBe(false)
      expect(status.consistent).toBe(true)
    })

    it('wraps a missing VM as a LifecycleError', async () => {
      mockPrisma.findMachineWithConfig.mockResolvedValue(null)
      await expect(lifecycle.getStatus(testVmId)).rejects.toThrow(LifecycleError)
    })
  })

  // ==========================================================================
  // fetchFirewallRules() — fail-closed (audit #5)
  // ==========================================================================
  describe('fetchFirewallRules (fail-closed)', () => {
    const fetch = (id: string) => (lifecycle as any).fetchFirewallRules(id)

    it("defaults to 'drop' for a BLOCK_ALL department policy", async () => {
      mockPrisma.getFirewallRulesSplit.mockResolvedValue({ departmentRules: [], vmRules: [] })
      mockPrisma.getDepartmentFirewallPolicy.mockResolvedValue('BLOCK_ALL')
      const r = await fetch(testVmId)
      expect(r.defaultAction).toBe('drop')
    })

    it("defaults to 'drop' for a null / unknown department policy", async () => {
      mockPrisma.getFirewallRulesSplit.mockResolvedValue({ departmentRules: [], vmRules: [] })
      mockPrisma.getDepartmentFirewallPolicy.mockResolvedValue(null)
      const r = await fetch(testVmId)
      expect(r.defaultAction).toBe('drop')
    })

    it("uses 'accept' ONLY for an explicit ALLOW_ALL policy", async () => {
      mockPrisma.getFirewallRulesSplit.mockResolvedValue({ departmentRules: [], vmRules: [] })
      mockPrisma.getDepartmentFirewallPolicy.mockResolvedValue('ALLOW_ALL')
      const r = await fetch(testVmId)
      expect(r.defaultAction).toBe('accept')
    })

    it("treats MACHINE_NOT_FOUND as empty rules with a 'drop' posture (not a throw)", async () => {
      mockPrisma.getFirewallRulesSplit.mockRejectedValue(
        new PrismaAdapterError('no machine', PrismaAdapterErrorCode.MACHINE_NOT_FOUND, testVmId)
      )
      const r = await fetch(testVmId)
      expect(r).toEqual({ department: [], vm: [], defaultAction: 'drop' })
    })

    it('RE-THROWS a real DB error (never returns [] / fails open)', async () => {
      mockPrisma.getFirewallRulesSplit.mockRejectedValue(
        new PrismaAdapterError('db down', PrismaAdapterErrorCode.QUERY_FAILED, testVmId)
      )
      await expect(fetch(testVmId)).rejects.toThrow('db down')
    })

    it('aborts create() when the firewall fetch hits a real DB error', async () => {
      // A DB outage during the firewall fetch must fail the whole create so a VM
      // is never booted without a terminal drop.
      mockPrisma.getDepartmentFirewallPolicy.mockRejectedValue(
        new PrismaAdapterError('db down', PrismaAdapterErrorCode.QUERY_FAILED, testVmId)
      )
      await expect(lifecycle.create(makeCreateConfig())).rejects.toThrow(LifecycleError)
      // applyRules must NOT have been called with an unfiltered posture.
      expect(nftables.applyRules).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // validation — rebuilt on the nested multi-disk config shape
  // ==========================================================================
  describe('config validation', () => {
    it('throws for a display port below the valid range', async () => {
      await expect(lifecycle.create(makeCreateConfig({ displayPort: -1 })))
        .rejects.toThrow(LifecycleError)
    })

    it('throws when the disks array is empty', async () => {
      await expect(lifecycle.create(makeCreateConfig({ disks: [] })))
        .rejects.toThrow(LifecycleError)
    })

    it('throws for an invalid display type', async () => {
      await expect(lifecycle.create(makeCreateConfig({ displayType: 'rdp' as any })))
        .rejects.toThrow(LifecycleError)
    })
  })

  // ==========================================================================
  // MF-3 — start() FAILS CLOSED against the disk-op DB claim
  //
  // The DB status is the authoritative cross-service gate. A row sitting in a
  // backend disk-op marker (backing_up / restoring / snapshotting) — or in any
  // active status (running / suspended / starting) — must NOT be startable: a
  // powerOn racing a backup/restore/snapshot would boot QEMU over the qcow2
  // being rewritten and corrupt it. start() must refuse (throw, no QEMU spawn),
  // not silently skip the optimistic transition.
  // ==========================================================================
  describe('start() fail-closed against disk-op markers (MF-3)', () => {
    beforeEach(() => {
      // Disk images "exist" so a row that WAS startable would proceed all the
      // way to the QEMU spawn — proving any refusal is the status gate, not an
      // earlier disk check.
      fs.existsSync = jest.fn((p: string) => typeof p === 'string' && p.endsWith('.qcow2'))
    })

    // Backend disk-op markers + 'suspended' are NEVER startable: they must be
    // refused outright (throw, no spawn, no transition). 'running'/'starting' are
    // handled by the separate recovery branch below — they too must never spawn a
    // fresh QEMU over a live disk.
    const HARD_REFUSE = ['backing_up', 'restoring', 'snapshotting', 'suspended']
    for (const status of HARD_REFUSE) {
      it(`REFUSES to start a row in '${status}' (no QEMU spawn, no transition)`, async () => {
        mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status }))

        await expect(lifecycle.start(testVmId)).rejects.toThrow(LifecycleError)

        // The qcow2 is never touched: no QEMU process is spawned...
        expect(mockQemuProcess.start).not.toHaveBeenCalled()
        // ...and the row is NOT flipped to 'starting' (the gate refused before
        // any optimistic transition).
        expect(mockPrisma.transitionVMStatus).not.toHaveBeenCalled()
      })
    }

    // 'running'/'starting' with a LIVE, identity-matched PID is a legitimately
    // already-running VM: start() is idempotent (returns success) but must still
    // never spawn a fresh QEMU over the live qcow2.
    for (const status of ['running', 'starting']) {
      it(`does NOT spawn a fresh QEMU for an already-live '${status}' VM (idempotent)`, async () => {
        mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status }))
        // Default mocks: isProcessAlive + pidBelongsToVM => true, so the live-PID
        // recovery branch adopts it as running.
        await lifecycle.start(testVmId)
        expect(mockQemuProcess.start).not.toHaveBeenCalled()
      })
    }

    // 'running'/'starting' with a DEAD PID is a crashed VM: the recovery branch
    // resets the row to 'off', then the authoritative transition starts it — a
    // fresh QEMU spawn IS expected here (not a refusal). This proves the reset
    // path still funnels through the 'off'-gated transition.
    for (const status of ['running', 'starting']) {
      it(`resets a crashed '${status}' VM (dead PID) and starts it through the 'off' gate`, async () => {
        mockPrisma.findMachineWithConfig
          .mockResolvedValueOnce(makeVmRow({ status }))           // initial read
          .mockResolvedValue(makeVmRow({ status: 'off' }))        // re-read after reset
        ;(lifecycle as any).isProcessAlive.mockReturnValue(false)
        await lifecycle.start(testVmId)
        // After reset to 'off', the authoritative transition runs and QEMU spawns.
        expect(mockPrisma.transitionVMStatus).toHaveBeenCalledWith(
          testVmId, 'off', 'starting', expect.any(Number)
        )
        expect(mockQemuProcess.start).toHaveBeenCalled()
      })
    }

    it("throws INVALID_STATE for a disk-op marker ('backing_up')", async () => {
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'backing_up' }))

      await expect(lifecycle.start(testVmId)).rejects.toMatchObject({
        code: LifecycleErrorCode.INVALID_STATE
      })
      expect(mockQemuProcess.start).not.toHaveBeenCalled()
    })

    it('REFUSES (INVALID_STATE) when the status flips under us between read and transition', async () => {
      // Row reads as 'off' (passes the precondition) but a backend grabs it for a
      // disk op before our transaction commits => transitionVMStatus surfaces a
      // status mismatch as UPDATE_FAILED. start() must convert this to a hard
      // refusal, never proceed to spawn QEMU.
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'off' }))
      mockPrisma.transitionVMStatus.mockRejectedValueOnce(
        new PrismaAdapterError(
          "Status conflict: expected 'off', found 'snapshotting'.",
          PrismaAdapterErrorCode.UPDATE_FAILED,
          testVmId,
          { expectedStatus: 'off', currentStatus: 'snapshotting' }
        )
      )

      await expect(lifecycle.start(testVmId)).rejects.toMatchObject({
        code: LifecycleErrorCode.INVALID_STATE
      })
      expect(mockQemuProcess.start).not.toHaveBeenCalled()
    })

    it('REFUSES (CONCURRENT_MODIFICATION) on a version conflict during the transition', async () => {
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'off' }))
      mockPrisma.transitionVMStatus.mockRejectedValueOnce(
        new PrismaAdapterError(
          'Version conflict: expected 1, found 2.',
          PrismaAdapterErrorCode.VERSION_CONFLICT,
          testVmId,
          { expectedVersion: 1, currentVersion: 2 }
        )
      )

      await expect(lifecycle.start(testVmId)).rejects.toMatchObject({
        code: LifecycleErrorCode.CONCURRENT_MODIFICATION
      })
      expect(mockQemuProcess.start).not.toHaveBeenCalled()
    })

    it("PROCEEDS from 'off' (the transition is attempted and QEMU spawns)", async () => {
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'off' }))

      await lifecycle.start(testVmId)

      // 'off' is startable: the transition is attempted with 'off' as the base...
      expect(mockPrisma.transitionVMStatus).toHaveBeenCalledWith(
        testVmId, 'off', 'starting', expect.any(Number)
      )
      // ...and QEMU is actually spawned.
      expect(mockQemuProcess.start).toHaveBeenCalled()
    })

    it("ALLOWS recovery from 'error' (transition attempted from 'error', QEMU spawns)", async () => {
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'error' }))

      await lifecycle.start(testVmId)

      expect(mockPrisma.transitionVMStatus).toHaveBeenCalledWith(
        testVmId, 'error', 'starting', expect.any(Number)
      )
      expect(mockQemuProcess.start).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // MF-4 — the -runas privilege drop is applied uniformly across the lifecycle
  //
  // INFINIZATION_QEMU_USER is the no-migration source for the unprivileged user
  // QEMU drops to via -runas. It must reach the QEMU command at BOTH create()
  // and start() (operator stop/start, restartVM, host-reboot recovery all go
  // through start()) — otherwise every restart relaunches QEMU as ROOT.
  // ==========================================================================
  describe('-runas privilege-drop env fallback (MF-4)', () => {
    const ENV_KEY = 'INFINIZATION_QEMU_USER'
    let savedEnv: string | undefined
    let buildSpy: jest.SpyInstance

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY]
      // Capture the qemuConfig (last arg) handed to buildQemuCommand without
      // disturbing the real builder (the fluent chain still runs).
      buildSpy = jest.spyOn(lifecycle as any, 'buildQemuCommand')
      // start() needs the disk image to "exist" to reach the spawn stage.
      fs.existsSync = jest.fn((p: string) => typeof p === 'string' && p.endsWith('.qcow2'))
    })

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = savedEnv
      buildSpy.mockRestore()
    })

    /** runAsUser actually handed to the QEMU command builder on the last build. */
    function lastRunAsUser (): unknown {
      const calls = buildSpy.mock.calls
      const lastArgs = calls[calls.length - 1]
      const qemuConfig = lastArgs[lastArgs.length - 1]
      return qemuConfig?.runAsUser
    }

    it('create() emits the QEMU command with runAsUser from INFINIZATION_QEMU_USER', async () => {
      process.env[ENV_KEY] = 'qemu-unpriv'
      await lifecycle.create(makeCreateConfig())
      expect(buildSpy).toHaveBeenCalled()
      expect(lastRunAsUser()).toBe('qemu-unpriv')
    })

    it('start() emits the QEMU command with runAsUser from INFINIZATION_QEMU_USER', async () => {
      process.env[ENV_KEY] = 'qemu-unpriv'
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'off' }))
      await lifecycle.start(testVmId)
      expect(buildSpy).toHaveBeenCalled()
      // This is the key MF-4 regression: start() previously set NEITHER, so the
      // drop was lost on every restart and QEMU relaunched as root.
      expect(lastRunAsUser()).toBe('qemu-unpriv')
    })

    it('explicit create config.runAsUser wins over the env (no double-apply / conflict)', async () => {
      process.env[ENV_KEY] = 'env-user'
      await lifecycle.create(makeCreateConfig({ runAsUser: 'explicit-user' } as any))
      expect(lastRunAsUser()).toBe('explicit-user')
    })

    it('leaves runAsUser undefined when the env is unset (current behavior preserved)', async () => {
      delete process.env[ENV_KEY]
      mockPrisma.findMachineWithConfig.mockResolvedValue(makeVmRow({ status: 'off' }))
      await lifecycle.start(testVmId)
      expect(lastRunAsUser()).toBeUndefined()
    })
  })
})
