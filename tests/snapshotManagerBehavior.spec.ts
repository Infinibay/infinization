/**
 * Behavioural tests for SnapshotManager — the IRREVERSIBLE snapshot surface
 * (revert / delete / materialize) plus the fail-closed `snapshotExists` guard
 * and the name validation that gates every destructive verb.
 *
 * These run WITHOUT a real `qemu-img` binary (CommandExecutor.execute is mocked),
 * so the error-mapping and fail-closed behaviour are verified on every platform
 * and in CI — not only where the integration round-trip suite can run.
 * Complements tests/snapshotArgv.spec.ts (argv shape) and
 * tests/backupRoundtrip.integration.spec.ts. See CODE_REVIEW_REPORT §C.4 TEST-04.
 */
import { SnapshotManager } from '../src/storage/SnapshotManager'
import { CommandExecutor } from '../src/utils/commandExecutor'
import { StorageError, StorageErrorCode, MAX_SNAPSHOT_NAME_LENGTH } from '../src/types/storage.types'

async function expectStorageError (p: Promise<unknown>, code: StorageErrorCode): Promise<StorageError> {
  const err = await p.then(
    () => { throw new Error('expected the operation to reject, but it resolved') },
    (e) => e
  )
  expect(err).toBeInstanceOf(StorageError)
  expect((err as StorageError).code).toBe(code)
  return err as StorageError
}

// Verbatim shape of a qemu-img write-lock failure (a running VM holds the lock):
// contains "Could not open" + "Failed to get" + "lock" but NOT "in use"/"locked".
// This is the realistic input that catches a lock matcher which only looks for
// 'in use'/'locked' (and would misclassify a live disk as IMAGE_NOT_FOUND).
const LOCK_ERR = `qemu-img: Could not open '/d.qcow2': Failed to get "write" lock\nIs another process using the image [/d.qcow2]?`

