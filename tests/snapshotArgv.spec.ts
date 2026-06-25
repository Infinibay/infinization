import { SnapshotManager } from '../src/storage/SnapshotManager'
import { CommandExecutor } from '../src/utils/commandExecutor'

describe('SnapshotManager — argv safety (I17) + fail-closed exists (M10)', () => {
  let execSpy: jest.SpyInstance
  let mgr: SnapshotManager

  beforeEach(() => {
    execSpy = jest.spyOn(CommandExecutor.prototype, 'execute').mockResolvedValue('')
    mgr = new SnapshotManager()
  })

  afterEach(() => jest.restoreAllMocks())

  it('createSnapshot passes the -- argv terminator before the image path', async () => {
    await mgr.createSnapshot({ imagePath: '/var/lib/x.qcow2', name: 'snap1' })
    const args = execSpy.mock.calls[0][1] as string[]
    expect(args).toEqual(['snapshot', '-c', 'snap1', '--', '/var/lib/x.qcow2'])
  })

  it('revertSnapshot includes -- and validates the snapshot name', async () => {
    await mgr.revertSnapshot('/var/lib/x.qcow2', 'snap1')
    const args = execSpy.mock.calls[0][1] as string[]
    expect(args).toEqual(['snapshot', '-a', 'snap1', '--', '/var/lib/x.qcow2'])
  })

  it('revertSnapshot rejects an invalid (empty) snapshot name before running qemu-img', async () => {
    await expect(mgr.revertSnapshot('/var/lib/x.qcow2', '')).rejects.toThrow()
    expect(execSpy).not.toHaveBeenCalled()
  })

  it('deleteSnapshot includes -- terminator', async () => {
    await mgr.deleteSnapshot('/var/lib/x.qcow2', 'snap1')
    const args = execSpy.mock.calls[0][1] as string[]
    expect(args).toEqual(['snapshot', '-d', 'snap1', '--', '/var/lib/x.qcow2'])
  })
})
