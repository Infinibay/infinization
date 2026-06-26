/**
 * CgroupsManager.spec.ts — exercises the REAL cpuset/mems/online-CPU/delegation
 * logic against a temp-dir-backed fake cgroup + sysfs tree (no root, no live
 * kernel). The base paths are injected via the CgroupsManagerOptions constructor
 * option added for testability (audit L114).
 *
 * Coverage:
 *   - parseCpuList range expansion ('0-3,8,10-11')                 [CpuListUtils]
 *   - getMemoryNodesForCores with two node dirs                    [via applyCpuPinning]
 *   - validateCores using the ONLINE set vs sparse/offline cpus
 *   - setCpuAffinity writes cpuset.cpus BEFORE cpuset.mems         [write-order spy]
 *   - ensureInfinizationSlice ALWAYS delegates +cpuset even when the slice
 *     pre-exists (audit L210)
 */

// Record the order/targets of fs/promises mutations by wrapping the REAL module.
// (jest.spyOn cannot redefine the non-configurable fs/promises named exports on
// Node 22, so we mock the module with a passthrough that appends to a shared
// log array the tests can inspect.)
const fsWriteLog: string[] = []
const fsRmdirLog: string[] = []
jest.mock('fs/promises', () => {
  const real = jest.requireActual('fs/promises')
  return {
    ...real,
    writeFile: jest.fn(async (file: any, data: any, ...rest: any[]) => {
      fsWriteLog.push(String(file))
      return real.writeFile(file, data, ...rest)
    }),
    rmdir: jest.fn(async (dir: any, ...rest: any[]) => {
      fsRmdirLog.push(String(dir))
      // Real cgroup rmdir succeeds even with virtual interface files present; the
      // fake tree has real files, so clear the dir first to mimic that semantics.
      try {
        const entries = await real.readdir(dir)
        await Promise.all(entries.map((e: string) => real.rm(path.join(String(dir), e), { force: true })))
      } catch { /* ignore */ }
      return real.rmdir(dir, ...rest)
    })
  }
})

import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { CgroupsManager } from '../src/system/CgroupsManager'
import { parseCpuList } from '../src/cpu/CpuListUtils'

// ---------------------------------------------------------------------------
// Fake-tree helpers
// ---------------------------------------------------------------------------

interface FakeTree {
  root: string
  cgroupBase: string
  slice: string
  onlineFile: string
  nodeBase: string
  manager: CgroupsManager
}

/**
 * Builds a temp-dir cgroup-v2 + sysfs tree with the controller files cgroups
 * detection requires, then returns a CgroupsManager pointed at it.
 *
 * @param online        cpu-list written to the fake online file (e.g. '0-3,8-11')
 * @param nodeCpulists  map of NUMA node id -> cpu-list for /node<id>/cpulist
 * @param createSlice   whether to pre-create the infinization.slice directory
 */
async function buildTree (opts: {
  online: string
  nodeCpulists: Record<number, string>
  createSlice?: boolean
}): Promise<FakeTree> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cgmgr-'))
  const cgroupBase = path.join(root, 'cgroup')
  const slice = path.join(cgroupBase, 'infinization.slice')
  const nodeBase = path.join(root, 'node')
  const onlineFile = path.join(root, 'online')

  await fsp.mkdir(cgroupBase, { recursive: true })
  // cgroups v2 detection: controllers file must exist and list cpuset.
  await fsp.writeFile(path.join(cgroupBase, 'cgroup.controllers'), 'cpuset cpu io memory\n')
  // subtree_control starts empty (so delegation must write +cpuset).
  await fsp.writeFile(path.join(cgroupBase, 'cgroup.subtree_control'), '')

  await fsp.writeFile(onlineFile, opts.online + '\n')

  await fsp.mkdir(nodeBase, { recursive: true })
  for (const [nodeId, cpulist] of Object.entries(opts.nodeCpulists)) {
    const dir = path.join(nodeBase, `node${nodeId}`)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'cpulist'), cpulist + '\n')
  }

  if (opts.createSlice) {
    await fsp.mkdir(slice, { recursive: true })
    await fsp.writeFile(path.join(slice, 'cgroup.subtree_control'), '')
  }

  const manager = new CgroupsManager({
    cgroupsV2Base: cgroupBase,
    infinizationSlice: slice,
    onlineCpusPath: onlineFile,
    nodeSysfsBase: nodeBase
  })

  return { root, cgroupBase, slice, onlineFile, nodeBase, manager }
}

