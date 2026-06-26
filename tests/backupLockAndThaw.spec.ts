/**
 * Regression tests for the backup data-protection re-audit fixes:
 *
 *   MF-2 — fsfreeze without a guaranteed thaw wedges the guest. A client-side
 *          timeout can REJECT fsFreeze() AFTER the guest already froze; the
 *          agent must still be thawed + disconnected (no frozen guest, no
 *          leaked FD), and there must be no double-thaw.
 *   SF-1 — deleteBackup's `qemu-img snapshot -d`, the transient-snapshot CREATE,
 *          and the transient-snapshot DELETE must all run UNDER the per-image
 *          lock so a retention sweep cannot race a scheduled createBackup of the
 *          same disk.
 *   LOW  — restoreDiskFile must lock on the CANONICAL image key (resolved path),
 *          matching every other imageLock site.
 *   LOW  — an INCREMENTAL restore whose backup dir was MOVED (stale embedded
 *          backing path) must rebase the overlay copy onto the re-rooted parent
 *          before convert, instead of failing mid-convert.
 *
 * These run WITHOUT qemu-img: the qemu-img / snapshot collaborators are mocked
 * and the filesystem layout (manifests) is created in a real tmp dir.
 */
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve as resolvePath } from 'path'

import { BackupService } from '../src/backup/BackupService'
import {
  BackupType,
  BackupStatus,
  BackupCompression,
  BackupError,
  BackupErrorCode,
  BackupMetadata,
  BACKUP_MANIFEST_FILENAME
} from '../src/types/backup.types'

// ---------------------------------------------------------------------------
// Helpers (mirrors tests/backupDataProtection.spec.ts)
// ---------------------------------------------------------------------------

async function tmpRoot (): Promise<string> {
  return mkdtemp(join(tmpdir(), 'infz-backup-lock-test-'))
}

async function writeManifest (root: string, m: BackupMetadata): Promise<void> {
  const dir = join(root, m.vmId, m.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, BACKUP_MANIFEST_FILENAME), JSON.stringify(m, null, 2), 'utf-8')
}

function baseMeta (over: Partial<BackupMetadata> & Pick<BackupMetadata, 'id' | 'vmId'>): BackupMetadata {
  return {
    type: BackupType.FULL,
    status: BackupStatus.COMPLETED,
    createdAt: new Date().toISOString(),
    disks: [],
    totalSize: 0,
    totalOriginalSize: 0,
    compression: BackupCompression.NONE,
    ...over
  }
}

function fakeCollaborators () {
  const calls: Record<string, any[][]> = {
    getImageInfo: [], convertImage: [], checkImage: [],
    createSnapshot: [], revertSnapshot: [], materializeSnapshot: [], deleteSnapshot: [], execute: []
  }
  const qemuImg: any = {
    getImageInfo: jest.fn(async (p: string) => { calls.getImageInfo.push([p]); return { format: 'qcow2', virtualSize: 1024, actualSize: 512 } }),
    convertImage: jest.fn(async (o: any) => { calls.convertImage.push([o]); await writeFile(o.destPath, 'IMG') }),
    checkImage: jest.fn(async (p: string) => { calls.checkImage.push([p]); return { errors: 0, leaks: 0, corruptions: 0, totalClusters: 1, allocatedClusters: 1 } })
  }
  const snapshotMgr: any = {
    createSnapshot: jest.fn(async (o: any) => { calls.createSnapshot.push([o]) }),
    revertSnapshot: jest.fn(async (i: string, n: string) => { calls.revertSnapshot.push([i, n]) }),
    materializeSnapshot: jest.fn(async (s: string, n: string, d: string) => { calls.materializeSnapshot.push([s, n, d]); await writeFile(d, 'SNAP') }),
    deleteSnapshot: jest.fn(async (i: string, n: string) => { calls.deleteSnapshot.push([i, n]) })
  }
  const executor: any = {
    execute: jest.fn(async (cmd: string, args: string[]) => { calls.execute.push([cmd, args]); return '' })
  }
  return { qemuImg, snapshotMgr, executor, calls }
}

