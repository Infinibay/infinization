/**
 * TEST-01 (HIGH) — Facade coverage for the `Infinization` public API.
 *
 * The facade sat at 0% coverage because every other test exercised the
 * subsystems (VMLifecycle, EventHandler, ...) directly. These tests drive the
 * facade's own wiring: construction, initialize()/shutdown(), the per-vmId
 * serialization lock, delegation to VMLifecycle, device/QGA accessors, and the
 * ensureInitialized() guard — without touching the real QEMU/Prisma/nftables
 * stack. Every subsystem is mocked at the module boundary.
 */

import { Infinization } from '../src/core/Infinization'
import { LifecycleError, LifecycleErrorCode } from '../src/types/lifecycle.types'

// ---------------------------------------------------------------------------
// Module mocks — every subsystem the facade constructs or delegates to.
// ---------------------------------------------------------------------------

jest.mock('../src/core/VMLifecycle')
jest.mock('../src/core/QMPClient')
jest.mock('../src/core/GuestAgentClient')
jest.mock('../src/db/PrismaAdapter')
jest.mock('../src/sync/EventHandler')
jest.mock('../src/sync/HealthMonitor')
jest.mock('../src/network/NftablesService')
jest.mock('../src/system/CgroupsManager')

import { VMLifecycle } from '../src/core/VMLifecycle'
import { PrismaAdapter } from '../src/db/PrismaAdapter'
import { EventHandler } from '../src/sync/EventHandler'
import { HealthMonitor } from '../src/sync/HealthMonitor'
import { NftablesService } from '../src/network/NftablesService'
import { CgroupsManager } from '../src/system/CgroupsManager'
import { QMPClient } from '../src/core/QMPClient'
import { GuestAgentClient } from '../src/core/GuestAgentClient'

const MockedVMLifecycle = VMLifecycle as jest.MockedClass<typeof VMLifecycle>
const MockedPrismaAdapter = PrismaAdapter as jest.MockedClass<typeof PrismaAdapter>
const MockedEventHandler = EventHandler as jest.MockedClass<typeof EventHandler>
const MockedHealthMonitor = HealthMonitor as jest.MockedClass<typeof HealthMonitor>
const MockedNftablesService = NftablesService as jest.MockedClass<typeof NftablesService>
const MockedCgroupsManager = CgroupsManager as jest.MockedClass<typeof CgroupsManager>
const MockedQMPClient = QMPClient as jest.MockedClass<typeof QMPClient>
const MockedGuestAgentClient = GuestAgentClient as jest.MockedClass<typeof GuestAgentClient>

// ---------------------------------------------------------------------------
// Shared fake objects for the mocked subsystem instances.
// ---------------------------------------------------------------------------

