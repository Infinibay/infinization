/**
 * Data-protection unit tests for BackupService / BackupScheduler.
 *
 * These run WITHOUT qemu-img: the qemu-img / snapshot collaborators are mocked,
 * and the filesystem layout (manifests) is created in a real tmp dir so the
 * manifest-scan / dependency / retention logic exercises real code paths.
 *
 * Covers: B2 (snapshot restore in-place vs target), H4 (gzip-parent incremental
 * refusal), H5 (delete/retention chain protection), H6 (running-VM guard +
 * fail-closed), L69 (incremental chain pre-flight), overwriteExisting semantics.
 *
 * Real-qcow2 byte-identity round-trips live in backupRoundtrip.integration.spec.ts
 * (auto-skipped where qemu-img is unavailable).
 */
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { BackupService } from '../src/backup/BackupService'
import { BackupScheduler, ScheduleAdapter, ScheduledJob } from '../src/backup/BackupScheduler'
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
// Helpers
// ---------------------------------------------------------------------------

async function tmpRoot (): Promise<string> {
  return mkdtemp(join(tmpdir(), 'infz-backup-test-'))
}

/** Writes a backup manifest into <root>/<vmId>/<backupId>/backup.json. */
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

/** A qemu-img/snapshot double that records calls and never touches qemu. */
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

/** Builds a BackupService with mocked collaborators wired into its privates. */
function makeService (root: string, opts: ConstructorParameters<typeof BackupService>[0] = {}) {
  const svc = new BackupService({ backupRootDir: root, ...opts })
  const fakes = fakeCollaborators()
  ;(svc as any).qemuImg = fakes.qemuImg
  ;(svc as any).snapshotMgr = fakes.snapshotMgr
  ;(svc as any).executor = fakes.executor
  return { svc, ...fakes }
}

// ---------------------------------------------------------------------------
// B2 — SNAPSHOT restore: in-place vs different-target semantics
// ---------------------------------------------------------------------------