function makeService (root: string, opts: ConstructorParameters<typeof BackupService>[0] = {}) {
  const svc = new BackupService({ backupRootDir: root, ...opts })
  const fakes = fakeCollaborators()
  ;(svc as any).qemuImg = fakes.qemuImg
  ;(svc as any).snapshotMgr = fakes.snapshotMgr
  ;(svc as any).executor = fakes.executor
  return { svc, ...fakes }
}

/**
 * Wraps the service's imageLock so a test can observe which keys are HELD at any
 * moment. Returns `lockedKeys` (currently-held set) and `lockHistory` (every key
 * ever acquired). Lets us assert that a collaborator call happened while the
 * per-image lock for that disk was held.
 */
function instrumentLock (svc: BackupService) {
  const lock = (svc as any).imageLock
  const realRun = lock.runExclusive.bind(lock)
  const lockedKeys = new Set<string>()
  const lockHistory: string[] = []
  lock.runExclusive = async (key: string, fn: () => Promise<any>) => {
    return realRun(key, async () => {
      lockedKeys.add(key)
      lockHistory.push(key)
      try {
        return await fn()
      } finally {
        lockedKeys.delete(key)
      }
    })
  }
  return { lockedKeys, lockHistory }
}

// ---------------------------------------------------------------------------
// MF-2 — a freeze that throws AFTER the guest froze must still thaw + disconnect
// ---------------------------------------------------------------------------