function makeFakes () {
  // PrismaAdapter instance methods used by the facade.
  const prismaInstance = {
    getMachineInternalName: jest.fn().mockResolvedValue('vm-internal'),
    findMachine: jest.fn().mockResolvedValue(null)
  }

  // EventHandler instance methods the facade touches.
  const eventHandlerInstance = {
    attachToVM: jest.fn().mockResolvedValue(undefined),
    detachAll: jest.fn().mockResolvedValue(undefined),
    detachFromVM: jest.fn().mockResolvedValue(undefined),
    isAttached: jest.fn().mockReturnValue(false),
    getQMPClient: jest.fn().mockReturnValue(undefined),
    markInstallInProgress: jest.fn(),
    clearInstallInProgress: jest.fn(),
    isInstallInProgress: jest.fn().mockReturnValue(false)
  }

  // HealthMonitor instance methods the facade touches during init/shutdown.
  const emptyReconcile = {
    totalChecked: 0,
    promotedToRunning: [] as string[],
    resetToOff: [] as string[],
    resetToError: [] as string[],
    skipped: [] as string[],
    timestamp: new Date(),
    results: [] as unknown[]
  }
  const healthMonitorInstance = {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    reconcileTransientStates: jest.fn().mockResolvedValue(emptyReconcile)
  }

  // NftablesService instance — initialize() is awaited during init.
  const nftablesInstance = {
    initialize: jest.fn().mockResolvedValue(undefined)
  }

  // CgroupsManager instance — cleanupEmptyScopes() is awaited during init.
  const cgroupsInstance = {
    cleanupEmptyScopes: jest.fn().mockResolvedValue(0)
  }

  // VMLifecycle instance — every delegated op lands here.
  const lifecycleInstance = {
    create: jest.fn().mockResolvedValue({
      vmId: 'vm-1',
      tapDevice: 'vnet0',
      qmpSocketPath: '/run/vm-1.sock',
      displayPort: 5900,
      pid: 4242,
      diskPaths: ['/disks/vm-1.qcow2'],
      pidFilePath: '/run/vm-1.pid',
      success: true as const
    }),
    start: jest.fn().mockResolvedValue({
      success: true,
      message: 'started',
      vmId: 'vm-1',
      timestamp: new Date()
    }),
    stop: jest.fn().mockResolvedValue({
      success: true,
      message: 'stopped',
      vmId: 'vm-1',
      timestamp: new Date()
    }),
    restart: jest.fn().mockResolvedValue({
      success: true,
      message: 'restarted',
      vmId: 'vm-1',
      timestamp: new Date()
    }),
    suspend: jest.fn().mockResolvedValue({
      success: true,
      message: 'suspended',
      vmId: 'vm-1',
      timestamp: new Date()
    }),
    resume: jest.fn().mockResolvedValue({
      success: true,
      message: 'resumed',
      vmId: 'vm-1',
      timestamp: new Date()
    }),
    reset: jest.fn().mockResolvedValue({
      success: true,
      message: 'reset',
      vmId: 'vm-1',
      timestamp: new Date()
    }),
    destroyResources: jest.fn().mockResolvedValue({
      success: true,
      message: 'destroyed',
      vmId: 'vm-1',
      timestamp: new Date()
    }),
    getStatus: jest.fn().mockResolvedValue({
      vmId: 'vm-1',
      status: 'running',
      qmpStatus: 'running',
      pid: 4242,
      uptime: 100,
      processAlive: true,
      consistent: true,
      tapDevice: 'vnet0',
      qmpSocketPath: '/run/vm-1.sock'
    })
  }

  return {
    prismaInstance,
    eventHandlerInstance,
    healthMonitorInstance,
    nftablesInstance,
    cgroupsInstance,
    lifecycleInstance,
    emptyReconcile
  }
}

/**
 * Wires the jest.mock factory results to our fake instances so the facade's
 * `new <Subsystem>(...)` calls return our controlled objects.
 */
function wireFactories (fakes: ReturnType<typeof makeFakes>) {
  MockedPrismaAdapter.mockImplementation(() => fakes.prismaInstance as unknown as PrismaAdapter)
  MockedEventHandler.mockImplementation(() => fakes.eventHandlerInstance as unknown as EventHandler)
  MockedHealthMonitor.mockImplementation(() => fakes.healthMonitorInstance as unknown as HealthMonitor)
  MockedNftablesService.mockImplementation(() => fakes.nftablesInstance as unknown as NftablesService)
  MockedCgroupsManager.mockImplementation(() => fakes.cgroupsInstance as unknown as CgroupsManager)
  MockedVMLifecycle.mockImplementation(() => fakes.lifecycleInstance as unknown as VMLifecycle)
}

// Minimal PrismaClientLike stub — PrismaAdapter is mocked at the module
// boundary, so the fake never executes real Prisma queries. But the config
// field is now typed (PrismaClientLike), so the stub must be structurally valid.
const fakePrismaClient = {
  machine: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  machineConfiguration: {
    upsert: jest.fn(),
    updateMany: jest.fn()
  },
  $transaction: jest.fn()
} as const