describe('B2 — SNAPSHOT restore honors target contract', () => {
  it('refuses in-place revert of the live source unless explicitly opted in', async () => {
    const root = await tmpRoot()
    const src = join(root, 'disk0.qcow2')
    await writeFile(src, 'LIVE')
    const { svc } = makeService(root)
    await writeManifest(root, baseMeta({
      id: 'snap1', vmId: 'vm1', type: BackupType.SNAPSHOT,
      disks: [{ sourcePath: src, backupPath: 'snapname', originalSize: 1, backupSize: 0, format: 'qcow2' }]
    }))

    await expect(svc.restoreBackup({
      backupId: 'snap1', vmId: 'vm1', diskPaths: [src], overwriteExisting: true
      // allowInPlaceSnapshotRevert intentionally omitted
    })).rejects.toMatchObject({ code: BackupErrorCode.INVALID_CONFIG })
  })

  it('performs in-place revert ONLY with allowInPlaceSnapshotRevert + overwrite guard on the SOURCE', async () => {
    const root = await tmpRoot()
    const src = join(root, 'disk0.qcow2')
    await writeFile(src, 'LIVE')
    const { svc, snapshotMgr } = makeService(root)
    await writeManifest(root, baseMeta({
      id: 'snap2', vmId: 'vm1', type: BackupType.SNAPSHOT,
      disks: [{ sourcePath: src, backupPath: 'snapname', originalSize: 1, backupSize: 0, format: 'qcow2' }]
    }))

    // overwriteExisting:false must trip because the SOURCE (the file actually
    // written) already exists — the old code wrongly stat'd targetPath.
    await expect(svc.restoreBackup({
      backupId: 'snap2', vmId: 'vm1', diskPaths: [src],
      allowInPlaceSnapshotRevert: true, overwriteExisting: false
    })).rejects.toMatchObject({ code: BackupErrorCode.TARGET_EXISTS })

    // With overwrite enabled, the revert runs against the source file.
    const res = await svc.restoreBackup({
      backupId: 'snap2', vmId: 'vm1', diskPaths: [src],
      allowInPlaceSnapshotRevert: true, overwriteExisting: true
    })
    expect(res.restoredDiskPaths).toEqual([src])
    expect(snapshotMgr.revertSnapshot).toHaveBeenCalledWith(src, 'snapname')
    expect(snapshotMgr.materializeSnapshot).not.toHaveBeenCalled()
  })

  it('materializes the snapshot to a DIFFERENT target without touching the live source', async () => {
    const root = await tmpRoot()
    const src = join(root, 'disk0.qcow2')
    const target = join(root, 'restored.qcow2')
    await writeFile(src, 'LIVE')
    const { svc, snapshotMgr } = makeService(root)
    await writeManifest(root, baseMeta({
      id: 'snap3', vmId: 'vm1', type: BackupType.SNAPSHOT,
      disks: [{ sourcePath: src, backupPath: 'snapname', originalSize: 1, backupSize: 0, format: 'qcow2' }]
    }))

    const res = await svc.restoreBackup({
      backupId: 'snap3', vmId: 'vm1', diskPaths: [target], overwriteExisting: false
    })
    expect(res.restoredDiskPaths).toEqual([target])
    // source disk must NOT be reverted in place
    expect(snapshotMgr.revertSnapshot).not.toHaveBeenCalled()
    expect(snapshotMgr.materializeSnapshot).toHaveBeenCalledTimes(1)
    expect(snapshotMgr.materializeSnapshot.mock.calls[0][0]).toBe(src)
    // live source content is unchanged
    expect(await readFile(src, 'utf-8')).toBe('LIVE')
    // target now exists
    await expect(stat(target)).resolves.toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// H4 — INCREMENTAL on a GZIP parent must be refused at creation
// ---------------------------------------------------------------------------

describe('H4 — incremental refuses a gzip parent', () => {
  it('throws INVALID_CONFIG when the parent compression is GZIP', async () => {
    const root = await tmpRoot()
    const { svc } = makeService(root)
    await writeManifest(root, baseMeta({
      id: 'parentGz', vmId: 'vm1', compression: BackupCompression.GZIP,
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: join(root, 'vm1', 'parentGz', 'disk-0.qcow2.gz'), originalSize: 1, backupSize: 1, format: 'qcow2' }]
    }))

    // createBackup catches the inner INVALID_CONFIG, marks the backup FAILED, and
    // rethrows it wrapped as OPERATION_FAILED. The FAILED manifest carries the
    // gzip-parent reason so the failure is discoverable, not silent.
    const err = await svc.createBackup({
      vmId: 'vm1', diskPaths: ['/disks/d0.qcow2'], destinationDir: join(root, 'vm1'),
      type: BackupType.INCREMENTAL, parentBackupId: 'parentGz'
    }).catch((e: BackupError) => e)
    expect(err).toBeInstanceOf(BackupError)
    expect((err as BackupError).code).toBe(BackupErrorCode.OPERATION_FAILED)
    expect((err as BackupError).message).toMatch(/GZIP-compressed/i)
  })

  it('throws when any parent disk backupPath ends with .gz even if compression field says NONE', async () => {
    const root = await tmpRoot()
    const { svc, snapshotMgr } = makeService(root)
    await writeManifest(root, baseMeta({
      id: 'parentGz2', vmId: 'vm1', compression: BackupCompression.NONE,
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: '/somewhere/disk-0.qcow2.gz', originalSize: 1, backupSize: 1, format: 'qcow2' }]
    }))
    // Call the private executeIncrementalBackup directly to assert the precise code.
    const meta = baseMeta({ id: 'childX', vmId: 'vm1', type: BackupType.INCREMENTAL, status: BackupStatus.IN_PROGRESS })
    await expect((svc as any).executeIncrementalBackup(
      { vmId: 'vm1', diskPaths: ['/disks/d0.qcow2'], destinationDir: root, type: BackupType.INCREMENTAL, parentBackupId: 'parentGz2' },
      root, meta, BackupCompression.NONE,
      { running: false, crashConsistent: false, quiesce: null, readFrom: new Map(), transientSnapshots: new Map(), tempFiles: [] }
    )).rejects.toMatchObject({ code: BackupErrorCode.INVALID_CONFIG })
    expect(snapshotMgr.createSnapshot).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// H5 — delete + retention chain protection
// ---------------------------------------------------------------------------

describe('H5 — incremental chain dependency protection', () => {
  it('deleteBackup refuses to delete a parent that still has dependents', async () => {
    const root = await tmpRoot()
    const { svc } = makeService(root)
    await writeManifest(root, baseMeta({ id: 'base', vmId: 'vm1' }))
    await writeManifest(root, baseMeta({ id: 'child', vmId: 'vm1', type: BackupType.INCREMENTAL, parentBackupId: 'base' }))

    await expect(svc.deleteBackup('base', 'vm1')).rejects.toMatchObject({ code: BackupErrorCode.DEPENDENCY })
    // base dir still present
    await expect(stat(join(root, 'vm1', 'base'))).resolves.toBeTruthy()
  })

  it('deleteBackup allows deleting a leaf overlay, then its parent', async () => {
    const root = await tmpRoot()
    const { svc } = makeService(root)
    await writeManifest(root, baseMeta({ id: 'base', vmId: 'vm1' }))
    await writeManifest(root, baseMeta({ id: 'child', vmId: 'vm1', type: BackupType.INCREMENTAL, parentBackupId: 'base' }))

    await svc.deleteBackup('child', 'vm1')
    await expect(stat(join(root, 'vm1', 'child'))).rejects.toBeTruthy()
    // now the base can go
    await svc.deleteBackup('base', 'vm1')
    await expect(stat(join(root, 'vm1', 'base'))).rejects.toBeTruthy()
  })
})

describe('H5 — retention keeps a base while its chain is still retained', () => {
  function makeAdapter (): { adapter: ScheduleAdapter, fire: () => Promise<void> } {
    let cb: (() => void) | null = null
    const job: ScheduledJob = { stop: () => {}, getNextRunDate: () => undefined }
    return {
      adapter: { schedule: (_e, callback) => { cb = callback; return job } },
      fire: async () => { if (cb) cb(); await new Promise(r => setTimeout(r, 30)) }
    }
  }

  it('does not delete an aged-out base when a retained overlay still depends on it', async () => {
    const root = await tmpRoot()
    // 3 scheduled backups: base(old, FULL) <- child(old, INCR) , plus a newer FULL.
    // retentionCount=2 ages out the oldest one (base), but child still depends on
    // it AND child is within retention -> base must be rescued.
    const t = (n: number) => new Date(2020, 0, n).toISOString()
    const mk = (id: string, when: string, over: Partial<BackupMetadata> = {}): BackupMetadata =>
      baseMeta({ id, vmId: 'vm1', createdAt: when, tags: ['scheduled', 'sch1'], ...over })

    const deleted: string[] = []
    const backupService: any = {
      listBackups: jest.fn(async () => [
        mk('newFull', t(3)),
        mk('child', t(2), { type: BackupType.INCREMENTAL, parentBackupId: 'base' }),
        mk('base', t(1))
      ]),
      deleteBackup: jest.fn(async (id: string) => {
        if (id === 'base') {
          const e = new BackupError(BackupErrorCode.DEPENDENCY, 'has dependents', { backupId: id, vmId: 'vm1' })
          throw e
        }
        deleted.push(id)
      }),
      createBackup: jest.fn(async () => ({ success: true, backupId: 'x' }))
    }

    const { adapter, fire } = makeAdapter()
    const scheduler = new BackupScheduler(backupService as any, adapter, { diskPathResolver: () => ['/disks/d0.qcow2'] })
    scheduler.addSchedule({
      id: 'sch1', vmId: 'vm1', type: BackupType.FULL, cronExpression: '* * * * *',
      retentionCount: 2, destinationDir: root, enabled: true
    })
    await fire()

    // base is the only age-out candidate; it must NOT be deleted because child
    // (retained) depends on it. So deleteBackup should NEVER be called with base.
    const deletedBaseAttempts = backupService.deleteBackup.mock.calls.filter((c: any[]) => c[0] === 'base')
    expect(deletedBaseAttempts.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// H6 — running-VM guard (fail-closed) + quiesce / snapshot fallback
// ---------------------------------------------------------------------------

describe('H6 — live-disk guard', () => {
  it('reads live disk directly when isVmRunning reports stopped', async () => {
    const root = await tmpRoot()
    const isVmRunning = jest.fn(async () => false)
    const { svc, snapshotMgr } = makeService(root, { isVmRunning })
    const res = await svc.createBackup({
      vmId: 'vm1', diskPaths: ['/disks/d0.qcow2'], destinationDir: join(root, 'vm1'), type: BackupType.FULL
    })
    expect(res.success).toBe(true)
    expect(snapshotMgr.createSnapshot).not.toHaveBeenCalled()
    const meta = await svc.getBackupMetadata(res.backupId, 'vm1')
    expect(meta.runningAtBackup).toBe(false)
    expect(meta.crashConsistent).toBe(false)
  })

  it('quiesces via guest agent when running and an agent is available (consistent)', async () => {
    const root = await tmpRoot()
    const fsFreeze = jest.fn(async () => 1)
    const fsThaw = jest.fn(async () => 1)
    const agent = { fsFreeze, fsThaw, isConnected: () => true }
    const { svc } = makeService(root, {
      isVmRunning: async () => true,
      guestAgentFactory: async () => agent
    })
    const res = await svc.createBackup({
      vmId: 'vm1', diskPaths: ['/disks/d0.qcow2'], destinationDir: join(root, 'vm1'), type: BackupType.FULL
    })
    expect(res.success).toBe(true)
    expect(fsFreeze).toHaveBeenCalledTimes(1)
    expect(fsThaw).toHaveBeenCalledTimes(1) // thawed in finally
    const meta = await svc.getBackupMetadata(res.backupId, 'vm1')
    expect(meta.runningAtBackup).toBe(true)
    expect(meta.crashConsistent).toBe(false)
  })

  it('falls back to a transient snapshot when running and no guest agent (crash-consistent)', async () => {
    const root = await tmpRoot()
    const { svc, snapshotMgr } = makeService(root, {
      isVmRunning: async () => true
      // no guestAgentFactory
    })
    const res = await svc.createBackup({
      vmId: 'vm1', diskPaths: ['/disks/d0.qcow2'], destinationDir: join(root, 'vm1'), type: BackupType.FULL
    })
    expect(res.success).toBe(true)
    expect(snapshotMgr.createSnapshot).toHaveBeenCalledTimes(1)
    expect(snapshotMgr.materializeSnapshot).toHaveBeenCalledTimes(1)
    expect(snapshotMgr.deleteSnapshot).toHaveBeenCalledTimes(1) // transient cleaned up
    const meta = await svc.getBackupMetadata(res.backupId, 'vm1')
    expect(meta.runningAtBackup).toBe(true)
    expect(meta.crashConsistent).toBe(true)
  })

  it('FAILS CLOSED on an unknown (null) power state when snapshot also fails', async () => {
    const root = await tmpRoot()
    const { svc, snapshotMgr } = makeService(root, { isVmRunning: async () => null })
    snapshotMgr.createSnapshot.mockRejectedValueOnce(new Error('image in use'))
    const res = await svc.createBackup({
      vmId: 'vm1', diskPaths: ['/disks/d0.qcow2'], destinationDir: join(root, 'vm1'), type: BackupType.FULL
    }).catch((e: any) => e)
    expect(res).toBeInstanceOf(BackupError)
    // createBackup rewraps as OPERATION_FAILED but the message carries VM_RUNNING context
    const meta = await svc.getBackupMetadata(res.backupId ?? 'x', 'vm1').catch(() => null)
    void meta
    expect(String(res.message)).toMatch(/running|quiesce|snapshot/i)
  })
})

// ---------------------------------------------------------------------------
// L69 — incremental restore chain pre-flight
// ---------------------------------------------------------------------------

describe('L69 — incremental restore verifies chain before writing', () => {
  it('aborts with PARENT_NOT_FOUND if the backing parent is missing — no target written', async () => {
    const root = await tmpRoot()
    const { svc } = makeService(root)
    const overlay = join(root, 'vm1', 'inc1', 'disk-0.qcow2')
    await mkdir(join(root, 'vm1', 'inc1'), { recursive: true })
    await writeFile(overlay, 'OVL')
    await writeManifest(root, baseMeta({
      id: 'inc1', vmId: 'vm1', type: BackupType.INCREMENTAL, parentBackupId: 'gone',
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: overlay, backingFile: join(root, 'vm1', 'gone', 'disk-0.qcow2'), originalSize: 1, backupSize: 1, format: 'qcow2' }]
    }))

    const target = join(root, 'target.qcow2')
    await expect(svc.restoreBackup({
      backupId: 'inc1', vmId: 'vm1', diskPaths: [target], overwriteExisting: true
    })).rejects.toMatchObject({ code: BackupErrorCode.PARENT_NOT_FOUND })
    // target must not have been created
    await expect(stat(target)).rejects.toBeTruthy()
  })

  it('aborts with CORRUPT_BACKUP if qemu-img check reports corruption on the parent', async () => {
    const root = await tmpRoot()
    const { svc, qemuImg } = makeService(root)
    const overlay = join(root, 'vm1', 'inc2', 'disk-0.qcow2')
    const parent = join(root, 'vm1', 'base2', 'disk-0.qcow2')
    await mkdir(join(root, 'vm1', 'inc2'), { recursive: true })
    await mkdir(join(root, 'vm1', 'base2'), { recursive: true })
    await writeFile(overlay, 'OVL'); await writeFile(parent, 'PARENT')
    await writeManifest(root, baseMeta({
      id: 'inc2', vmId: 'vm1', type: BackupType.INCREMENTAL, parentBackupId: 'base2',
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: overlay, backingFile: parent, originalSize: 1, backupSize: 1, format: 'qcow2' }]
    }))
    qemuImg.checkImage.mockResolvedValue({ errors: 0, leaks: 0, corruptions: 3, totalClusters: 1, allocatedClusters: 1 })

    const target = join(root, 'target2.qcow2')
    await expect(svc.restoreBackup({
      backupId: 'inc2', vmId: 'vm1', diskPaths: [target], overwriteExisting: true
    })).rejects.toMatchObject({ code: BackupErrorCode.CORRUPT_BACKUP })
    await expect(stat(target)).rejects.toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// LOW — relocated MULTI-LEVEL incremental chain (base <- inc1 <- inc2)
// ---------------------------------------------------------------------------

describe('LOW — relocated multi-level incremental chain restore', () => {
  /**
   * Lays out base(FULL) <- inc1(INCREMENTAL) <- inc2(INCREMENTAL) under `root`,
   * but records each overlay's backingFile against a STALE old root so the
   * embedded paths must be re-rooted under the live backupRootDir to resolve.
   * Returns the on-disk paths of the three pristine backup files.
   */
  async function layoutRelocatedChain (root: string): Promise<{ base: string, inc1: string, inc2: string }> {
    const oldRoot = '/old/host/backups'
    const base = join(root, 'vm1', 'base', 'disk-0.qcow2')
    const inc1 = join(root, 'vm1', 'inc1', 'disk-0.qcow2')
    const inc2 = join(root, 'vm1', 'inc2', 'disk-0.qcow2')
    await mkdir(join(root, 'vm1', 'base'), { recursive: true })
    await mkdir(join(root, 'vm1', 'inc1'), { recursive: true })
    await mkdir(join(root, 'vm1', 'inc2'), { recursive: true })
    await writeFile(base, 'BASE')
    await writeFile(inc1, 'INC1')
    await writeFile(inc2, 'INC2')

    // FULL base — no backingFile.
    await writeManifest(root, baseMeta({
      id: 'base', vmId: 'vm1', type: BackupType.FULL,
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: base, originalSize: 1, backupSize: 1, format: 'qcow2' }]
    }))
    // inc1 -> base, with a STALE recorded backing path under the OLD root.
    await writeManifest(root, baseMeta({
      id: 'inc1', vmId: 'vm1', type: BackupType.INCREMENTAL, parentBackupId: 'base',
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: inc1, backingFile: join(oldRoot, 'vm1', 'base', 'disk-0.qcow2'), originalSize: 1, backupSize: 1, format: 'qcow2' }]
    }))
    // inc2 -> inc1, also STALE.
    await writeManifest(root, baseMeta({
      id: 'inc2', vmId: 'vm1', type: BackupType.INCREMENTAL, parentBackupId: 'inc1',
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: inc2, backingFile: join(oldRoot, 'vm1', 'inc1', 'disk-0.qcow2'), originalSize: 1, backupSize: 1, format: 'qcow2' }]
    }))
    return { base, inc1, inc2 }
  }

  it('re-roots the ENTIRE chain into temp copies and converts a correctly-chained overlay; originals untouched', async () => {
    const root = await tmpRoot()
    const { svc, calls, qemuImg } = makeService(root)
    const { base, inc1, inc2 } = await layoutRelocatedChain(root)

    const target = join(root, 'restored.qcow2')
    await expect(svc.restoreBackup({
      backupId: 'inc2', vmId: 'vm1', diskPaths: [target], overwriteExisting: true
    })).resolves.toMatchObject({ success: true })

    // --- the convert ran against a TEMP overlay, never a pristine backup file ---
    expect(calls.convertImage.length).toBe(1)
    const convertSource: string = calls.convertImage[0][0].sourcePath
    expect(convertSource).not.toBe(inc2)
    expect(convertSource).not.toBe(inc1)
    expect(convertSource).toContain('.chain0.tmp') // top overlay temp copy

    // --- two rebases ran (inc2 + inc1); the read-only base is referenced in place ---
    const rebases = calls.execute.filter(([cmd, args]) => cmd === 'qemu-img' && (args as string[])[0] === 'rebase')
    expect(rebases.length).toBe(2)

    // Each rebase is metadata-only (-u) onto a qcow2 backing.
    for (const [, args] of rebases) {
      const a = args as string[]
      expect(a).toContain('-u')
      expect(a).toEqual(expect.arrayContaining(['-F', 'qcow2']))
    }

    // Collect (rebasedFile -> backingTarget) from each rebase invocation. Args
    // look like: ['rebase','-u','-b',<backing>,'-F','qcow2','--',<file>].
    const byFile = new Map<string, string>()
    for (const [, args] of rebases) {
      const a = args as string[]
      const backing = a[a.indexOf('-b') + 1]
      const file = a[a.length - 1]
      byFile.set(file, backing)
    }
    const chain0 = join(`${target}.chain0.tmp`) // inc2 temp (top)
    const chain1 = join(`${target}.chain1.tmp`) // inc1 temp (bottom non-base)

    // Bottom temp (inc1) must rebase onto the RE-ROOTED real base under `root`.
    expect(byFile.get(chain1)).toBe(base)
    // Top temp (inc2) must rebase onto the inc1 TEMP copy — full re-root, not the
    // stale embedded path and not the pristine inc1.
    expect(byFile.get(chain0)).toBe(chain1)

    // --- pristine backups are never mutated ---
    expect(await readFile(base, 'utf-8')).toBe('BASE')
    expect(await readFile(inc1, 'utf-8')).toBe('INC1')
    expect(await readFile(inc2, 'utf-8')).toBe('INC2')

    // --- temp chain copies are cleaned up ---
    await expect(stat(chain0)).rejects.toBeTruthy()
    await expect(stat(chain1)).rejects.toBeTruthy()

    // --- the parent base was integrity-checked exactly once (terminal level) ---
    expect(qemuImg.checkImage).toHaveBeenCalledWith(base)
  })

  it('aborts with PARENT_NOT_FOUND when a MID-CHAIN parent (the base) is missing — no target written, no rebase run', async () => {
    const root = await tmpRoot()
    const { svc, calls } = makeService(root)
    const { base } = await layoutRelocatedChain(root)
    // Remove the FULL base so the inc1->base link cannot resolve under any root.
    await rm(base)

    const target = join(root, 'restored.qcow2')
    await expect(svc.restoreBackup({
      backupId: 'inc2', vmId: 'vm1', diskPaths: [target], overwriteExisting: true
    })).rejects.toMatchObject({ code: BackupErrorCode.PARENT_NOT_FOUND })

    // Pre-flight must abort BEFORE any target write or any rebase/convert.
    await expect(stat(target)).rejects.toBeTruthy()
    const rebases = calls.execute.filter(([cmd, args]) => cmd === 'qemu-img' && (args as string[])[0] === 'rebase')
    expect(rebases.length).toBe(0)
    expect(calls.convertImage.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// overwriteExisting semantics (FULL restore)
// ---------------------------------------------------------------------------

describe('FULL restore — overwriteExisting guard', () => {
  it('refuses when target exists and overwriteExisting is false; succeeds when true', async () => {
    const root = await tmpRoot()
    const { svc } = makeService(root)
    const backupFile = join(root, 'vm1', 'full1', 'disk-0.qcow2')
    await mkdir(join(root, 'vm1', 'full1'), { recursive: true })
    await writeFile(backupFile, 'BK')
    await writeManifest(root, baseMeta({
      id: 'full1', vmId: 'vm1', type: BackupType.FULL,
      disks: [{ sourcePath: '/disks/d0.qcow2', backupPath: backupFile, originalSize: 1, backupSize: 2, format: 'qcow2' }]
    }))

    const target = join(root, 'existing.qcow2')
    await writeFile(target, 'OLD')

    await expect(svc.restoreBackup({
      backupId: 'full1', vmId: 'vm1', diskPaths: [target], overwriteExisting: false
    })).rejects.toMatchObject({ code: BackupErrorCode.TARGET_EXISTS })
    // original target untouched
    expect(await readFile(target, 'utf-8')).toBe('OLD')

    await expect(svc.restoreBackup({
      backupId: 'full1', vmId: 'vm1', diskPaths: [target], overwriteExisting: true
    })).resolves.toMatchObject({ success: true })
  })
})