describe('MF-2 — fsFreeze rejecting after the guest froze still thaws + disconnects', () => {
  it('thaws and disconnects the agent when fsFreeze REJECTS, then falls back to snapshot (no frozen guest, no leaked FD)', async () => {
    const root = await tmpRoot()
    // Simulate a client-side timeout: the guest froze but fsFreeze() rejected.
    const fsFreeze = jest.fn(async () => { throw new Error('QGA command timed out (guest is frozen but client gave up)') })
    const fsThaw = jest.fn(async () => 1)
    const disconnect = jest.fn(async () => undefined)
    const agent = { fsFreeze, fsThaw, disconnect, isConnected: () => true }

    const { svc, snapshotMgr } = makeService(root, {
      isVmRunning: async () => true,
      guestAgentFactory: async () => agent
    })

    const res = await svc.createBackup({
      vmId: 'vm1', diskPaths: ['/disks/d0.qcow2'], destinationDir: join(root, 'vm1'), type: BackupType.FULL
    })

    // Backup still completes — it fell back to the transient snapshot strategy.
    expect(res.success).toBe(true)
    expect(fsFreeze).toHaveBeenCalledTimes(1)
    // CRITICAL: the (possibly) frozen guest was thawed and the socket released.
    expect(fsThaw).toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalled()
    // No double-thaw: the fallback thaws once and cleanupLiveRead must NOT thaw
    // a second time (strategy.quiesce was nulled out).
    expect(fsThaw).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
    // Proof we fell back to the snapshot path (crash-consistent).
    expect(snapshotMgr.createSnapshot).toHaveBeenCalledTimes(1)
    const meta = await svc.getBackupMetadata(res.backupId, 'vm1')
    expect(meta.crashConsistent).toBe(true)
  })

  it('thaws + disconnects on the normal cleanup path too (freeze succeeds, fsThaw once)', async () => {
    const root = await tmpRoot()
    const fsFreeze = jest.fn(async () => 1)
    const fsThaw = jest.fn(async () => 1)
    const disconnect = jest.fn(async () => undefined)
    const agent = { fsFreeze, fsThaw, disconnect, isConnected: () => true }
    const { svc, snapshotMgr } = makeService(root, {
      isVmRunning: async () => true,
      guestAgentFactory: async () => agent
    })

    const res = await svc.createBackup({
      vmId: 'vm1', diskPaths: ['/disks/d0.qcow2'], destinationDir: join(root, 'vm1'), type: BackupType.FULL
    })
    expect(res.success).toBe(true)
    expect(fsFreeze).toHaveBeenCalledTimes(1)
    expect(fsThaw).toHaveBeenCalledTimes(1) // exactly once, in cleanup
    expect(disconnect).toHaveBeenCalledTimes(1)
    // freeze succeeded => no snapshot fallback
    expect(snapshotMgr.createSnapshot).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// SF-1 — live-qcow2 mutations run under the per-image lock
// ---------------------------------------------------------------------------

describe('SF-1 — snapshot mutations are serialized under the per-image lock', () => {
  it('deleteBackup runs `deleteSnapshot` UNDER the per-image lock for the source disk', async () => {
    const root = await tmpRoot()
    const src = '/disks/d0.qcow2'
    const { svc, snapshotMgr } = makeService(root)
    const { lockHistory } = instrumentLock(svc)

    // Assert the lock for the source key was HELD at the moment deleteSnapshot ran.
    let heldKeyAtDelete: string | undefined
    const lock = (svc as any).imageLock
    snapshotMgr.deleteSnapshot.mockImplementation(async () => {
      // The instrumented lock pushes the held key into lockHistory before fn runs;
      // the last entry is the key currently held around this call.
      heldKeyAtDelete = lockHistory[lockHistory.length - 1]
    })
    void lock

    await writeManifest(root, baseMeta({
      id: 'snap1', vmId: 'vm1', type: BackupType.SNAPSHOT,
      disks: [{ sourcePath: src, backupPath: 'snapname', originalSize: 1, backupSize: 0, format: 'qcow2' }]
    }))

    await svc.deleteBackup('snap1', 'vm1')

    expect(snapshotMgr.deleteSnapshot).toHaveBeenCalledWith(src, 'snapname')
    // The held key must be the CANONICAL key for the source disk.
    expect(heldKeyAtDelete).toBe(resolvePath(src))
  })

  it('transient-snapshot CREATE and DELETE both run under the per-image lock (running VM, no agent)', async () => {
    const root = await tmpRoot()
    const src = '/disks/d0.qcow2'
    const { svc, snapshotMgr } = makeService(root, { isVmRunning: async () => true })
    const { lockHistory } = instrumentLock(svc)

    let heldAtCreate: string | undefined
    let heldAtDelete: string | undefined
    snapshotMgr.createSnapshot.mockImplementation(async () => { heldAtCreate = lockHistory[lockHistory.length - 1] })
    snapshotMgr.deleteSnapshot.mockImplementation(async () => { heldAtDelete = lockHistory[lockHistory.length - 1] })

    const res = await svc.createBackup({
      vmId: 'vm1', diskPaths: [src], destinationDir: join(root, 'vm1'), type: BackupType.FULL
    })
    expect(res.success).toBe(true)
    expect(heldAtCreate).toBe(resolvePath(src))
    expect(heldAtDelete).toBe(resolvePath(src))
  })

  it('does not deadlock — createBackup of a running VM completes (non-reentrant lock is not re-entered)', async () => {
    const root = await tmpRoot()
    const { svc } = makeService(root, { isVmRunning: async () => true })
    const res = await Promise.race([
      svc.createBackup({ vmId: 'vm1', diskPaths: ['/disks/d0.qcow2'], destinationDir: join(root, 'vm1'), type: BackupType.FULL }),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('DEADLOCK: createBackup did not finish')), 4000))
    ])
    expect((res as any).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// LOW — restoreDiskFile locks on the CANONICAL key
// ---------------------------------------------------------------------------

describe('LOW — restoreDiskFile uses the canonical image lock key', () => {
  it('acquires the lock on the resolved (canonical) target path, not the raw spelling', async () => {
    const root = await tmpRoot()
    const { svc } = makeService(root)
    const { lockHistory } = instrumentLock(svc)

    const backupFile = join(root, 'vm1', 'full1', 'disk-0.qcow2')
    await mkdir(join(root, 'vm1', 'full1'), { recursive: true })
    await writeFile(backupFile, 'BK')
    await writeManifest(root, baseMeta({
      id: 'full1', vmId: 'vm1', type: BackupType.FULL,
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: backupFile, originalSize: 1, backupSize: 2, format: 'qcow2' }]
    }))

    // A non-canonical target spelling (embedded `..`). Built by string
    // concatenation, NOT path.join (which would pre-normalize the `..` away and
    // defeat the test): the raw spelling must differ from its resolved form.
    const canonicalTarget = join(root, 'restored.qcow2')
    const noisyTarget = root + '/sub/../restored.qcow2'
    expect(noisyTarget).not.toBe(canonicalTarget) // sanity: spellings differ

    await svc.restoreBackup({
      backupId: 'full1', vmId: 'vm1', diskPaths: [noisyTarget], overwriteExisting: true
    })

    // The lock key recorded must be the CANONICAL (resolved) path, never the raw
    // noisy spelling — proving restoreDiskFile locks on this.imageKey(targetPath).
    expect(lockHistory).toContain(resolvePath(canonicalTarget))
    expect(lockHistory).not.toContain(noisyTarget)
  })
})

// ---------------------------------------------------------------------------
// LOW — incremental restore rebases the overlay onto the RE-ROOTED parent
// ---------------------------------------------------------------------------

describe('LOW — incremental restore rebases onto the re-rooted parent (moved backup dir)', () => {
  it('rebases the overlay copy onto the resolved parent before convert when the embedded backing path is stale', async () => {
    const root = await tmpRoot()
    const { svc, executor, qemuImg } = makeService(root)

    // The overlay lives under the CURRENT root; its recorded backingFile points
    // at a STALE absolute location (an old root) that no longer exists. The
    // re-rooted parent (same <backupId>/<file> tail under the current root) DOES
    // exist, so the pre-flight passes via candidateBackingPaths — but the overlay's
    // embedded backing path is stale, so convert would fail without a rebase.
    const overlay = join(root, 'vm1', 'inc1', 'disk-0.qcow2')
    const reRootedParent = join(root, 'vm1', 'base1', 'disk-0.qcow2')
    const staleBacking = join('/old', 'backups', 'vm1', 'base1', 'disk-0.qcow2')
    await mkdir(join(root, 'vm1', 'inc1'), { recursive: true })
    await mkdir(join(root, 'vm1', 'base1'), { recursive: true })
    await writeFile(overlay, 'OVL')
    await writeFile(reRootedParent, 'PARENT')

    await writeManifest(root, baseMeta({
      id: 'inc1', vmId: 'vm1', type: BackupType.INCREMENTAL, parentBackupId: 'base1',
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: overlay, backingFile: staleBacking, originalSize: 1, backupSize: 1, format: 'qcow2' }]
    }))

    const target = join(root, 'target.qcow2')
    const res = await svc.restoreBackup({
      backupId: 'inc1', vmId: 'vm1', diskPaths: [target], overwriteExisting: true
    })
    expect(res.success).toBe(true)

    // A metadata-only `qemu-img rebase -u -b <reRootedParent>` was issued.
    const rebaseCalls = executor.execute.mock.calls.filter((c: any[]) => c[0] === 'qemu-img' && c[1][0] === 'rebase')
    expect(rebaseCalls.length).toBe(1)
    const rebaseArgs: string[] = rebaseCalls[0][1]
    expect(rebaseArgs).toContain('-u')
    expect(rebaseArgs).toContain(reRootedParent)
    // The rebase ran against a TEMP COPY of the overlay (the materialized chain),
    // never the pristine backup.
    const rebasedTarget = rebaseArgs[rebaseArgs.length - 1]
    expect(rebasedTarget).not.toBe(overlay)
    expect(rebasedTarget).toMatch(/\.chain\d+\.tmp$/)
    // The pristine backup overlay content is unchanged.
    expect(await readFile(overlay, 'utf-8')).toBe('OVL')
    // The target was produced via convert from the rebased copy.
    expect(qemuImg.convertImage).toHaveBeenCalledTimes(1)
    expect(qemuImg.convertImage.mock.calls[0][0].sourcePath).toBe(rebasedTarget)
    await expect(stat(target)).resolves.toBeTruthy()
  })

  it('does NOT rebase a FULL restore (no backing file)', async () => {
    const root = await tmpRoot()
    const { svc, executor } = makeService(root)
    const backupFile = join(root, 'vm1', 'full1', 'disk-0.qcow2')
    await mkdir(join(root, 'vm1', 'full1'), { recursive: true })
    await writeFile(backupFile, 'BK')
    await writeManifest(root, baseMeta({
      id: 'full1', vmId: 'vm1', type: BackupType.FULL,
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: backupFile, originalSize: 1, backupSize: 2, format: 'qcow2' }]
    }))
    const target = join(root, 'restored.qcow2')
    await svc.restoreBackup({ backupId: 'full1', vmId: 'vm1', diskPaths: [target], overwriteExisting: true })
    const rebaseCalls = executor.execute.mock.calls.filter((c: any[]) => c[0] === 'qemu-img' && c[1][0] === 'rebase')
    expect(rebaseCalls.length).toBe(0)
  })
})