const baseConfig = {
  prismaClient: fakePrismaClient,
  autoStartHealthMonitor: true
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Infinization facade — construction & lifecycle', () => {
  let fakes: ReturnType<typeof makeFakes>

  beforeEach(() => {
    fakes = makeFakes()
    wireFactories(fakes)
  })

  it('constructs without initializing', () => {
    const inf = new Infinization(baseConfig)
    expect(inf.isInitialized()).toBe(false)
  })

  it('initialize() wires subsystems, reconciles, and starts the health monitor', async () => {
    const inf = new Infinization(baseConfig)
    await inf.initialize()

    expect(inf.isInitialized()).toBe(true)
    expect(MockedPrismaAdapter).toHaveBeenCalledTimes(1)
    expect(MockedEventHandler).toHaveBeenCalledTimes(1)
    expect(MockedHealthMonitor).toHaveBeenCalledTimes(1)
    expect(MockedNftablesService).toHaveBeenCalledTimes(1)

    // nftables must be initialized before health monitor starts.
    expect(fakes.nftablesInstance.initialize).toHaveBeenCalledTimes(1)
    expect(fakes.healthMonitorInstance.reconcileTransientStates).toHaveBeenCalledTimes(1)
    expect(fakes.cgroupsInstance.cleanupEmptyScopes).toHaveBeenCalledTimes(1)
    expect(fakes.healthMonitorInstance.start).toHaveBeenCalledTimes(1)
  })

  it('initialize() skips the health monitor when autoStartHealthMonitor=false', async () => {
    const inf = new Infinization({ ...baseConfig, autoStartHealthMonitor: false })
    await inf.initialize()

    expect(inf.isInitialized()).toBe(true)
    expect(fakes.healthMonitorInstance.start).not.toHaveBeenCalled()
  })

  it('initialize() is idempotent — a second call is a no-op', async () => {
    const inf = new Infinization(baseConfig)
    await inf.initialize()
    await inf.initialize()

    // Each subsystem constructed exactly once across both calls.
    expect(MockedPrismaAdapter).toHaveBeenCalledTimes(1)
    expect(fakes.healthMonitorInstance.start).toHaveBeenCalledTimes(1)
  })

  it('initialize() throws LifecycleError when prismaClient is missing', async () => {
    const inf = new Infinization({ prismaClient: undefined } as any)
    await expect(inf.initialize()).rejects.toThrow(LifecycleError)
    await expect(inf.initialize()).rejects.toMatchObject({
      code: LifecycleErrorCode.INVALID_CONFIG
    })
    expect(inf.isInitialized()).toBe(false)
  })

  // Multi-node Phase 1: a compute-node agent injects a remote database facade
  // (RpcDatabaseAdapter) instead of a Prisma client, so the node holds no DB.
  const makeFakeDbAdapter = (): any => {
    const methods = [
      'findMachine', 'findMachineByInternalName', 'findMachineWithConfig', 'findRunningVMs',
      'findMachinesByStatuses', 'updateMachineStatus', 'updateMachineConfiguration', 'transitionVMStatus',
      'clearMachineConfiguration', 'clearVolatileMachineConfiguration', 'getMachineInternalName',
      'getMachineDiskPath', 'getFirewallRules', 'getFirewallRulesSplit', 'getDepartmentFirewallPolicy',
      'getFirewallRuleSetId'
    ]
    return Object.fromEntries(methods.map(m => [m, jest.fn()]))
  }

  it('initialize() uses an injected databaseAdapter and builds NO PrismaAdapter (agent path)', async () => {
    const dbAdapter = makeFakeDbAdapter()
    const inf = new Infinization({ databaseAdapter: dbAdapter, autoStartHealthMonitor: false } as any)
    await inf.initialize()

    expect(inf.isInitialized()).toBe(true)
    expect(MockedPrismaAdapter).not.toHaveBeenCalled()
    expect(inf.getPrismaAdapter()).toBe(dbAdapter)
  })

  it('initialize() rejects when BOTH databaseAdapter and prismaClient are provided', async () => {
    const inf = new Infinization({ prismaClient: fakePrismaClient, databaseAdapter: makeFakeDbAdapter() } as any)
    await expect(inf.initialize()).rejects.toMatchObject({ code: LifecycleErrorCode.INVALID_CONFIG })
    expect(inf.isInitialized()).toBe(false)
  })

  it('initialize() rethrows a subsystem initialization failure', async () => {
    fakes.nftablesInstance.initialize.mockRejectedValueOnce(new Error('nftables down'))
    const inf = new Infinization(baseConfig)
    await expect(inf.initialize()).rejects.toThrow('nftables down')
    expect(inf.isInitialized()).toBe(false)
  })

  it('initialize() continues when the startup reconcile throws (best-effort)', async () => {
    fakes.healthMonitorInstance.reconcileTransientStates.mockRejectedValueOnce(new Error('reconcile boom'))
    const inf = new Infinization(baseConfig)
    // Must NOT reject — reconcile failures are swallowed and logged.
    await inf.initialize()
    expect(inf.isInitialized()).toBe(true)
  })

  it('initialize() continues when cgroup reclaim throws (best-effort)', async () => {
    fakes.cgroupsInstance.cleanupEmptyScopes.mockRejectedValueOnce(new Error('cgroup boom'))
    const inf = new Infinization(baseConfig)
    await inf.initialize()
    expect(inf.isInitialized()).toBe(true)
  })

  it('onCrashDetected callback deletes the active-VM entry and emits a CRUD event', async () => {
    const emitCRUD = jest.fn()
    const inf = new Infinization({ ...baseConfig, eventManager: { emitCRUD } })
    await inf.initialize()
    // Simulate a tracked VM then a crash callback.
    inf.getActiveVMs() // sanity: empty
    // We cannot directly call the private callback; instead drive it via the
    // HealthMonitor mock's onCrashDetected option capture.
    const opts = MockedHealthMonitor.mock.calls[0][1] as { onCrashDetected: (vmId: string) => Promise<void> }
    await opts.onCrashDetected('crashed-vm')
    expect(emitCRUD).toHaveBeenCalledWith('machines', 'crash', 'crashed-vm')
  })

  it('shutdown() stops the monitor, detaches handlers, and clears state', async () => {
    const inf = new Infinization(baseConfig)
    await inf.initialize()
    await inf.shutdown()

    expect(fakes.healthMonitorInstance.stop).toHaveBeenCalledTimes(1)
    expect(fakes.eventHandlerInstance.detachAll).toHaveBeenCalledTimes(1)
    expect(inf.isInitialized()).toBe(false)
  })

  it('shutdown() is safe when called before initialize()', async () => {
    const inf = new Infinization(baseConfig)
    // No subsystem instances exist yet — shutdown must not throw.
    await expect(inf.shutdown()).resolves.toBeUndefined()
  })
})

