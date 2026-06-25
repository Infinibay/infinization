import { BackupScheduler, ScheduleAdapter, ScheduledJob } from '../src/backup/BackupScheduler'
import { BackupService } from '../src/backup/BackupService'
import { BackupType } from '../src/types/backup.types'

/** Minimal manual cron adapter that lets the test fire a schedule's callback. */
function makeAdapter (): { adapter: ScheduleAdapter, fire: () => void } {
  let cb: (() => void) | null = null
  const job: ScheduledJob = { stop: () => {}, getNextRunDate: () => undefined }
  return {
    adapter: { schedule: (_expr, callback) => { cb = callback; return job } },
    fire: () => { if (cb) cb() }
  }
}

describe('BackupScheduler — disk path resolution (B10)', () => {
  it('resolves disk paths via the injected resolver and passes them to createBackup', async () => {
    const createBackup = jest.fn().mockResolvedValue({ success: true, backupId: 'b1' })
    const backupService = { createBackup, listBackups: jest.fn().mockResolvedValue([]) } as unknown as BackupService
    const { adapter, fire } = makeAdapter()

    const scheduler = new BackupScheduler(backupService, adapter, {
      diskPathResolver: async (vmId) => [`/disks/${vmId}-0.qcow2`]
    })

    scheduler.addSchedule({
      id: 's1', vmId: 'vm-1', type: BackupType.FULL,
      cronExpression: '0 2 * * 0', retentionCount: 3,
      destinationDir: '/backups', enabled: true
    })

    const failed = new Promise<void>((resolve) => scheduler.once('schedule:failed', () => resolve()))
    fire()
    // give the async tick a moment
    await new Promise((r) => setTimeout(r, 20))

    expect(createBackup).toHaveBeenCalledTimes(1)
    expect(createBackup.mock.calls[0][0].diskPaths).toEqual(['/disks/vm-1-0.qcow2'])
    void failed
  })

  it('FAILS LOUDLY (schedule:failed) when no disk paths can be resolved', async () => {
    const createBackup = jest.fn().mockResolvedValue({ success: true, backupId: 'b1' })
    const backupService = { createBackup, listBackups: jest.fn().mockResolvedValue([]) } as unknown as BackupService
    const { adapter, fire } = makeAdapter()

    const scheduler = new BackupScheduler(backupService, adapter) // no resolver, no schedule.diskPaths

    const failed = new Promise<Error>((resolve) => scheduler.once('schedule:failed', (_s, err) => resolve(err)))

    scheduler.addSchedule({
      id: 's2', vmId: 'vm-2', type: BackupType.FULL,
      cronExpression: '0 2 * * 0', retentionCount: 3,
      destinationDir: '/backups', enabled: true
    })
    fire()

    const err = await failed
    expect(err.message).toMatch(/no disk paths/i)
    expect(createBackup).not.toHaveBeenCalled()
  })
})
