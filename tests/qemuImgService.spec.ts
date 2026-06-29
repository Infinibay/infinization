/**
 * Behavioural tests for QemuImgService — the IRREVERSIBLE disk-op surface
 * (create / resize / convert / info / check).
 *
 * These run WITHOUT a real `qemu-img` binary: CommandExecutor.execute is mocked,
 * so they exercise the fail-closed guards and error-mapping that real failures
 * trigger, on every platform and in CI. They complement (do not replace)
 * tests/backupRoundtrip.integration.spec.ts, which proves byte-level correctness
 * only where qemu-img is installed. See CODE_REVIEW_REPORT §C.4 TEST-04.
 */
import { QemuImgService } from '../src/storage/QemuImgService'
import { CommandExecutor } from '../src/utils/commandExecutor'
import { StorageError, StorageErrorCode } from '../src/types/storage.types'

/** Assert that a promise rejects with a StorageError carrying the given code. */
async function expectStorageError (p: Promise<unknown>, code: StorageErrorCode): Promise<StorageError> {
  const err = await p.then(
    () => { throw new Error('expected the operation to reject, but it resolved') },
    (e) => e
  )
  expect(err).toBeInstanceOf(StorageError)
  expect((err as StorageError).code).toBe(code)
  return err as StorageError
}

// The verbatim shape qemu-img uses when it cannot acquire the image lock (a
// running VM holds the write lock). Crucially it contains "Could not open" +
// "Failed to get" + "lock" but NEITHER "in use" NOR "locked" — the realistic
// input that catches a matcher only looking for 'in use'/'locked' (which would
// otherwise misclassify a live disk as IMAGE_NOT_FOUND). See CODE_REVIEW §C review.
const LOCK_ERR = `qemu-img: Could not open '/d.qcow2': Failed to get "write" lock\nIs another process using the image [/d.qcow2]?`