describe('Infinization facade — ensureInitialized guard', () => {
  let fakes: ReturnType<typeof makeFakes>

  beforeEach(() => {
    fakes = makeFakes()
    wireFactories(fakes)
  })

  // `async` arrows are essential here: the accessor methods
  // (getHealthMonitor/getEventHandler/getPrismaAdapter/getNftablesService)
  // throw SYNCHRONOUSLY. An async arrow converts a sync throw into a rejected
  // promise so `rejects.toMatchObject` can observe it uniformly.
  const guardedMethods = [
    { name: 'createVM', call: async (inf: Infinization) => inf.createVM({ vmId: 'x' } as any) },
    { name: 'startVM', call: async (inf: Infinization) => inf.startVM('x') },
    { name: 'stopVM', call: async (inf: Infinization) => inf.stopVM('x') },
    { name: 'destroyVM', call: async (inf: Infinization) => inf.destroyVM('x') },
    { name: 'restartVM', call: async (inf: Infinization) => inf.restartVM('x') },
    { name: 'suspendVM', call: async (inf: Infinization) => inf.suspendVM('x') },
    { name: 'resumeVM', call: async (inf: Infinization) => inf.resumeVM('x') },
    { name: 'resetVM', call: async (inf: Infinization) => inf.resetVM('x') },
    { name: 'getVMStatus', call: async (inf: Infinization) => inf.getVMStatus('x') },
    { name: 'getHealthMonitor', call: async (inf: Infinization) => inf.getHealthMonitor() },
    { name: 'getEventHandler', call: async (inf: Infinization) => inf.getEventHandler() },
    { name: 'getPrismaAdapter', call: async (inf: Infinization) => inf.getPrismaAdapter() },
    { name: 'getNftablesService', call: async (inf: Infinization) => inf.getNftablesService() }
  ]

  it.each(guardedMethods)(
    '%s() throws LifecycleError(INVALID_STATE) before initialize()',
    async ({ call }) => {
      const inf = new Infinization(baseConfig)
      await expect(call(inf)).rejects.toMatchObject({
        code: LifecycleErrorCode.INVALID_STATE
      })
    }
  )

  it('attachToRunningVM() throws before initialize()', async () => {
    const inf = new Infinization(baseConfig)
    await expect(inf.attachToRunningVM('x', '/sock')).rejects.toMatchObject({
      code: LifecycleErrorCode.INVALID_STATE
    })
  })

  it('guestExec() throws before initialize()', async () => {
    const inf = new Infinization(baseConfig)
    await expect(inf.guestExec('x', '/sock', 'ls')).rejects.toMatchObject({
      code: LifecycleErrorCode.INVALID_STATE
    })
  })
})

