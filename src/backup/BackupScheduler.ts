/**
 * BackupScheduler — Backup schedule manager with retention enforcement
 *
 * Accepts `BackupSchedule` entries and manages their lifecycle. Uses a
 * pluggable `ScheduleAdapter` interface so the actual cron implementation
 * (e.g. the `cron` npm package) is provided by the consumer — keeping
 * infinization dependency-free except for `debug`.
 *
 * The backend layer will instantiate BackupScheduler with a CronAdapter
 * that wraps the `cron` package.
 */

import { EventEmitter } from 'events'
import { join } from 'path'

import { BackupService } from './BackupService'
import { Debugger } from '../utils/debug'

import {
  BackupSchedule,
  BackupMetadata,
  BackupError,
  BackupErrorCode,
  DEFAULT_BACKUP_COMPRESSION,
  DEFAULT_BACKUP_DIR
} from '../types/backup.types'

// ---------------------------------------------------------------------------
// Adapter Interface — implemented by the consumer (backend)
// ---------------------------------------------------------------------------

/**
 * Interface for a scheduled job. Provided by the ScheduleAdapter implementation.
 */
export interface ScheduledJob {
  /** Stop the scheduled job. */
  stop (): void
  /** Get the next execution date as an ISO string, if available. */
  getNextRunDate (): string | undefined
}

/**
 * Adapter interface that the consumer must implement to provide actual
 * cron-based scheduling. The backend will implement this using the `cron` package.
 *
 * @example
 * ```typescript
 * import { CronJob } from 'cron'
 * const adapter: ScheduleAdapter = {
 *   schedule(cronExpression, callback) {
 *     const job = new CronJob(cronExpression, callback, undefined, true)
 *     return {
 *       stop: () => job.stop(),
 *       getNextRunDate: () => job.nextDate()?.toISO()
 *     }
 *   }
 * }
 * ```
 */
export interface ScheduleAdapter {
  /**
   * Schedule a recurring callback using a cron expression.
   *
   * @param cronExpression - Standard cron expression (e.g. '0 2 * * 0').
   * @param callback - Function to invoke on each tick.
   * @returns A ScheduledJob handle.
   * @throws Error if the cron expression is invalid.
   */
  schedule (cronExpression: string, callback: () => void): ScheduledJob
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Events emitted by BackupScheduler. */
export interface BackupSchedulerEvents {
  /** Fired when a scheduled backup starts. */
  'schedule:started': (schedule: BackupSchedule) => void
  /** Fired when a scheduled backup completes successfully. */
  'schedule:completed': (schedule: BackupSchedule, metadata: BackupMetadata) => void
  /** Fired when a scheduled backup fails. */
  'schedule:failed': (schedule: BackupSchedule, error: Error) => void
}

// ---------------------------------------------------------------------------
// BackupScheduler
// ---------------------------------------------------------------------------

/** Resolves the disk image paths for a VM at backup time (vmId -> paths). */
export type DiskPathResolver = (vmId: string) => Promise<string[]> | string[]

/** Options for the BackupScheduler. */
export interface BackupSchedulerOptions {
  backupRootDir?: string
  /** Resolves disk paths for a schedule that does not carry its own. */
  diskPathResolver?: DiskPathResolver
}

export class BackupScheduler extends EventEmitter {
  private readonly backupService: BackupService
  private readonly debug: Debugger
  private readonly backupRootDir: string
  private readonly adapter: ScheduleAdapter
  private readonly diskPathResolver?: DiskPathResolver

  /** Active scheduled jobs keyed by schedule ID. */
  private readonly jobs: Map<string, ScheduledJob> = new Map()

  /** Registered schedules keyed by schedule ID. */
  private readonly schedules: Map<string, BackupSchedule> = new Map()