describe('QemuImgService — irreversible disk ops (behaviour, no real qemu-img)', () => {
  let execSpy: jest.SpyInstance
  let svc: QemuImgService

  beforeEach(() => {
    execSpy = jest.spyOn(CommandExecutor.prototype, 'execute')
    svc = new QemuImgService()
  })
  afterEach(() => jest.restoreAllMocks())

  describe('createImage', () => {
    it('rejects a backing-file (linked clone) on a non-qcow2 format BEFORE running qemu-img', async () => {
      execSpy.mockResolvedValue('')
      await expectStorageError(
        svc.createImage({ path: '/d.raw', sizeGB: 10, format: 'raw', backingFile: '/base.qcow2' }),
        StorageErrorCode.INVALID_FORMAT
      )
      expect(execSpy).not.toHaveBeenCalled()
    })

    it('builds a safe argv with the -- terminator for a plain qcow2 create', async () => {
      execSpy.mockResolvedValue('')
      await svc.createImage({ path: '/d.qcow2', sizeGB: 20, format: 'qcow2' })
      const args = execSpy.mock.calls[0][1] as string[]
      expect(args).toEqual(['create', '-f', 'qcow2', '--', '/d.qcow2', '20G'])
    })

    it('maps "already exists" to IMAGE_ALREADY_EXISTS', async () => {
      execSpy.mockRejectedValue(new Error("qemu-img: /d.qcow2: File exists"))
      await expectStorageError(
        svc.createImage({ path: '/d.qcow2', sizeGB: 1, format: 'qcow2' }),
        StorageErrorCode.IMAGE_ALREADY_EXISTS
      )
    })

    it('maps "Permission denied" to PERMISSION_DENIED', async () => {
      execSpy.mockRejectedValue(new Error('Permission denied'))
      await expectStorageError(
        svc.createImage({ path: '/d.qcow2', sizeGB: 1, format: 'qcow2' }),
        StorageErrorCode.PERMISSION_DENIED
      )
    })

    it('maps an unknown failure to COMMAND_FAILED', async () => {
      execSpy.mockRejectedValue(new Error('something exploded'))
      await expectStorageError(
        svc.createImage({ path: '/d.qcow2', sizeGB: 1, format: 'qcow2' }),
        StorageErrorCode.COMMAND_FAILED
      )
    })
  })

  describe('resizeImage (destructive: VM must be stopped)', () => {
    it('rejects a non-positive size BEFORE running qemu-img (fail-closed guard)', async () => {
      execSpy.mockResolvedValue('')
      await expectStorageError(svc.resizeImage('/d.qcow2', 0), StorageErrorCode.INVALID_SIZE)
      await expectStorageError(svc.resizeImage('/d.qcow2', -5), StorageErrorCode.INVALID_SIZE)
      expect(execSpy).not.toHaveBeenCalled()
    })

    it('uses the -- terminator before the path', async () => {
      execSpy.mockResolvedValue('')
      await svc.resizeImage('/d.qcow2', 40)
      const args = execSpy.mock.calls[0][1] as string[]
      expect(args).toEqual(['resize', '--', '/d.qcow2', '40G'])
    })

    it('maps a REAL qemu-img lock failure to IMAGE_IN_USE (not IMAGE_NOT_FOUND) — do not resize a live disk', async () => {
      execSpy.mockRejectedValue(new Error(LOCK_ERR))
      await expectStorageError(svc.resizeImage('/d.qcow2', 40), StorageErrorCode.IMAGE_IN_USE)
    })

    it('maps a missing image to IMAGE_NOT_FOUND', async () => {
      execSpy.mockRejectedValue(new Error('Could not open /d.qcow2: No such file or directory'))
      await expectStorageError(svc.resizeImage('/d.qcow2', 40), StorageErrorCode.IMAGE_NOT_FOUND)
    })
  })

  describe('getImageInfo', () => {
    it('parses format/sizes and snapshots from --output=json', async () => {
      execSpy.mockResolvedValue(JSON.stringify({
        filename: '/d.qcow2', format: 'qcow2', 'virtual-size': 1024, 'actual-size': 512,
        snapshots: [{ id: '1', name: 'snap1', 'vm-state-size': 0, date: '2024-01-01', 'vm-clock-sec': '0' }]
      }))
      const info = await svc.getImageInfo('/d.qcow2')
      expect(info.format).toBe('qcow2')
      expect(info.virtualSize).toBe(1024)
      expect(info.snapshots).toHaveLength(1)
      expect(info.snapshots?.[0].name).toBe('snap1')
      expect(execSpy.mock.calls[0][1]).toEqual(['info', '--output=json', '--', '/d.qcow2'])
    })

    it('maps a lock failure to IMAGE_IN_USE', async () => {
      execSpy.mockRejectedValue(new Error(LOCK_ERR))
      await expectStorageError(svc.getImageInfo('/d.qcow2'), StorageErrorCode.IMAGE_IN_USE)
    })

    it('maps invalid JSON to PARSE_ERROR', async () => {
      execSpy.mockResolvedValue('not-json{')
      await expectStorageError(svc.getImageInfo('/d.qcow2'), StorageErrorCode.PARSE_ERROR)
    })
  })

  describe('convertImage', () => {
    it('re-throws a StorageError from the source-info probe (e.g. missing source) unchanged', async () => {
      // First call is getImageInfo(source) → reject as missing.
      execSpy.mockRejectedValueOnce(new Error('Could not open /src.qcow2: No such file'))
      await expectStorageError(
        svc.convertImage({ sourcePath: '/src.qcow2', destPath: '/dst.qcow2', destFormat: 'qcow2' }),
        StorageErrorCode.IMAGE_NOT_FOUND
      )
    })

    it('builds a hardened argv (-t none + -- terminator) on the convert call', async () => {
      execSpy.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'info') return Promise.resolve(JSON.stringify({ filename: '/src.qcow2', format: 'qcow2', 'virtual-size': 1 }))
        return Promise.resolve('')
      })
      await svc.convertImage({ sourcePath: '/src.qcow2', destPath: '/dst.qcow2', destFormat: 'qcow2' })
      const convertArgs = execSpy.mock.calls.find(c => (c[1] as string[])[0] === 'convert')![1] as string[]
      expect(convertArgs).toContain('-t')
      expect(convertArgs).toContain('none')
      expect(convertArgs.slice(-3)).toEqual(['--', '/src.qcow2', '/dst.qcow2'])
    })
  })

  describe('checkImage', () => {
    it('does NOT throw when corruption is found — returns the parsed report off non-zero exit', async () => {
      // qemu-img check exits non-zero on corruption but still writes the JSON report;
      // CommandExecutor surfaces it on err.stdout.
      const report = JSON.stringify({ 'check-errors': 2, leaks: 1, corruptions: 3, 'total-clusters': 100, 'allocated-clusters': 50 })
      const err = Object.assign(new Error('qemu-img check exited 3'), { stdout: report })
      execSpy.mockRejectedValue(err)
      const res = await svc.checkImage('/d.qcow2')
      expect(res.corruptions).toBe(3)
      expect(res.errors).toBe(2)
      expect(res.leaks).toBe(1)
    })

    it('maps a lock failure to IMAGE_IN_USE', async () => {
      execSpy.mockRejectedValue(new Error(LOCK_ERR))
      await expectStorageError(svc.checkImage('/d.qcow2'), StorageErrorCode.IMAGE_IN_USE)
    })
  })
})