describe('Infinization facade — VM operation delegation', () => {
  let fakes: ReturnType<typeof makeFakes>
  let inf: Infinization

  beforeEach(async () => {
    fakes = makeFakes()
    wireFactories(fakes)
    inf = new Infinization(baseConfig)
    await inf.initialize()
    MockedVMLifecycle.mockClear()
    MockedVMLifecycle.mockImplementation(() => fakes.lifecycleInstance as unknown as VMLifecycle)
  })

  it('createVM() delegates to VMLifecycle.create() and tracks the VM', async () => {
    const result = await inf.createVM({
      vmId: 'vm-1',
      name: 'vm',
      internalName: 'vm-internal',
      os: 'ubuntu',
      cpuCores: 2,
      ramGB: 4,
      disks: [{ sizeGB: 10 }],
      bridge: 'virbr0',
      displayType: 'spice',
      displayPort: 5900
    } as any)

    expect(fakes.lifecycleInstance.create).toHaveBeenCalledTimes(1)
    expect(result.vmId).toBe('vm-1')
    expect(inf.getActiveVMs()).toContain('vm-1')
  })

  it('startVM() delegates and tracks the VM on success', async () => {
    await inf.startVM('vm-1')
    expect(fakes.lifecycleInstance.start).toHaveBeenCalledTimes(1)
    expect(inf.getActiveVMs()).toContain('vm-1')
  })

  it('stopVM() delegates and untracks the VM on success', async () => {
    // Track first so untrack has something to remove.
    await inf.startVM('vm-1')
    expect(inf.getActiveVMs()).toContain('vm-1')

    await inf.stopVM('vm-1')
    expect(fakes.lifecycleInstance.stop).toHaveBeenCalledTimes(1)
    expect(inf.getActiveVMs()).not.toContain('vm-1')
  })

  it('destroyVM() delegates to destroyResources() and untracks', async () => {
    await inf.startVM('vm-1')
    await inf.destroyVM('vm-1')
    expect(fakes.lifecycleInstance.destroyResources).toHaveBeenCalledTimes(1)
    expect(inf.getActiveVMs()).not.toContain('vm-1')
  })

  it.each([
    ['restartVM', 'restart'],
    ['suspendVM', 'suspend'],
    ['resumeVM', 'resume'],
    ['resetVM', 'reset']
  ] as const)(
    '%s() delegates to VMLifecycle.%s()',
    async (facadeMethod, lifecycleMethod) => {
      await (inf as any)[facadeMethod]('vm-1')
      expect((fakes.lifecycleInstance as any)[lifecycleMethod]).toHaveBeenCalledTimes(1)
    }
  )

  it('getVMStatus() delegates to VMLifecycle.getStatus()', async () => {
    const status = await inf.getVMStatus('vm-1')
    expect(fakes.lifecycleInstance.getStatus).toHaveBeenCalledTimes(1)
    expect(status.vmId).toBe('vm-1')
  })

  it('reconcileStartupState() delegates to HealthMonitor.reconcileTransientStates()', async () => {
    await inf.reconcileStartupState()
    expect(fakes.healthMonitorInstance.reconcileTransientStates).toHaveBeenCalled()
  })

  it('reconcileStartupState(statuses) forwards custom statuses', async () => {
    await inf.reconcileStartupState(['custom-status'])
    expect(fakes.healthMonitorInstance.reconcileTransientStates).toHaveBeenCalledWith(['custom-status'])
  })
})

