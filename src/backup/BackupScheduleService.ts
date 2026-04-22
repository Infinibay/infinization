/**
 * BackupScheduleService — Persistent schedule management with CRUD API
 *
 * Wraps `BackupScheduler` with file-based JSON persistence so that backup
 * schedules survive process restarts. Provides a clean CRUD interface:
 *
 * - `createSchedule(input)` — validate, persist and start a new schedule.
 * - `updateSchedule(id, partial)` — merge changes, persist, restart the job.
 * - `deleteSchedule(id)` — stop the job, remove from disk.
 * - `listSchedules(vmId?)` — list all or filtered by VM.
 * - `enableSchedule(id)` / `disableSchedule(id)` — toggle without deleting.
 * - `start()` / `stop()` — call on server startup / shutdown.
 *
 * Persistence is a single JSON file (`schedules.json`) stored in the backup
 * root directory. The format is versioned so future migrations are easy.
 */

import { EventEmitter } from 'events'
import { readFile, writeFile, mkdir, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import { join } from 'path'

import { BackupService } from './BackupService'
import { BackupScheduler, ScheduleAdapter } from './BackupScheduler'
import { Debugger } from '../utils/debug'

import {
  BackupType,
  BackupCompression,
  BackupSchedule,
  BackupError,
  BackupErrorCode,
  DEFAULT_BACKUP_COMPRESSION,
  DEFAULT_BACKUP_DIR,
  DEFAULT_RETENTION_COUNT
} from '../types/backup.types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for constructing BackupScheduleService. */
export interface BackupScheduleServiceOptions {
  /** Root directory for backups and schedule persistence (default: DEFAULT_BACKUP_DIR) */
  backupRootDir?: string
}

/** Input type for creating a new schedule. Omits auto-generated fields. */
export interface CreateScheduleInput {
  /** VM identifier this schedule applies to */
  vmId: string
  /** Type of backup this schedule creates */
  type: BackupType
  /** Cron expression (e.g. '0 2 * * 0' = Sundays at 2 AM) */
  cronExpression: string
  /** Maximum backups to keep. 0 = unlimited. Defaults to DEFAULT_RETENTION_COUNT */
  retentionCount?: number
  /** Destination directory for backups created by this schedule */
  destinationDir?: string
  /** Compression algorithm */
  compression?: BackupCompression
  /** Whether the schedule should be active immediately (default: true) */
  enabled?: boolean
  /** Human-readable label */
  label?: string
}

/** Input type for updating an existing schedule. All fields optional. */
export interface UpdateScheduleInput {
  type?: BackupType
  cronExpression?: string
  retentionCount?: number
  destinationDir?: string
  compression?: BackupCompression
  enabled?: boolean
  label?: string
}

/** Versioned persistence format for forward-compatible migrations. */
interface ScheduleStore {
  /** Schema version for future migration support */
  version: 1
  /** ISO timestamp of last write */
  updatedAt: string
  /** All persisted schedules */
  schedules: BackupSchedule[]
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface BackupScheduleServiceEvents {
  /** Fired after a schedule is created. */
  'schedule:created': (schedule: BackupSchedule) => void
  /** Fired after a schedule is updated. */
  'schedule:updated': (schedule: BackupSchedule) => void
  /** Fired after a schedule is deleted. */
  'schedule:deleted': (scheduleId: string) => void
  /** Fired when a schedule is enabled. */
  'schedule:enabled': (schedule: BackupSchedule) => void
  /** Fired when a schedule is disabled. */
  'schedule:disabled': (schedule: BackupSchedule) => void
  /** Fired when schedules are loaded from disk. */
  'loaded': (count: number) => void
  /** Fired when schedules are persisted to disk. */
  'persisted': (count: number) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEDULES_FILENAME = 'schedules.json'

// ---------------------------------------------------------------------------
// BackupScheduleService
// ---------------------------------------------------------------------------

export class BackupScheduleService extends EventEmitter {
  private readonly scheduler: BackupScheduler
  private readonly backupService: BackupService
  private readonly debug: Debugger
  private readonly backupRootDir: string
  private readonly storePath: string

  /** In-memory cache of all schedules. */
  private readonly schedules: Map<string, BackupSchedule> = new Map()

  constructor (
    backupService: BackupService,
    adapter: ScheduleAdapter,
    options?: BackupScheduleServiceOptions
  ) {
    super()
    this.backupService = backupService
    this.scheduler = new BackupScheduler(backupService, adapter, options?.backupRootDir)
    this.debug = new Debugger('backup-schedule-service')
    this.backupRootDir = options?.backupRootDir ?? DEFAULT_BACKUP_DIR
    this.storePath = join(this.backupRootDir, SCHEDULES_FILENAME)
  }

  // ===========================================================================
  // Public API — CRUD
  // ===========================================================================

  /**
   * Creates a new backup schedule, persists it, and starts its cron job if enabled.
   *
   * @param input - Schedule creation parameters.
   * @returns The newly created BackupSchedule.
   * @throws BackupError on validation failure.
   */
  async createSchedule (input: CreateScheduleInput): Promise<BackupSchedule> {
    this.validateCreateInput(input)

    const schedule: BackupSchedule = {
      id: randomUUID(),
      vmId: input.vmId,
      type: input.type,
      cronExpression: input.cronExpression,
      retentionCount: input.retentionCount ?? DEFAULT_RETENTION_COUNT,
      destinationDir: input.destinationDir ?? join(this.backupRootDir, input.vmId),
      compression: input.compression ?? DEFAULT_BACKUP_COMPRESSION,
      enabled: input.enabled ?? true,
      label: input.label
    }

    // Register with the in-memory scheduler (starts cron if enabled)
    this.scheduler.addSchedule(schedule)

    // Persist to memory cache and disk
    this.schedules.set(schedule.id, schedule)
    await this.persist()

    this.debug.log(`Schedule created: ${schedule.id} for VM ${schedule.vmId}`)
    this.emit('schedule:created', schedule)

    return { ...schedule }
  }

  /**
   * Updates an existing schedule with partial changes.
   *
   * Stops the current job, applies changes, restarts if enabled, and persists.
   *
   * @param id - Schedule identifier to update.
   * @param updates - Partial fields to merge.
   * @returns The updated BackupSchedule.
   * @throws BackupError if the schedule is not found.
   */
  async updateSchedule (id: string, updates: UpdateScheduleInput): Promise<BackupSchedule> {
    const existing = this.getScheduleOrThrow(id)

    // Merge updates
    const updated: BackupSchedule = {
      ...existing,
      ...(updates.type !== undefined && { type: updates.type }),
      ...(updates.cronExpression !== undefined && { cronExpression: updates.cronExpression }),
      ...(updates.retentionCount !== undefined && { retentionCount: updates.retentionCount }),
      ...(updates.destinationDir !== undefined && { destinationDir: updates.destinationDir }),
      ...(updates.compression !== undefined && { compression: updates.compression }),
      ...(updates.enabled !== undefined && { enabled: updates.enabled }),
      ...(updates.label !== undefined && { label: updates.label })
    }

    // Validate cron if changed
    if (updates.cronExpression !== undefined) {
      this.validateCronExpression(updates.cronExpression)
    }

    // Delegate to scheduler (stops old job, starts new if enabled)
    this.scheduler.updateSchedule(updated)

    // Update cache and persist
    this.schedules.set(id, updated)
    await this.persist()

    this.debug.log(`Schedule updated: ${id}`)
    this.emit('schedule:updated', updated)

    return { ...updated }
  }

  /**
   * Deletes a schedule by ID. Stops its job and removes from persistence.
   *
   * @param id - Schedule identifier to delete.
   * @throws BackupError if the schedule is not found.
   */
  async deleteSchedule (id: string): Promise<void> {
    this.getScheduleOrThrow(id)

    // Stop the cron job
    this.scheduler.removeSchedule(id)

    // Remove from cache and persist
    this.schedules.delete(id)
    await this.persist()

    this.debug.log(`Schedule deleted: ${id}`)
    this.emit('schedule:deleted', id)
  }

  /**
   * Returns all schedules, optionally filtered by VM identifier.
   *
   * @param vmId - Optional VM identifier to filter by.
   * @returns Array of BackupSchedule objects.
   */
  async listSchedules (vmId?: string): Promise<BackupSchedule[]> {
    const all = Array.from(this.schedules.values())

    if (vmId) {
      return all.filter((s) => s.vmId === vmId).map((s) => ({ ...s }))
    }

    return all.map((s) => ({ ...s }))
  }

  /**
   * Returns a specific schedule by ID.
   *
   * @param id - Schedule identifier.
   * @returns The BackupSchedule or undefined if not found.
   */
  async getSchedule (id: string): Promise<BackupSchedule | undefined> {
    const schedule = this.schedules.get(id)
    return schedule ? { ...schedule } : undefined
  }

  // ===========================================================================
  // Public API — Enable / Disable
  // ===========================================================================

  /**
   * Enables a previously disabled schedule. Starts the cron job immediately.
   *
   * @param id - Schedule identifier to enable.
   * @returns The enabled BackupSchedule.
   * @throws BackupError if the schedule is not found.
   */
  async enableSchedule (id: string): Promise<BackupSchedule> {
    const schedule = this.getScheduleOrThrow(id)

    if (schedule.enabled) {
      return { ...schedule } // Already enabled — idempotent
    }

    return await this.updateSchedule(id, { enabled: true })
  }

  /**
   * Disables a schedule. Stops its cron job but keeps the schedule persisted.
   *
   * @param id - Schedule identifier to disable.
   * @returns The disabled BackupSchedule.
   * @throws BackupError if the schedule is not found.
   */
  async disableSchedule (id: string): Promise<BackupSchedule> {
    const schedule = this.getScheduleOrThrow(id)

    if (!schedule.enabled) {
      return { ...schedule } // Already disabled — idempotent
    }

    return await this.updateSchedule(id, { enabled: false })
  }

  // ===========================================================================
  // Public API — Lifecycle
  // ===========================================================================

  /**
   * Starts the service. Loads persisted schedules from disk and activates
   * all enabled schedules. Call on server startup.
   */
  async start (): Promise<void> {
    await this.loadFromDisk()
    this.debug.log(`BackupScheduleService started with ${this.schedules.size} schedule(s)`)
  }

  /**
   * Stops the service. Persists current state and stops all cron jobs.
   * Call on server shutdown.
   */
  async stop (): Promise<void> {
    await this.persist()
    this.scheduler.stopAll()
    this.debug.log('BackupScheduleService stopped')
  }

  /**
   * Returns the number of registered schedules.
   */
  get scheduleCount (): number {
    return this.schedules.size
  }

  /**
   * Returns the number of currently active (enabled + running) cron jobs.
   */
  get activeJobCount (): number {
    return this.scheduler.activeJobCount
  }

  // ===========================================================================
  // Private — Persistence
  // ===========================================================================

  /**
   * Loads schedules from the JSON store file into memory and registers
   * them with the BackupScheduler.
   */
  private async loadFromDisk (): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.storePath, 'utf-8')
    } catch {
      // File doesn't exist yet — that's fine, start fresh
      this.debug.log('No existing schedules file found — starting fresh')
      this.emit('loaded', 0)
      return
    }

    let store: ScheduleStore
    try {
      store = JSON.parse(raw) as ScheduleStore
    } catch {
      this.debug.log('error', `Corrupt schedules file at ${this.storePath} — starting fresh`)
      this.emit('loaded', 0)
      return
    }

    if (store.version !== 1 || !Array.isArray(store.schedules)) {
      this.debug.log('error', `Unsupported schedules store version: ${store.version}`)
      this.emit('loaded', 0)
      return
    }

    // Load into memory and register with scheduler
    for (const schedule of store.schedules) {
      this.schedules.set(schedule.id, schedule)

      try {
        this.scheduler.addSchedule(schedule)
      } catch (error) {
        this.debug.log(
          'error',
          `Failed to register schedule ${schedule.id}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    this.debug.log(`Loaded ${this.schedules.size} schedule(s) from disk`)
    this.emit('loaded', this.schedules.size)
  }

  /**
   * Persists all in-memory schedules to the JSON store file.
   */
  private async persist (): Promise<void> {
    const store: ScheduleStore = {
      version: 1,
      updatedAt: new Date().toISOString(),
      schedules: Array.from(this.schedules.values())
    }

    // Ensure directory exists
    await mkdir(this.backupRootDir, { recursive: true })

    await writeFile(this.storePath, JSON.stringify(store, null, 2), 'utf-8')

    this.debug.log(`Persisted ${store.schedules.length} schedule(s) to ${this.storePath}`)
    this.emit('persisted', store.schedules.length)
  }

  // ===========================================================================
  // Private — Validation
  // ===========================================================================

  /** Validates required fields for schedule creation. */
  private validateCreateInput (input: CreateScheduleInput): void {
    if (!input.vmId || input.vmId.trim().length === 0) {
      throw new BackupError(BackupErrorCode.INVALID_CONFIG, 'vmId is required')
    }

    if (!input.cronExpression || input.cronExpression.trim().length === 0) {
      throw new BackupError(BackupErrorCode.INVALID_CONFIG, 'cronExpression is required')
    }

    this.validateCronExpression(input.cronExpression)

    if (!Object.values(BackupType).includes(input.type)) {
      throw new BackupError(
        BackupErrorCode.INVALID_CONFIG,
        `Invalid backup type: ${input.type}`
      )
    }

    if (input.retentionCount !== undefined && input.retentionCount < 0) {
      throw new BackupError(
        BackupErrorCode.INVALID_CONFIG,
        'retentionCount must be >= 0'
      )
    }
  }

  /**
   * Basic cron expression validation — ensures 5 space-separated fields.
   * The ScheduleAdapter will throw its own error if the expression is truly invalid;
   * this is just a quick sanity check.
   */
  private validateCronExpression (expr: string): void {
    const parts = expr.trim().split(/\s+/)
    if (parts.length !== 5) {
      throw new BackupError(
        BackupErrorCode.INVALID_CONFIG,
        `Invalid cron expression '${expr}': expected 5 fields (minute hour day month weekday)`
      )
    }
  }

  /** Returns a schedule or throws BACKUP_NOT_FOUND. */
  private getScheduleOrThrow (id: string): BackupSchedule {
    const schedule = this.schedules.get(id)
    if (!schedule) {
      throw new BackupError(
        BackupErrorCode.BACKUP_NOT_FOUND,
        `Schedule not found: ${id}`
      )
    }
    return schedule
  }
}