/**
 * Pre-creates a qemu scope dir with the kernel-style cpuset.cpus / cpuset.mems /
 * cgroup.procs interface files the real kernel would materialize once cpuset is
 * delegated. createCgroupScope() early-returns when the dir exists, leaving
 * these intact for setCpuAffinity() / movePidToCgroup() to write.
 */
async function seedScope (slice: string, pid: number): Promise<string> {
  const scope = path.join(slice, `qemu-${pid}.scope`)
  await fsp.mkdir(scope, { recursive: true })
  await fsp.writeFile(path.join(scope, 'cpuset.cpus'), '')
  await fsp.writeFile(path.join(scope, 'cpuset.mems'), '')
  await fsp.writeFile(path.join(scope, 'cgroup.procs'), '')
  return scope
}

beforeEach(() => {
  fsWriteLog.length = 0
  fsRmdirLog.length = 0
})

afterEach(() => {
  jest.clearAllMocks()
})

// ---------------------------------------------------------------------------
// parseCpuList
// ---------------------------------------------------------------------------

describe('parseCpuList', () => {
  it('expands a mixed range list "0-3,8,10-11"', () => {
    expect(Array.from(parseCpuList('0-3,8,10-11')).sort((a, b) => a - b))
      .toEqual([0, 1, 2, 3, 8, 10, 11])
  })

  it('handles single ids, whitespace and empty fields', () => {
    expect(Array.from(parseCpuList(' 5 , ,7 ')).sort((a, b) => a - b)).toEqual([5, 7])
  })

  it('returns an empty set for an empty string', () => {
    expect(parseCpuList('').size).toBe(0)
  })

  it('skips inverted ranges (start > end)', () => {
    expect(Array.from(parseCpuList('5-3,9'))).toEqual([9])
  })
})

// ---------------------------------------------------------------------------
// validateCores against the ONLINE set
// ---------------------------------------------------------------------------