describe('Infinization facade — per-vmId serialization lock', () => {
  let fakes: ReturnType<typeof makeFakes>
  let inf: Infinization

  beforeEach(async () => {
    fakes = makeFakes()
    wireFactories(fakes)
    inf = new Infinization(baseConfig)
    await inf.initialize()
    MockedVMLifecycle.mockClear()
    MockedVMLifecycle.mockImplementation(() => fakes.lifecycleInstance as unknown as VMLifecycle)
  })

  it('serializes concurrent operations on the SAME vmId', async () => {
    // Make each stop() slow so concurrent calls overlap unless serialized.
    let active = 0
    let maxOverlap = 0
    fakes.lifecycleInstance.stop.mockImplementation(async () => {
      active++
      maxOverlap = Math.max(maxOverlap, active)
      await new Promise(r => setTimeout(r, 30))
      active--
      return { success: true, message: 'ok', vmId: 'vm-1', timestamp: new Date() }
    })

    // Fire 5 concurrent stops on the same VM.
    await Promise.all(Array.from({ length: 5 }, () => inf.stopVM('vm-1')))

    // If serialized, only one stop runs at a time => maxOverlap === 1.
    expect(maxOverlap).toBe(1)
    expect(fakes.lifecycleInstance.stop).toHaveBeenCalledTimes(5)
  })

  it('runs different vmIds concurrently (no cross-VM blocking)', async () => {
    let active = 0
    let maxOverlap = 0
    fakes.lifecycleInstance.stop.mockImplementation(async () => {
      active++
      maxOverlap = Math.max(maxOverlap, active)
      await new Promise(r => setTimeout(r, 30))
      active--
      return { success: true, message: 'ok', vmId: 'any', timestamp: new Date() }
    })

    await Promise.all([
      inf.stopVM('vm-a'),
      inf.stopVM('vm-b'),
      inf.stopVM('vm-c')
    ])

    expect(maxOverlap).toBe(3)
  })
})