  /**
   * @param backupService - The BackupService instance to trigger backups on.
   * @param adapter - The ScheduleAdapter that provides actual cron scheduling.
   * @param options - Root dir + an optional disk-path resolver. (A bare string is
   *   accepted for backwards compatibility and treated as backupRootDir.)
   */
  constructor (
    backupService: BackupService,
    adapter: ScheduleAdapter,
    options?: string | BackupSchedulerOptions
  ) {
    super()
    this.backupService = backupService
    this.adapter = adapter
    this.debug = new Debugger('backup-scheduler')
    const opts: BackupSchedulerOptions = typeof options === 'string' ? { backupRootDir: options } : (options ?? {})
    this.backupRootDir = opts.backupRootDir ?? DEFAULT_BACKUP_DIR
    this.diskPathResolver = opts.diskPathResolver
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Adds a backup schedule and starts its job if enabled.
   *
   * @param schedule - The schedule configuration.
   * @throws BackupError if the schedule ID is a duplicate.
   */
  addSchedule (schedule: BackupSchedule): void {
    if (this.schedules.has(schedule.id)) {
      throw new BackupError(
        BackupErrorCode.BACKUP_EXISTS,
        `Schedule already exists: ${schedule.id}`,
        { vmId: schedule.vmId }
      )
    }

    this.schedules.set(schedule.id, schedule)

    if (schedule.enabled) {
      this.startJob(schedule)
    }

    this.debug.log(`Schedule added: ${schedule.id} (${schedule.cronExpression})`)
  }

  /**
   * Removes a schedule and stops its job.
   *
   * @param scheduleId - The schedule ID to remove.
   */
  removeSchedule (scheduleId: string): void {
    this.stopJob(scheduleId)
    this.schedules.delete(scheduleId)
    this.debug.log(`Schedule removed: ${scheduleId}`)
  }

  /**
   * Updates an existing schedule. Stops the old job and starts a new one if enabled.
   *
   * @param schedule - Updated schedule configuration.
   */
  updateSchedule (schedule: BackupSchedule): void {
    this.stopJob(schedule.id)
    this.schedules.set(schedule.id, schedule)

    if (schedule.enabled) {
      this.startJob(schedule)
    }

    this.debug.log(`Schedule updated: ${schedule.id}`)
  }

  /**
   * Returns all registered schedules.
   */
  getAllSchedules (): BackupSchedule[] {
    return Array.from(this.schedules.values())
  }

  /**
   * Returns a specific schedule by ID.
   */
  getSchedule (scheduleId: string): BackupSchedule | undefined {
    return this.schedules.get(scheduleId)
  }

  /**
   * Stops all scheduled jobs. Call on server shutdown.
   */
  stopAll (): void {
    for (const [id, job] of this.jobs) {
      job.stop()
      this.debug.log(`Stopped job for schedule: ${id}`)
    }
    this.jobs.clear()
  }

  /**
   * Starts all registered enabled schedules. Call on server startup.
   */
  startAll (): void {
    for (const schedule of this.schedules.values()) {
      if (schedule.enabled) {
        this.startJob(schedule)
      }
    }
    this.debug.log(`Started ${this.jobs.size} schedule(s)`)
  }

  /**
   * Returns the number of active scheduled jobs.
   */
  get activeJobCount (): number {
    return this.jobs.size
  }

  // =========================================================================
  // Private — Scheduling
  // =========================================================================

  /**
   * Starts a job for the given schedule using the ScheduleAdapter.
   */
  private startJob (schedule: BackupSchedule): void {
    // Stop existing job if any
    this.stopJob(schedule.id)

    try {
      const job = this.adapter.schedule(schedule.cronExpression, () => {
        void this.executeScheduledBackup(schedule)
      })

      this.jobs.set(schedule.id, job)

      // Update nextRunAt
      schedule.nextRunAt = job.getNextRunDate()

      this.debug.log(`Job started for schedule ${schedule.id}: ${schedule.cronExpression}`)
    } catch (error) {
      throw new BackupError(
        BackupErrorCode.INVALID_CONFIG,
        `Invalid cron expression '${schedule.cronExpression}': ${error instanceof Error ? error.message : String(error)}`,
        { vmId: schedule.vmId }
      )
    }
  }

  /**
   * Stops a job by schedule ID.
   */
  private stopJob (scheduleId: string): void {
    const job = this.jobs.get(scheduleId)
    if (job) {
      job.stop()
      this.jobs.delete(scheduleId)
    }
  }

  /**
   * Executes a backup for the given schedule, then enforces retention.
   */
  private async executeScheduledBackup (schedule: BackupSchedule): Promise<void> {
    this.debug.log(`Executing scheduled backup for VM ${schedule.vmId} (schedule: ${schedule.id})`)
    this.emit('schedule:started', schedule)

    try {
      const destDir = join(schedule.destinationDir ?? this.backupRootDir, schedule.vmId)

      // Resolve the real disk paths. Previously hardcoded to [], which made every
      // scheduled run fail validateConfig BEFORE any qemu-img ran — silent total
      // backup loss. Now: use the schedule's own paths, else the injected
      // resolver, and fail LOUDLY (not into a debug log) if none are available.
      const diskPaths = schedule.diskPaths?.length
        ? schedule.diskPaths
        : (this.diskPathResolver ? await this.diskPathResolver(schedule.vmId) : [])
      if (!diskPaths.length) {
        throw new BackupError(
          BackupErrorCode.INVALID_CONFIG,
          `No disk paths for scheduled backup of VM ${schedule.vmId} (schedule ${schedule.id}); set schedule.diskPaths or provide a diskPathResolver`,
          { vmId: schedule.vmId }
        )
      }

      const result = await this.backupService.createBackup({
        vmId: schedule.vmId,
        diskPaths,
        destinationDir: destDir,
        type: schedule.type,
        compression: schedule.compression ?? DEFAULT_BACKUP_COMPRESSION,
        description: `Scheduled backup (${schedule.label ?? schedule.id})`,
        tags: ['scheduled', schedule.id]
      })

      // Update schedule timestamps
      schedule.lastRunAt = new Date().toISOString()
      const job = this.jobs.get(schedule.id)
      if (job) {
        schedule.nextRunAt = job.getNextRunDate()
      }

      // Enforce retention
      if (schedule.retentionCount > 0) {
        await this.enforceRetention(schedule)
      }

      this.debug.log(`Scheduled backup completed: ${result.backupId}`)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.debug.log('error', `Scheduled backup failed for schedule ${schedule.id}: ${err.message}`)
      this.emit('schedule:failed', schedule, err)
    }
  }

  /**
   * Enforces retention by deleting the oldest backups when the count
   * exceeds the configured retention count for a schedule.
   */
  private async enforceRetention (schedule: BackupSchedule): Promise<void> {
    try {
      const backups = await this.backupService.listBackups(schedule.vmId)

      // Filter to only backups created by this schedule (by tag)
      const scheduledBackups = backups.filter(
        (b) => b.tags?.includes('scheduled') && b.tags?.includes(schedule.id)
      )

      if (scheduledBackups.length <= schedule.retentionCount) {
        return // Within retention limit
      }

      // Sort oldest first
      scheduledBackups.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      )

      // Delete oldest backups exceeding retention
      const toDelete = scheduledBackups.slice(0, scheduledBackups.length - schedule.retentionCount)
      for (const backup of toDelete) {
        try {
          await this.backupService.deleteBackup(backup.id, schedule.vmId)
          this.debug.log(`Retention: deleted old backup ${backup.id}`)
        } catch (error) {
          this.debug.log(
            'error',
            `Retention: failed to delete backup ${backup.id}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    } catch (error) {
      this.debug.log(
        'error',
        `Retention enforcement failed for schedule ${schedule.id}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