describe('validateCores (online set)', () => {
  it('accepts only ONLINE cpus on a sparse host (0-3,8-11)', async () => {
    const { manager } = await buildTree({
      online: '0-3,8-11',
      nodeCpulists: { 0: '0-3,8-11' }
    })
    await expect(manager.validateCores([0, 3, 8, 11])).resolves.toBeUndefined()
  })

  it('REJECTS a present-but-offline cpu (id in the gap, e.g. 5)', async () => {
    const { manager } = await buildTree({
      online: '0-3,8-11',
      nodeCpulists: { 0: '0-3,8-11' }
    })
    await expect(manager.validateCores([0, 5])).rejects.toThrow(/Invalid CPU cores|5/)
  })

  it('rejects negative core ids regardless of the online set', async () => {
    const { manager } = await buildTree({
      online: '0-7',
      nodeCpulists: { 0: '0-7' }
    })
    await expect(manager.validateCores([-1])).rejects.toThrow(/negative/i)
  })

  it('falls back to a count-based range when the online file is unreadable', async () => {
    const { manager, onlineFile } = await buildTree({
      online: '0-3',
      nodeCpulists: { 0: '0-3' }
    })
    await fsp.rm(onlineFile)
    // Fallback uses getHostCpuCount() (nproc / cpuinfo) — assert it does not throw
    // for core 0, which exists on any host running the test.
    await expect(manager.validateCores([0])).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// applyCpuPinning end-to-end: cpus-before-mems + correct NUMA node derivation
// ---------------------------------------------------------------------------

describe('applyCpuPinning (cpuset.cpus + cpuset.mems)', () => {
  it('writes cpuset.cpus BEFORE cpuset.mems', async () => {
    const { manager, slice } = await buildTree({
      online: '0-3',
      nodeCpulists: { 0: '0-3' },
      createSlice: true
    })
    await seedScope(slice, 4242)

    const result = await manager.applyCpuPinning(4242, [0, 1])
    expect(result.applied).toBe(true)

    const cpusIdx = fsWriteLog.findIndex(f => f.endsWith('cpuset.cpus'))
    const memsIdx = fsWriteLog.findIndex(f => f.endsWith('cpuset.mems'))
    expect(cpusIdx).toBeGreaterThanOrEqual(0)
    expect(memsIdx).toBeGreaterThanOrEqual(0)
    expect(cpusIdx).toBeLessThan(memsIdx)
  })

  it('derives cpuset.mems from the owning NUMA node (two node dirs)', async () => {
    // Cores 4,5 live on node1; node0 owns 0-3. mems must be "1", not "0".
    const { manager, slice } = await buildTree({
      online: '0-7',
      nodeCpulists: { 0: '0-3', 1: '4-7' },
      createSlice: true
    })
    const scope = await seedScope(slice, 4243)

    const result = await manager.applyCpuPinning(4243, [4, 5])
    expect(result.applied).toBe(true)

    const cpus = (await fsp.readFile(path.join(scope, 'cpuset.cpus'), 'utf8')).trim()
    const mems = (await fsp.readFile(path.join(scope, 'cpuset.mems'), 'utf8')).trim()
    expect(cpus).toBe('4,5')
    expect(mems).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// L210: ensureInfinizationSlice ALWAYS delegates +cpuset, even pre-existing slice
// ---------------------------------------------------------------------------

describe('ensureInfinizationSlice delegation (L210)', () => {
  it('writes +cpuset to root subtree_control even when the slice already exists', async () => {
    const { manager, cgroupBase, slice } = await buildTree({
      online: '0-3',
      nodeCpulists: { 0: '0-3' },
      createSlice: true // slice pre-exists -> the old code would early-return and skip delegation
    })
    await seedScope(slice, 4244)

    const rootSubtree = path.join(cgroupBase, 'cgroup.subtree_control')
    // Precondition: cpuset NOT yet delegated.
    expect((await fsp.readFile(rootSubtree, 'utf8'))).not.toContain('cpuset')

    const result = await manager.applyCpuPinning(4244, [0])
    expect(result.applied).toBe(true)

    // The fake +cpuset write is captured below; the real kernel appends the
    // controller, our fake file just records the last write. Assert the manager
    // attempted the delegation write.
    const after = await fsp.readFile(rootSubtree, 'utf8')
    expect(after).toContain('cpuset')
  })
})

// ---------------------------------------------------------------------------
// cleanupEmptyScopes safety contract (CROSS-UNIT CONTRACT for CORE3)
// ---------------------------------------------------------------------------

describe('cleanupEmptyScopes (safe-to-call contract)', () => {
  it('returns 0 and does not throw when the slice does not exist', async () => {
    const { manager } = await buildTree({ online: '0-3', nodeCpulists: { 0: '0-3' } })
    await expect(manager.cleanupEmptyScopes()).resolves.toBe(0)
  })

  it('removes only EMPTY scopes and leaves occupied ones', async () => {
    const { manager, slice } = await buildTree({
      online: '0-3',
      nodeCpulists: { 0: '0-3' },
      createSlice: true
    })
    const emptyScope = path.join(slice, 'qemu-111.scope')
    const busyScope = path.join(slice, 'qemu-222.scope')
    await fsp.mkdir(emptyScope, { recursive: true })
    await fsp.writeFile(path.join(emptyScope, 'cgroup.procs'), '')
    await fsp.mkdir(busyScope, { recursive: true })
    await fsp.writeFile(path.join(busyScope, 'cgroup.procs'), '222\n')

    const cleaned = await manager.cleanupEmptyScopes()
    expect(cleaned).toBe(1)
    expect(fs.existsSync(emptyScope)).toBe(false)
    expect(fs.existsSync(busyScope)).toBe(true)
  })

  it('swallows its own errors and is idempotent (second call is a no-op 0)', async () => {
    const { manager } = await buildTree({
      online: '0-3',
      nodeCpulists: { 0: '0-3' },
      createSlice: true
    })
    await expect(manager.cleanupEmptyScopes()).resolves.toBe(0)
    await expect(manager.cleanupEmptyScopes()).resolves.toBe(0)
  })
})