describe('Infinization facade — device & QGA operations', () => {
  let fakes: ReturnType<typeof makeFakes>
  let inf: Infinization

  beforeEach(async () => {
    fakes = makeFakes()
    wireFactories(fakes)
    inf = new Infinization(baseConfig)
    await inf.initialize()
  })

  it('ejectCdrom() throws VM_NOT_FOUND when no QMP client is attached', async () => {
    fakes.eventHandlerInstance.getQMPClient.mockReturnValue(undefined)
    await expect(inf.ejectCdrom('vm-1', 'ide0-cd0')).rejects.toMatchObject({
      code: LifecycleErrorCode.VM_NOT_FOUND
    })
  })

  it('ejectCdrom() delegates to the attached QMP client', async () => {
    const qmpClient = { eject: jest.fn().mockResolvedValue(undefined) }
    fakes.eventHandlerInstance.getQMPClient.mockReturnValue(qmpClient)
    await inf.ejectCdrom('vm-1', 'ide0-cd0')
    expect(qmpClient.eject).toHaveBeenCalledWith('ide0-cd0', true)
  })

  it('queryBlockDevices() throws VM_NOT_FOUND when no QMP client is attached', async () => {
    fakes.eventHandlerInstance.getQMPClient.mockReturnValue(undefined)
    await expect(inf.queryBlockDevices('vm-1')).rejects.toMatchObject({
      code: LifecycleErrorCode.VM_NOT_FOUND
    })
  })

  it('queryBlockDevices() delegates to the attached QMP client', async () => {
    const blocks = [{ device: 'drive0' }]
    const qmpClient = { queryBlock: jest.fn().mockResolvedValue(blocks) }
    fakes.eventHandlerInstance.getQMPClient.mockReturnValue(qmpClient)
    const result = await inf.queryBlockDevices('vm-1')
    expect(result).toBe(blocks)
  })

  it('getQMPClient() returns the EventHandler-tracked client', () => {
    const qmpClient = { id: 'qmp-1' }
    fakes.eventHandlerInstance.getQMPClient.mockReturnValue(qmpClient)
    expect(inf.getQMPClient('vm-1')).toBe(qmpClient)
  })

  it('guestExec() opens a transient GuestAgentClient, runs, and disconnects', async () => {
    const gacInstance = {
      connect: jest.fn().mockResolvedValue(undefined),
      guestExec: jest.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    MockedGuestAgentClient.mockImplementation(() => gacInstance as unknown as GuestAgentClient)

    const result = await inf.guestExec('vm-1', '/ga.sock', 'whoami')

    expect(MockedGuestAgentClient).toHaveBeenCalledWith('/ga.sock')
    expect(gacInstance.connect).toHaveBeenCalledTimes(1)
    expect(gacInstance.guestExec).toHaveBeenCalledWith('whoami', undefined, undefined)
    expect(gacInstance.disconnect).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 })
  })

  it('guestExec() disconnects the QGA client even on command failure', async () => {
    const gacInstance = {
      connect: jest.fn().mockResolvedValue(undefined),
      guestExec: jest.fn().mockRejectedValue(new Error('guest timeout')),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    MockedGuestAgentClient.mockImplementation(() => gacInstance as unknown as GuestAgentClient)

    await expect(inf.guestExec('vm-1', '/ga.sock', 'ls')).rejects.toThrow('guest timeout')
    // finally{} block must still disconnect.
    expect(gacInstance.disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('Infinization facade — attachToRunningVM', () => {
  let fakes: ReturnType<typeof makeFakes>
  let inf: Infinization

  beforeEach(async () => {
    fakes = makeFakes()
    wireFactories(fakes)
    inf = new Infinization(baseConfig)
    await inf.initialize()
  })

  it('is a no-op when the EventHandler reports the VM already attached', async () => {
    fakes.eventHandlerInstance.isAttached.mockReturnValue(true)
    const qmpInstance = { connect: jest.fn().mockResolvedValue(undefined), disconnect: jest.fn().mockResolvedValue(undefined) }
    MockedQMPClient.mockImplementation(() => qmpInstance as unknown as QMPClient)

    await inf.attachToRunningVM('vm-1', '/sock')

    expect(fakes.eventHandlerInstance.attachToVM).not.toHaveBeenCalled()
    expect(inf.getActiveVMs()).not.toContain('vm-1')
  })

  it('connects QMP, attaches the event handler, and tracks the VM', async () => {
    const qmpInstance = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    MockedQMPClient.mockImplementation(() => qmpInstance as unknown as QMPClient)
    fakes.eventHandlerInstance.isAttached.mockReturnValue(false)

    await inf.attachToRunningVM('vm-1', '/sock')

    expect(MockedQMPClient).toHaveBeenCalledWith('/sock')
    expect(qmpInstance.connect).toHaveBeenCalledTimes(1)
    expect(fakes.eventHandlerInstance.attachToVM).toHaveBeenCalledWith('vm-1', expect.anything())
    expect(inf.getActiveVMs()).toContain('vm-1')
  })

  it('disconnects the QMP client when EventHandler.attachToVM() throws', async () => {
    const qmpInstance = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    MockedQMPClient.mockImplementation(() => qmpInstance as unknown as QMPClient)
    fakes.eventHandlerInstance.isAttached.mockReturnValue(false)
    fakes.eventHandlerInstance.attachToVM.mockRejectedValueOnce(new Error('listener boom'))

    await expect(inf.attachToRunningVM('vm-1', '/sock')).rejects.toThrow('listener boom')
    // The facade must clean up the dangling QMP connection it opened.
    expect(qmpInstance.disconnect).toHaveBeenCalledTimes(1)
    expect(inf.getActiveVMs()).not.toContain('vm-1')
  })

  it('rethrows a QMP connect() failure', async () => {
    const qmpInstance = {
      connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      disconnect: jest.fn().mockResolvedValue(undefined)
    }
    MockedQMPClient.mockImplementation(() => qmpInstance as unknown as QMPClient)

    await expect(inf.attachToRunningVM('vm-1', '/sock')).rejects.toThrow('ECONNREFUSED')
    expect(fakes.eventHandlerInstance.attachToVM).not.toHaveBeenCalled()
  })
})