describe('SnapshotManager — irreversible snapshot ops (behaviour, no real qemu-img)', () => {
  let execSpy: jest.SpyInstance
  let mgr: SnapshotManager

  beforeEach(() => {
    execSpy = jest.spyOn(CommandExecutor.prototype, 'execute').mockResolvedValue('')
    mgr = new SnapshotManager()
  })
  afterEach(() => jest.restoreAllMocks())

  describe('validateSnapshotName gates every destructive verb BEFORE qemu-img', () => {
    it('rejects an over-length name', async () => {
      const tooLong = 'a'.repeat(MAX_SNAPSHOT_NAME_LENGTH + 1)
      await expect(mgr.revertSnapshot('/d.qcow2', tooLong)).rejects.toThrow()
      expect(execSpy).not.toHaveBeenCalled()
    })

    it('rejects names with shell/path metacharacters (e.g. traversal, spaces)', async () => {
      for (const bad of ['../escape', 'a b', 'a;rm -rf', 'a/b', 'a$x']) {
        execSpy.mockClear()
        await expect(mgr.deleteSnapshot('/d.qcow2', bad)).rejects.toThrow()
        expect(execSpy).not.toHaveBeenCalled()
      }
    })
  })

  describe('createSnapshot', () => {
    it('maps a REAL qemu-img lock failure to IMAGE_IN_USE (not IMAGE_NOT_FOUND)', async () => {
      execSpy.mockRejectedValue(new Error(LOCK_ERR))
      await expectStorageError(
        mgr.createSnapshot({ imagePath: '/d.qcow2', name: 'snap1' }),
        StorageErrorCode.IMAGE_IN_USE
      )
    })

    it('maps a duplicate name to SNAPSHOT_ALREADY_EXISTS', async () => {
      execSpy.mockRejectedValue(new Error("Snapshot 'snap1' already exists"))
      await expectStorageError(
        mgr.createSnapshot({ imagePath: '/d.qcow2', name: 'snap1' }),
        StorageErrorCode.SNAPSHOT_ALREADY_EXISTS
      )
    })
  })

  describe('revertSnapshot (rolls the disk back in place — destructive)', () => {
    it('maps a missing snapshot to SNAPSHOT_NOT_FOUND', async () => {
      execSpy.mockRejectedValue(new Error("Snapshot 'snap1' does not exist"))
      await expectStorageError(mgr.revertSnapshot('/d.qcow2', 'snap1'), StorageErrorCode.SNAPSHOT_NOT_FOUND)
    })

    it('maps a REAL qemu-img lock failure to IMAGE_IN_USE (not IMAGE_NOT_FOUND) — refuse to revert a live disk', async () => {
      execSpy.mockRejectedValue(new Error(LOCK_ERR))
      await expectStorageError(mgr.revertSnapshot('/d.qcow2', 'snap1'), StorageErrorCode.IMAGE_IN_USE)
    })

    it('maps a missing image to IMAGE_NOT_FOUND', async () => {
      execSpy.mockRejectedValue(new Error('Could not open /d.qcow2: No such file'))
      await expectStorageError(mgr.revertSnapshot('/d.qcow2', 'snap1'), StorageErrorCode.IMAGE_NOT_FOUND)
    })

    it('maps an unknown failure to COMMAND_FAILED', async () => {
      execSpy.mockRejectedValue(new Error('kaboom'))
      await expectStorageError(mgr.revertSnapshot('/d.qcow2', 'snap1'), StorageErrorCode.COMMAND_FAILED)
    })
  })

  describe('deleteSnapshot', () => {
    it('is a graceful no-op when the snapshot does not exist (idempotent)', async () => {
      execSpy.mockRejectedValue(new Error("Snapshot 'snap1' not found"))
      await expect(mgr.deleteSnapshot('/d.qcow2', 'snap1')).resolves.toBeUndefined()
    })

    it('still maps a missing image to IMAGE_NOT_FOUND (not swallowed)', async () => {
      execSpy.mockRejectedValue(new Error('Could not open /d.qcow2: No such file'))
      await expectStorageError(mgr.deleteSnapshot('/d.qcow2', 'snap1'), StorageErrorCode.IMAGE_NOT_FOUND)
    })

    it('maps an unknown failure to COMMAND_FAILED', async () => {
      execSpy.mockRejectedValue(new Error('disk on fire'))
      await expectStorageError(mgr.deleteSnapshot('/d.qcow2', 'snap1'), StorageErrorCode.COMMAND_FAILED)
    })
  })

  describe('materializeSnapshot (writes to a NEW file — must not mutate the source)', () => {
    it('uses `convert -l <snap> -- <source> <dest>` (does not roll the source back in place)', async () => {
      await mgr.materializeSnapshot('/src.qcow2', 'snap1', '/dst.qcow2')
      const args = execSpy.mock.calls[0][1] as string[]
      expect(args).toEqual(['convert', '-O', 'qcow2', '-l', 'snap1', '--', '/src.qcow2', '/dst.qcow2'])
      // critically, the source path appears only as a convert INPUT, never with -a
      expect(args).not.toContain('-a')
    })

    it('maps a missing snapshot to SNAPSHOT_NOT_FOUND', async () => {
      execSpy.mockRejectedValue(new Error('Failed to load snapshot'))
      await expectStorageError(
        mgr.materializeSnapshot('/src.qcow2', 'snap1', '/dst.qcow2'),
        StorageErrorCode.SNAPSHOT_NOT_FOUND
      )
    })

    it('maps a missing source image to IMAGE_NOT_FOUND', async () => {
      execSpy.mockRejectedValue(new Error('Could not open /src.qcow2'))
      await expectStorageError(
        mgr.materializeSnapshot('/src.qcow2', 'snap1', '/dst.qcow2'),
        StorageErrorCode.IMAGE_NOT_FOUND
      )
    })
  })

  describe('snapshotExists is FAIL-CLOSED (a lock/parse error must not read as "absent")', () => {
    const listOutput = [
      'Snapshot list:',
      'ID        TAG       VM SIZE      DATE                  VM CLOCK',
      '1         snap1     0 B          2024-01-15 10:30:00   00:00:00.000'
    ].join('\n')

    it('returns true when the snapshot is present', async () => {
      execSpy.mockResolvedValue(listOutput)
      await expect(mgr.snapshotExists('/d.qcow2', 'snap1')).resolves.toBe(true)
    })

    it('returns false when absent', async () => {
      execSpy.mockResolvedValue(listOutput)
      await expect(mgr.snapshotExists('/d.qcow2', 'other')).resolves.toBe(false)
    })

    it('treats a genuinely missing image as absent (false)', async () => {
      execSpy.mockRejectedValue(new Error('Could not open /d.qcow2: No such file'))
      await expect(mgr.snapshotExists('/d.qcow2', 'snap1')).resolves.toBe(false)
    })

    it('RE-THROWS a lock error instead of swallowing it to false (would green-light a destructive overwrite)', async () => {
      // listSnapshots maps a lock failure to COMMAND_FAILED (not IMAGE_NOT_FOUND),
      // so snapshotExists must propagate it rather than report "absent".
      execSpy.mockRejectedValue(new Error('Failed to get "write" lock'))
      await expectStorageError(mgr.snapshotExists('/d.qcow2', 'snap1'), StorageErrorCode.COMMAND_FAILED)
    })
  })
})
