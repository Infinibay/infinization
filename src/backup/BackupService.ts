/**
 * BackupService — Orchestrates VM backup operations
 *
 * Supports three backup strategies:
 * - **FULL**: Complete disk copy via `qemu-img convert`. Independent, portable.
 * - **INCREMENTAL**: qcow2 overlay on top of a parent backup (backing-file chain).
 *   Smaller and faster but requires the parent chain to restore.
 * - **SNAPSHOT**: Internal qcow2 snapshot via `SnapshotManager`. Near-instant,
 *   copy-on-write, best for short-lived checkpoints.
 *
 * Each backup produces a `BackupMetadata` JSON manifest stored alongside the
 * backup files for self-description and easy discovery.
 */

import { EventEmitter } from 'events'
import { mkdir, readFile, writeFile, rm, stat, readdir, rename, unlink, copyFile, open } from 'fs/promises'
import { randomUUID } from 'crypto'
import { join, dirname, resolve as resolvePath, basename } from 'path'

import { QemuImgService } from '../storage/QemuImgService'
import { SnapshotManager } from '../storage/SnapshotManager'
import { CommandExecutor } from '../utils/commandExecutor'
import { KeyedMutex } from '../utils/KeyedMutex'
import { Debugger } from '../utils/debug'

import {
  BackupType,
  BackupStatus,
  BackupCompression,
  BackupConfig,
  BackupRestoreOptions,
  BackupMetadata,
  BackupDiskInfo,
  BackupResult,
  BackupRestoreResult,
  BackupProgress,
  BackupError,
  BackupErrorCode,
  BACKUP_MANIFEST_FILENAME,
  DEFAULT_BACKUP_COMPRESSION,
  DEFAULT_BACKUP_DIR,
  MAX_CONCURRENT_BACKUPS
} from '../types/backup.types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Probe the live power state of a VM. Returns `true` if the VM is running (its
 * disk is mounted by a live QEMU and unsafe to copy without quiescing), `false`
 * if stopped, or `null`/`undefined` when the state cannot be determined.
 *
 * Fail-closed contract: a `null`/`undefined`/throwing probe is treated as
 * "possibly running" and the backup is refused unless quiesce succeeds — we
 * never silently copy a live disk on an unknown state.
 */
export type IsVmRunningProbe = (vmId: string) => Promise<boolean | null> | boolean | null

/**
 * Minimal guest-quiesce handle (a structural subset of GuestAgentClient) used
 * to freeze/thaw guest filesystems around a live-disk read. The caller supplies
 * a connected (or connectable) instance via {@link GuestAgentFactory}.
 */
export interface GuestQuiesce {
  fsFreeze (): Promise<number>
  fsThaw (): Promise<number>
  isConnected?: () => boolean
  connect?: () => Promise<void>
  disconnect?: () => Promise<void>
}

/**
 * Builds a guest-quiesce handle for a given VM (typically `new GuestAgentClient(
 * guestAgentSocketPath)`), or returns null if the VM has no guest agent. May
 * throw / return null when the agent is unreachable — BackupService then falls
 * back to a transient snapshot.
 */
export type GuestAgentFactory = (vmId: string) => Promise<GuestQuiesce | null> | GuestQuiesce | null

/** Options accepted by the BackupService constructor. */
export interface BackupServiceOptions {
  /** Root directory for all backup storage (default: DEFAULT_BACKUP_DIR) */
  backupRootDir?: string
  /**
   * Probe for whether a VM is currently running. Injected by the caller (the
   * library does not own the VM lifecycle). When provided, FULL/INCREMENTAL
   * backups of a running VM are quiesced or snapshotted instead of read live;
   * when ABSENT, a running VM cannot be detected and the live-copy hardening is
   * skipped (legacy behavior) — callers wanting the guard MUST inject this.
   */
  isVmRunning?: IsVmRunningProbe
  /**
   * Factory that yields a guest-agent quiesce handle for a VM. Used to
   * `guest-fsfreeze-freeze`/`-thaw` around a live-disk read so the backup is
   * filesystem-consistent. If omitted (or it returns null), BackupService falls
   * back to a transient internal snapshot for a running VM.
   */
  guestAgentFactory?: GuestAgentFactory
}

/**
 * Internal plan describing how a FULL/INCREMENTAL backup will read each source
 * disk safely when the VM may be live. Built by {@link BackupService.prepareLiveRead}
 * and torn down by {@link BackupService.cleanupLiveRead}.
 */
interface LiveReadStrategy {
  /** Whether the VM was detected running at backup time. */
  running: boolean
  /** True if the read is only crash-consistent (live, no successful quiesce). */
  crashConsistent: boolean
  /** Connected guest-agent handle that froze the FS (thawed on cleanup), if any. */
  quiesce: GuestQuiesce | null
  /**
   * Per-source-disk override of the path to actually read from. When a transient
   * snapshot fallback is used, the original live `sourcePath` maps to a
   * materialized temp image; reading that instead of the live disk avoids torn
   * reads. Empty when reading live disks directly (stopped VM, or quiesced).
   */
  readFrom: Map<string, string>
  /** Transient snapshots created on live disks: sourcePath -> snapshotName. */
  transientSnapshots: Map<string, string>
  /** Temp image files materialized from transient snapshots (to unlink). */
  tempFiles: string[]
}

/**
 * One level of a relocated INCREMENTAL backing chain, as resolved by
 * {@link BackupService.verifyIncrementalChain}. The chain is ordered from the
 * overlay being restored DOWN toward the FULL base.
 *
 *  - `overlayPath` is the recorded (pristine) backup file at this level — the
 *    top entry is the overlay being restored; deeper entries are its ancestors.
 *  - `resolvedParent` is that overlay's parent backing file, re-rooted under the
 *    CURRENT backupRootDir and verified to exist (stat'd) — i.e. the path the
 *    embedded backing pointer SHOULD point at after a backup-dir move.
 *  - `parentIsBase` is true when `resolvedParent` is the read-only FULL base
 *    (it terminates the chain and is never copied/mutated during restore).
 */
interface ResolvedChainLevel {
  overlayPath: string
  resolvedParent: string
  parentIsBase: boolean
}

/** Event map emitted by BackupService during operations. */
export interface BackupServiceEvents {
  /** Fired periodically during a backup with progress info. */
  progress: (progress: BackupProgress) => void
  /** Fired when a backup completes (success or failure). */
  completed: (metadata: BackupMetadata) => void
  /** Fired when a backup restore finishes. */
  restored: (result: BackupRestoreResult) => void
}

// ---------------------------------------------------------------------------
// BackupService
// ---------------------------------------------------------------------------

export class BackupService extends EventEmitter {
  private readonly qemuImg: QemuImgService
  private readonly snapshotMgr: SnapshotManager
  private readonly executor: CommandExecutor
  private readonly debug: Debugger
  private readonly backupRootDir: string
  private readonly isVmRunning?: IsVmRunningProbe
  private readonly guestAgentFactory?: GuestAgentFactory

  /** Tracks in-progress backups to enforce concurrency limits. */
  private readonly activeBackups: Map<string, BackupMetadata> = new Map()

  /** Serializes operations that touch the same image path (canonical path key),
   *  so a backup/restore/snapshot can never run concurrently against one image. */
  private readonly imageLock = new KeyedMutex()

  constructor (options?: BackupServiceOptions) {
    super()
    this.qemuImg = new QemuImgService()
    this.snapshotMgr = new SnapshotManager()
    this.executor = new CommandExecutor()
    this.debug = new Debugger('backup-service')
    this.backupRootDir = options?.backupRootDir ?? DEFAULT_BACKUP_DIR
    this.isVmRunning = options?.isVmRunning
    this.guestAgentFactory = options?.guestAgentFactory
  }

  /** Canonical key for the per-image lock (resolves `.`/`..`/relative paths). */
  private imageKey (path: string): string {
    return resolvePath(path)
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Creates a new backup for a VM.
   *
   * @param config - Backup configuration describing what and how to back up.
   * @returns A `BackupResult` with summary information.
   * @throws BackupError on validation or execution failures.
   */
  async createBackup (config: BackupConfig): Promise<BackupResult> {
    this.validateConfig(config)

    // Enforce the concurrency limit (previously declared but never checked) so a
    // burst of scheduled backups cannot saturate host IO / open the same images
    // more times than intended.
    if (this.activeBackups.size >= MAX_CONCURRENT_BACKUPS) {
      throw new BackupError(
        BackupErrorCode.OPERATION_FAILED,
        `Too many concurrent backups (${this.activeBackups.size}/${MAX_CONCURRENT_BACKUPS}); try again later`,
        { vmId: config.vmId }
      )
    }

    const backupId = randomUUID()
    const startTime = Date.now()
    const compression = config.compression ?? DEFAULT_BACKUP_COMPRESSION
    const destDir = join(config.destinationDir, backupId)

    // Create destination directory
    await mkdir(destDir, { recursive: true })

    // Build initial metadata
    const metadata: BackupMetadata = {
      id: backupId,
      vmId: config.vmId,
      type: config.type,
      status: BackupStatus.IN_PROGRESS,
      createdAt: new Date().toISOString(),
      disks: [],
      totalSize: 0,
      totalOriginalSize: 0,
      compression,
      description: config.description,
      tags: config.tags,
      parentBackupId: config.parentBackupId
    }

    this.activeBackups.set(backupId, metadata)

    // H6: decide how to safely read a possibly-live disk BEFORE any qemu-img runs.
    // For FULL/INCREMENTAL of a running VM we either quiesce the guest (fsfreeze)
    // or read from a transient snapshot — never the bare live disk. SNAPSHOT
    // backups create an internal snapshot atomically and need no pre-read guard.
    let liveRead: LiveReadStrategy | null = null
    try {
      if (config.type !== BackupType.SNAPSHOT) {
        liveRead = await this.prepareLiveRead(config, destDir)
        metadata.runningAtBackup = liveRead.running
        metadata.crashConsistent = liveRead.crashConsistent
      }

      switch (config.type) {
        case BackupType.FULL:
          await this.executeFullBackup(config, destDir, metadata, compression, liveRead!)
          break
        case BackupType.INCREMENTAL:
          await this.executeIncrementalBackup(config, destDir, metadata, compression, liveRead!)
          break
        case BackupType.SNAPSHOT:
          await this.executeSnapshotBackup(config, metadata)
          break
      }

      metadata.status = BackupStatus.COMPLETED
      metadata.completedAt = new Date().toISOString()
      metadata.durationMs = Date.now() - startTime
    } catch (error) {
      metadata.status = BackupStatus.FAILED
      metadata.completedAt = new Date().toISOString()
      metadata.durationMs = Date.now() - startTime
      metadata.errorMessage = error instanceof Error ? error.message : String(error)

      // Clean up partial backup files on failure
      if (config.type !== BackupType.SNAPSHOT) {
        await this.safeCleanupDir(destDir)
      }
    } finally {
      // Always thaw the guest and remove any transient snapshots / temp images
      // taken to read a live disk — even on the error path. A guest left frozen
      // is unusable; a leaked transient snapshot bloats the live qcow2.
      if (liveRead) {
        await this.cleanupLiveRead(liveRead)
      }
      this.activeBackups.delete(backupId)
    }

    // Persist manifest. The failure path above may have removed destDir, so
    // re-create it first — otherwise writeManifest would throw ENOENT and MASK
    // the real backup error. A FAILED backup thus leaves a discoverable manifest.
    await mkdir(destDir, { recursive: true })
    await this.writeManifest(destDir, metadata)
    this.emit('completed', metadata)

    const result: BackupResult = {
      success: metadata.status === BackupStatus.COMPLETED,
      backupId: metadata.id,
      vmId: metadata.vmId,
      type: metadata.type,
      disks: metadata.disks,
      totalSize: metadata.totalSize,
      durationMs: metadata.durationMs ?? 0,
      error: metadata.errorMessage
    }

    if (!result.success && metadata.errorMessage) {
      throw new BackupError(
        BackupErrorCode.OPERATION_FAILED,
        metadata.errorMessage,
        { backupId, vmId: config.vmId }
      )
    }

    return result
  }

  /**
   * Restores a VM from a previously created backup.
   *
   * @param options - Restore configuration.
   * @returns A `BackupRestoreResult` with details of the restored disks.
   * @throws BackupError on validation or execution failures.
   */
  async restoreBackup (options: BackupRestoreOptions): Promise<BackupRestoreResult> {
    const startTime = Date.now()

    // Load manifest
    const metadata = await this.getBackupMetadata(options.backupId)
    if (metadata.status !== BackupStatus.COMPLETED) {
      throw new BackupError(
        BackupErrorCode.CORRUPT_BACKUP,
        `Cannot restore backup ${options.backupId}: status is ${metadata.status}`,
        { backupId: options.backupId, vmId: options.vmId }
      )
    }

    if (metadata.disks.length !== options.diskPaths.length) {
      throw new BackupError(
        BackupErrorCode.INVALID_CONFIG,
        `Disk count mismatch: backup has ${metadata.disks.length} disks but ${options.diskPaths.length} target paths were provided`,
        { backupId: options.backupId, vmId: options.vmId }
      )
    }

    const restoredDiskPaths: string[] = []

    // L69: for INCREMENTAL restores, verify the whole backing chain BEFORE we
    // overwrite ANY target. A missing/corrupt parent must abort up front, not
    // half-way through clobbering disks. The returned map gives the RESOLVED
    // (re-rooted) parent per overlay so restoreDiskFile can rebase onto it
    // (LOW: avoids a mid-convert failure when the backup dir was moved).
    let resolvedChains: Map<string, ResolvedChainLevel[]> | null = null
    if (metadata.type === BackupType.INCREMENTAL) {
      resolvedChains = await this.verifyIncrementalChain(metadata, options)
    }

    try {
      for (let i = 0; i < metadata.disks.length; i++) {
        const sourceDisk = metadata.disks[i]
        const targetPath = options.diskPaths[i]

        if (metadata.type === BackupType.SNAPSHOT) {
          // B2: an internal qcow2 snapshot lives INSIDE the source image. It can
          // only be applied by reverting that source file in place (destructive),
          // or by materializing it to a *different* output file. Never silently
          // clobber the live source.
          const sourcePath = sourceDisk.sourcePath
          const sameFile = this.imageKey(targetPath) === this.imageKey(sourcePath)

          if (sameFile) {
            // In-place revert of the live source. This is destructive and must be
            // explicitly opted into — it is NEVER the default.
            if (!options.allowInPlaceSnapshotRevert) {
              throw new BackupError(
                BackupErrorCode.INVALID_CONFIG,
                `Restoring SNAPSHOT backup ${options.backupId} would revert the live source disk ${sourcePath} IN PLACE (destructive). Pass allowInPlaceSnapshotRevert:true to confirm, or supply a different target path to materialize a copy.`,
                { backupId: options.backupId, vmId: options.vmId, diskPath: sourcePath }
              )
            }
            // In-place revert clobbers the source: the existence/overwrite guard
            // must apply to the file ACTUALLY written (the source), not targetPath.
            await this.assertOverwriteAllowed(sourcePath, options)
            await this.imageLock.runExclusive(this.imageKey(sourcePath), async () => {
              await this.snapshotMgr.revertSnapshot(sourcePath, sourceDisk.backupPath)
            })
            restoredDiskPaths.push(sourcePath)
          } else {
            // Different target: materialize the snapshot to the target file via
            // `qemu-img convert -l`, leaving the live source untouched. The
            // overwrite guard applies to the target we are writing.
            await this.assertOverwriteAllowed(targetPath, options)
            await mkdir(dirname(targetPath), { recursive: true })
            await this.imageLock.runExclusive(this.imageKey(targetPath), async () => {
              const tmpPath = `${targetPath}.restore.tmp`
              await this.safeUnlink(tmpPath)
              try {
                await this.snapshotMgr.materializeSnapshot(sourcePath, sourceDisk.backupPath, tmpPath)
                await this.durableRename(tmpPath, targetPath)
              } catch (err) {
                await this.safeUnlink(tmpPath)
                throw err
              }
            })
            restoredDiskPaths.push(targetPath)
          }
        } else {
          // FULL/INCREMENTAL: the overwrite guard applies to the target file.
          await this.assertOverwriteAllowed(targetPath, options)
          await mkdir(dirname(targetPath), { recursive: true })
          // For an INCREMENTAL overlay, pass the full re-rooted backing chain
          // resolved by the pre-flight so restoreDiskFile can materialize a
          // correctly-chained set of temp overlays before convert.
          const resolvedChain = resolvedChains?.get(this.imageKey(sourceDisk.backupPath)) ?? null
          await this.restoreDiskFile(sourceDisk.backupPath, targetPath, resolvedChain)
          restoredDiskPaths.push(targetPath)
        }

        this.debug.log(`Restored disk ${i + 1}/${metadata.disks.length}: ${restoredDiskPaths[restoredDiskPaths.length - 1]}`)
      }
    } catch (error) {
      if (error instanceof BackupError) throw error
      throw new BackupError(
        BackupErrorCode.OPERATION_FAILED,
        `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
        { backupId: options.backupId, vmId: options.vmId }
      )
    }

    const result: BackupRestoreResult = {
      success: true,
      backupId: options.backupId,
      vmId: options.vmId,
      restoredDiskPaths,
      durationMs: Date.now() - startTime
    }

    this.emit('restored', result)
    return result
  }

  /**
   * Lists all backups for a given VM.
   *
   * Scans the backup directory for manifest files and returns their metadata.
   *
   * @param vmId - The VM identifier to list backups for.
   * @returns Array of BackupMetadata for the VM.
   */
  async listBackups (vmId: string): Promise<BackupMetadata[]> {
    const vmBackupDir = join(this.backupRootDir, vmId)
    const backups: BackupMetadata[] = []

    let entries: string[]
    try {
      entries = await readdir(vmBackupDir)
    } catch {
      // Directory doesn't exist — no backups yet
      return backups
    }

    for (const entry of entries) {
      const manifestPath = join(vmBackupDir, entry, BACKUP_MANIFEST_FILENAME)
      try {
        const raw = await readFile(manifestPath, 'utf-8')
        const metadata: BackupMetadata = JSON.parse(raw)
        backups.push(metadata)
      } catch {
        // Skip entries without valid manifests
        this.debug.log('error', `Skipping invalid manifest at ${manifestPath}`)
      }
    }

    // Sort newest first
    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return backups
  }

  /**
   * Deletes a backup by its identifier.
   *
   * Removes backup files and the manifest from disk.
   *
   * @param backupId - The backup identifier to delete.
   * @param vmId - The VM identifier the backup belongs to.
   */
  async deleteBackup (backupId: string, vmId: string): Promise<void> {
    const backupDir = join(this.backupRootDir, vmId, backupId)

    // Check the backup exists
    try {
      await stat(backupDir)
    } catch {
      throw new BackupError(
        BackupErrorCode.BACKUP_NOT_FOUND,
        `Backup not found: ${backupId}`,
        { backupId, vmId }
      )
    }

    // H5: refuse to delete a backup that is still an INCREMENTAL parent of
    // another backup — deleting it would orphan the dependent chain (every
    // overlay referencing it as a backing file becomes unrestorable). The
    // caller (retention) must delete dependents first, or wait for them to age
    // out.
    const allBackups = await this.listBackups(vmId)
    const dependents = allBackups
      .filter(b => b.parentBackupId === backupId && b.id !== backupId)
      .map(b => b.id)
    if (dependents.length > 0) {
      throw new BackupError(
        BackupErrorCode.DEPENDENCY,
        `Backup ${backupId} has dependent incremental backups: ${dependents.join(', ')}. Delete them first.`,
        { backupId, vmId }
      )
    }

    // For snapshot backups, also delete the internal snapshot
    try {
      const metadata = await this.getBackupMetadata(backupId)
      if (metadata.type === BackupType.SNAPSHOT) {
        for (const disk of metadata.disks) {
          // SF-1: `qemu-img snapshot -d` mutates the live qcow2. A retention
          // sweep calling deleteBackup must serialize against a concurrent
          // scheduled createBackup of the same disk under the per-image lock;
          // otherwise two qemu-img processes mutate the same image at once.
          // deleteBackup holds no lock for this key, so this is not reentrant.
          // backupPath holds the snapshot name for snapshot-type backups.
          await this.imageLock.runExclusive(this.imageKey(disk.sourcePath), async () => {
            await this.snapshotMgr.deleteSnapshot(disk.sourcePath, disk.backupPath)
          })
        }
      }
    } catch {
      // Best-effort snapshot cleanup — don't block the delete
    }

    // Remove backup directory from disk
    await rm(backupDir, { recursive: true, force: true })
    this.debug.log(`Deleted backup ${backupId} for VM ${vmId}`)
  }

  /**
   * Retrieves metadata for a specific backup.
   *
   * @param backupId - The backup identifier.
   * @param vmIdHint - Optional VM identifier to narrow the search.
   * @returns The BackupMetadata for the specified backup.
   * @throws BackupError if the backup is not found or manifest is invalid.
   */
  async getBackupMetadata (backupId: string, vmIdHint?: string): Promise<BackupMetadata> {
    // If vmId is known, try direct path first
    if (vmIdHint) {
      const manifestPath = join(this.backupRootDir, vmIdHint, backupId, BACKUP_MANIFEST_FILENAME)
      try {
        const raw = await readFile(manifestPath, 'utf-8')
        return JSON.parse(raw) as BackupMetadata
      } catch {
        // Fall through to full scan
      }
    }

    // Scan all VM directories for the backup
    try {
      const vmDirs = await readdir(this.backupRootDir)
      for (const vmDir of vmDirs) {
        const manifestPath = join(this.backupRootDir, vmDir, backupId, BACKUP_MANIFEST_FILENAME)
        try {
          const raw = await readFile(manifestPath, 'utf-8')
          return JSON.parse(raw) as BackupMetadata
        } catch {
          continue
        }
      }
    } catch {
      // backupRootDir doesn't exist
    }

    throw new BackupError(
      BackupErrorCode.BACKUP_NOT_FOUND,
      `Backup not found: ${backupId}`,
      { backupId }
    )
  }

  /**
   * Returns the number of currently active (in-progress) backup operations.
   */
  get activeBackupCount (): number {
    return this.activeBackups.size
  }

  // =========================================================================
  // Private — Live-read safety (H6)
  // =========================================================================

  /**
   * Decides how to read each source disk safely for a FULL/INCREMENTAL backup.
   *
   * Strategy (fail-closed on an unknown power state):
   *  1. No `isVmRunning` probe injected   -> assume stopped, read live (legacy).
   *  2. Probe says STOPPED                 -> read live, filesystem-consistent.
   *  3. Probe says RUNNING:
   *     a. Guest agent available          -> fsfreeze the guest, read live,
   *                                          thaw in cleanup (consistent).
   *     b. Else snapshot+materialize each  -> read a transient snapshot copy
   *        disk (crash-consistent)           instead of the live disk.
   *     c. Neither possible               -> throw BackupError(VM_RUNNING).
   *  4. Probe NULL/throws (unknown)        -> treat as RUNNING (fail-closed).
   */
  private async prepareLiveRead (config: BackupConfig, destDir: string): Promise<LiveReadStrategy> {
    const strategy: LiveReadStrategy = {
      running: false,
      crashConsistent: false,
      quiesce: null,
      readFrom: new Map(),
      transientSnapshots: new Map(),
      tempFiles: []
    }

    // No probe injected: we cannot detect a live disk. Preserve legacy behavior
    // (read live) rather than refusing every backup; callers that want the guard
    // MUST inject isVmRunning. This is reported as a CROSS-UNIT CONTRACT.
    if (!this.isVmRunning) {
      return strategy
    }

    let running: boolean | null
    try {
      running = await this.isVmRunning(config.vmId)
    } catch (error) {
      this.debug.log('error', `isVmRunning probe threw for ${config.vmId}; treating as RUNNING (fail-closed): ${error instanceof Error ? error.message : String(error)}`)
      running = null
    }

    if (running === false) {
      return strategy // stopped: read live disks directly
    }

    // running === true OR running === null (unknown) => fail-closed as running.
    strategy.running = true

    // 3a: try guest-agent quiesce.
    if (this.guestAgentFactory) {
      try {
        const agent = await this.guestAgentFactory(config.vmId)
        if (agent) {
          if (agent.isConnected ? !agent.isConnected() : true) {
            if (agent.connect) await agent.connect()
          }
          // MF-2: register the agent for cleanup BEFORE issuing fsFreeze. The
          // QGA client has a client-side timeout that can REJECT fsFreeze()
          // AFTER the guest already froze (the in-flight freeze is not
          // cancelled). If we only set strategy.quiesce on success, that throw
          // would skip cleanupLiveRead's thaw+disconnect and leave the guest
          // wedged (all IO hung) plus a leaked agent socket FD. Registering
          // first guarantees a thrown fsFreeze still routes through cleanup,
          // which thaws (a no-op/safe when the FS was never frozen) and
          // disconnects.
          strategy.quiesce = agent
          await agent.fsFreeze()
          strategy.crashConsistent = false
          this.debug.log(`Quiesced guest ${config.vmId} via fsfreeze for ${config.type} backup`)
          return strategy
        }
      } catch (error) {
        this.debug.log('error', `Guest quiesce failed for ${config.vmId}; falling back to transient snapshot: ${error instanceof Error ? error.message : String(error)}`)
        // MF-2: fsFreeze (or connect) threw, but the freeze MAY have taken
        // effect guest-side. Before falling through to the snapshot strategy we
        // must thaw + disconnect the agent ourselves and clear strategy.quiesce,
        // otherwise the success path's `return` is gone and the agent would
        // either leak (no return = falls through) OR, if left registered, be
        // thawed a second time by cleanupLiveRead (double-thaw). Best-effort.
        if (strategy.quiesce) {
          const agent = strategy.quiesce
          strategy.quiesce = null
          await agent.fsThaw().catch(() => { /* not frozen / already thawed */ })
          if (agent.disconnect) await agent.disconnect().catch(() => { /* ignore */ })
        }
        // fall through to snapshot fallback
      }
    }

    // 3b: transient snapshot fallback — snapshot each live disk and read a
    // materialized copy. Crash-consistent (like a power-loss image).
    try {
      for (let i = 0; i < config.diskPaths.length; i++) {
        const sourcePath = config.diskPaths[i]
        const snapName = `infz-backup-tmp-${randomUUID().slice(0, 8)}`
        const tmpImage = join(destDir, `.src-${i}.transient.qcow2`)
        // SF-1: creating a transient internal snapshot mutates the live qcow2.
        // Serialize it under the same per-image lock every create/restore path
        // uses, so a retention sweep or a scheduled createBackup of the same
        // disk cannot run `qemu-img snapshot` against it concurrently. Safe
        // (non-reentrant): prepareLiveRead runs BEFORE the execute*Backup
        // per-disk locks are taken, so this key is not already held here.
        await this.imageLock.runExclusive(this.imageKey(sourcePath), async () => {
          await this.snapshotMgr.createSnapshot({ imagePath: sourcePath, name: snapName, description: 'transient backup read snapshot' })
          strategy.transientSnapshots.set(sourcePath, snapName)
          await this.snapshotMgr.materializeSnapshot(sourcePath, snapName, tmpImage)
        })
        strategy.tempFiles.push(tmpImage)
        strategy.readFrom.set(sourcePath, tmpImage)
      }
      strategy.crashConsistent = true
      this.debug.log(`Using transient snapshot copies to back up running VM ${config.vmId} (crash-consistent)`)
      return strategy
    } catch (error) {
      // 3c: cannot quiesce AND cannot snapshot => refuse. Roll back anything
      // partially created before throwing.
      await this.cleanupLiveRead(strategy)
      throw new BackupError(
        BackupErrorCode.VM_RUNNING,
        `VM ${config.vmId} is running (or its power state is unknown) and could not be quiesced (no guest agent) nor snapshotted; refusing to copy a live disk. Stop the VM, install the guest agent, or ensure snapshots are possible.`,
        { vmId: config.vmId, command: error instanceof Error ? error.message : String(error) }
      )
    }
  }

  /** Returns the path to actually read for a source disk under a live-read plan. */
  private sourceFor (strategy: LiveReadStrategy | null, sourcePath: string): string {
    return strategy?.readFrom.get(sourcePath) ?? sourcePath
  }

  /** Thaws the guest and removes all transient snapshots/temp images. Best-effort. */
  private async cleanupLiveRead (strategy: LiveReadStrategy): Promise<void> {
    if (strategy.quiesce) {
      try {
        await strategy.quiesce.fsThaw()
      } catch (error) {
        this.debug.log('error', `Guest fsthaw failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        if (strategy.quiesce.disconnect) await strategy.quiesce.disconnect()
      } catch { /* ignore */ }
    }
    for (const tmp of strategy.tempFiles) {
      await this.safeUnlink(tmp)
    }
    for (const [sourcePath, snapName] of strategy.transientSnapshots) {
      try {
        // SF-1: deleting the transient snapshot mutates the live qcow2; take the
        // per-image lock so it cannot overlap a concurrent backup/restore of the
        // same disk. cleanupLiveRead runs AFTER the execute*Backup per-disk locks
        // have been released, so this is not reentrant against a held key.
        await this.imageLock.runExclusive(this.imageKey(sourcePath), async () => {
          await this.snapshotMgr.deleteSnapshot(sourcePath, snapName)
        })
      } catch (error) {
        this.debug.log('error', `Failed to delete transient snapshot ${snapName} on ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // =========================================================================
  // Private — Backup Strategies
  // =========================================================================

  /**
   * FULL backup: copies each disk via `qemu-img convert` to a standalone file.
   */
  private async executeFullBackup (
    config: BackupConfig,
    destDir: string,
    metadata: BackupMetadata,
    compression: BackupCompression,
    liveRead: LiveReadStrategy
  ): Promise<void> {
    for (let i = 0; i < config.diskPaths.length; i++) {
      const sourcePath = config.diskPaths[i]
      // Read from a transient snapshot copy if the live-read plan substituted one.
      const readPath = this.sourceFor(liveRead, sourcePath)
      const backupFileName = `disk-${i}.qcow2`
      const backupPath = join(destDir, backupFileName)

      this.debug.log(`FULL backup: copying disk ${i + 1}/${config.diskPaths.length}: ${sourcePath}`)

      // L245: serialize per-source-disk so a backup never races a concurrent
      // backup/restore/snapshot of the same image.
      await this.imageLock.runExclusive(this.imageKey(sourcePath), async () => {
        // Get source info for metadata
        const sourceInfo = await this.qemuImg.getImageInfo(readPath)

        await this.qemuImg.convertImage({
          sourcePath: readPath,
          destPath: backupPath,
          destFormat: 'qcow2',
          compress: compression === BackupCompression.QCOW2
        })

        // Apply gzip on top if requested. gzip -f RENAMES the file to <path>.gz, so
        // the effective backup file (and its size) must track that new path —
        // otherwise the manifest points at a deleted file and the backup is
        // unrestorable (it reported size 0 and restore had no gunzip).
        let effectiveBackupPath = backupPath
        if (compression === BackupCompression.GZIP) {
          effectiveBackupPath = await this.gzipFile(backupPath)
        }

        const diskInfo = await this.buildDiskInfo(sourcePath, effectiveBackupPath, sourceInfo.actualSize, 'qcow2')
        metadata.disks.push(diskInfo)
        metadata.totalSize += diskInfo.backupSize
        metadata.totalOriginalSize += diskInfo.originalSize
      })

      // Emit progress
      this.emitProgress(metadata.id, config.vmId, i, config.diskPaths.length, 100)
    }
  }

  /**
   * INCREMENTAL backup: creates a qcow2 overlay referencing the parent backup
   * as a backing file. Only changed clusters are stored.
   */
  private async executeIncrementalBackup (
    config: BackupConfig,
    destDir: string,
    metadata: BackupMetadata,
    compression: BackupCompression,
    liveRead: LiveReadStrategy
  ): Promise<void> {
    if (!config.parentBackupId) {
      throw new BackupError(
        BackupErrorCode.PARENT_NOT_FOUND,
        'INCREMENTAL backup requires a parentBackupId',
        { vmId: config.vmId }
      )
    }

    // Load parent metadata to locate its files
    const parentMeta = await this.getBackupMetadata(config.parentBackupId, config.vmId)
    if (parentMeta.status !== BackupStatus.COMPLETED) {
      throw new BackupError(
        BackupErrorCode.PARENT_NOT_FOUND,
        `Parent backup ${config.parentBackupId} is not in COMPLETED state`,
        { backupId: config.parentBackupId, vmId: config.vmId }
      )
    }

    if (parentMeta.disks.length !== config.diskPaths.length) {
      throw new BackupError(
        BackupErrorCode.INVALID_CONFIG,
        `Disk count mismatch: parent has ${parentMeta.disks.length} disks, config has ${config.diskPaths.length}`,
        { backupId: config.parentBackupId, vmId: config.vmId }
      )
    }

    // H4: a GZIP-compressed parent stores its disks as .qcow2.gz blobs. Using a
    // .gz file as a qcow2 backing file produces a COMPLETED-but-UNRESTORABLE
    // chain (qemu cannot read a gzip stream as a backing image). Refuse at
    // CREATION instead of silently shipping a broken backup. QCOW2-native
    // compression stays valid because qemu-img reads it transparently.
    if (
      parentMeta.compression === BackupCompression.GZIP ||
      parentMeta.disks.some(d => d.backupPath.endsWith('.gz'))
    ) {
      throw new BackupError(
        BackupErrorCode.INVALID_CONFIG,
        `Parent backup ${config.parentBackupId} is GZIP-compressed; an INCREMENTAL overlay cannot use a .gz file as a qcow2 backing file. Use an uncompressed (NONE) or QCOW2-native-compressed parent.`,
        { backupId: config.parentBackupId, vmId: config.vmId }
      )
    }

    for (let i = 0; i < config.diskPaths.length; i++) {
      const sourcePath = config.diskPaths[i]
      const readPath = this.sourceFor(liveRead, sourcePath)
      const parentDiskBackupPath = parentMeta.disks[i].backupPath
      const backupFileName = `disk-${i}.qcow2`
      const backupPath = join(destDir, backupFileName)

      this.debug.log(
        `INCREMENTAL backup: creating overlay for disk ${i + 1}/${config.diskPaths.length}`
      )

      // L245: serialize per-source-disk.
      await this.imageLock.runExclusive(this.imageKey(sourcePath), async () => {
        const sourceInfo = await this.qemuImg.getImageInfo(readPath)

        // Create a qcow2 overlay with the parent backup as the backing file
        const args = ['create', '-f', 'qcow2', '-b', parentDiskBackupPath, '-F', 'qcow2', '--', backupPath]
        await this.executor.execute('qemu-img', args, { timeoutMs: 0 })

        // Optionally apply compression to the overlay
        if (compression === BackupCompression.QCOW2) {
          await this.qemuImg.convertImage({
            sourcePath: backupPath,
            destPath: backupPath + '.tmp',
            destFormat: 'qcow2',
            compress: true
          })
          // Replace original with compressed version
          await this.executor.execute('mv', [backupPath + '.tmp', backupPath], { timeoutMs: 0 })
        }

        const diskInfo = await this.buildDiskInfo(sourcePath, backupPath, sourceInfo.actualSize, 'qcow2')
        diskInfo.backingFile = parentDiskBackupPath
        metadata.disks.push(diskInfo)
        metadata.totalSize += diskInfo.backupSize
        metadata.totalOriginalSize += diskInfo.originalSize
      })

      this.emitProgress(metadata.id, config.vmId, i, config.diskPaths.length, 100)
    }
  }

  /**
   * SNAPSHOT backup: creates an internal qcow2 snapshot via SnapshotManager.
   * No files are copied — the snapshot lives inside the original qcow2 image.
   */
  private async executeSnapshotBackup (
    config: BackupConfig,
    metadata: BackupMetadata
  ): Promise<void> {
    // For snapshot backups, we operate on the first (primary) disk
    // and create an internal snapshot with a deterministic name
    const snapshotName = `backup-${metadata.id}`
    const sourcePath = config.diskPaths[0]

    this.debug.log(`SNAPSHOT backup: creating internal snapshot '${snapshotName}'`)

    // L245: serialize against concurrent backup/restore/snapshot of this disk.
    await this.imageLock.runExclusive(this.imageKey(sourcePath), async () => {
      const sourceInfo = await this.qemuImg.getImageInfo(sourcePath)

      await this.snapshotMgr.createSnapshot({
        imagePath: sourcePath,
        name: snapshotName,
        description: config.description ?? `Backup ${metadata.id}`
      })

      // For snapshot backups, backupPath stores the snapshot name (not a file path)
      // so we can revert to it later
      const diskInfo: BackupDiskInfo = {
        sourcePath,
        backupPath: snapshotName,
        originalSize: sourceInfo.virtualSize,
        backupSize: 0, // Internal snapshots initially consume no extra space
        format: 'qcow2'
      }

      metadata.disks.push(diskInfo)
      metadata.totalOriginalSize += sourceInfo.virtualSize
      // totalSize stays 0 for snapshots — no external files created
    })

    this.emitProgress(metadata.id, config.vmId, 0, 1, 100)
  }

  // =========================================================================
  // Private — Helpers
  // =========================================================================

  /**
   * Enforces the overwriteExisting contract against the file that will ACTUALLY
   * be written (which is not always options.diskPaths[i] — for an in-place
   * snapshot revert it is the source). Throws TARGET_EXISTS if the file exists
   * and overwrite is not enabled.
   */
  private async assertOverwriteAllowed (pathToWrite: string, options: BackupRestoreOptions): Promise<void> {
    if (options.overwriteExisting) return
    try {
      await stat(pathToWrite)
    } catch {
      return // does not exist — safe to write
    }
    throw new BackupError(
      BackupErrorCode.TARGET_EXISTS,
      `Target disk already exists: ${pathToWrite}. Set overwriteExisting to true to overwrite.`,
      { backupId: options.backupId, vmId: options.vmId, diskPath: pathToWrite }
    )
  }

  /**
   * L69: pre-flight integrity check for an INCREMENTAL restore. For each disk it
   * re-derives the parent backing path under the CURRENT backupRootDir (absolute
   * paths recorded at backup time may be stale after a backup-dir move), stats it
   * (PARENT_NOT_FOUND if missing), and runs qemu-img check (CORRUPT_BACKUP on
   * errors/corruptions) — all BEFORE any target is touched.
   *
   * LOW (rebase mismatch): returns the RESOLVED parent path per overlay so the
   * restore can rebase the overlay onto it. Without this, the pre-flight would
   * pass against a re-rooted parent while `qemu-img convert` in restoreDiskFile
   * still reads the overlay's EMBEDDED (possibly stale) backing path and fails
   * mid-convert. The map keys on the canonical overlay path.
   *
   * LOW (multi-level chain): for a chain deeper than one level (base FULL ←
   * inc1 ← inc2), re-rooting ONLY the restored overlay's direct parent is not
   * enough — inc1 would still embed the OLD base path and `qemu-img convert`
   * would fail mid-read. We therefore walk the ENTIRE chain from the overlay
   * being restored DOWN to the FULL base, re-rooting and stat'ing each level's
   * parent, and return the ordered per-level plan so restoreDiskFile can chain
   * temp copies down to the read-only base. Ancestor metadata is loaded from the
   * parent backup manifests (the recorded backing path encodes the parent's
   * `<vmId>/<parentBackupId>/<file>`).
   */
  private async verifyIncrementalChain (metadata: BackupMetadata, options: BackupRestoreOptions): Promise<Map<string, ResolvedChainLevel[]>> {
    const chains = new Map<string, ResolvedChainLevel[]>()
    for (let diskIndex = 0; diskIndex < metadata.disks.length; diskIndex++) {
      const topDisk = metadata.disks[diskIndex]
      const topOverlay = topDisk.backupPath

      // 1) The overlay file must at least EXIST (a deep qemu-img check on the
      //    overlay is deferred — it would try to open the backing parent at the
      //    possibly-stale recorded path and false-fail; we verify the parent
      //    explicitly below instead).
      try {
        await stat(topOverlay)
      } catch {
        throw new BackupError(
          BackupErrorCode.CORRUPT_BACKUP,
          `INCREMENTAL restore aborted: overlay image missing: ${topOverlay}`,
          { backupId: options.backupId, vmId: options.vmId, diskPath: topOverlay }
        )
      }

      // 2) Walk the whole backing chain DOWN to the FULL base, re-rooting and
      //    verifying each level's parent. `currentDisk`/`currentMeta` advance one
      //    level per iteration; `backingFile` absent => we've reached the base.
      const levels: ResolvedChainLevel[] = []
      let currentMeta: BackupMetadata = metadata
      let currentDisk: BackupDiskInfo = topDisk
      // Guard against a malformed/looping manifest set (a backing pointer that
      // cycles back). The chain can be at most as long as the lib will ever
      // build; cap generously and fail clearly rather than spin forever.
      const maxDepth = 256
      for (let depth = 0; depth <= maxDepth; depth++) {
        const overlayPath = currentDisk.backupPath
        const backing = currentDisk.backingFile
        if (!backing) break // reached the FULL base — nothing more to re-root

        if (depth === maxDepth) {
          throw new BackupError(
            BackupErrorCode.CORRUPT_BACKUP,
            `INCREMENTAL restore aborted: backing chain for ${topOverlay} exceeds ${maxDepth} levels (possible cycle)`,
            { backupId: options.backupId, vmId: options.vmId, diskPath: overlayPath }
          )
        }

        // Re-root + verify this level's parent under the current backupRootDir.
        const candidates = this.candidateBackingPaths(backing, currentMeta.vmId)
        let resolved: string | null = null
        for (const candidate of candidates) {
          try {
            await stat(candidate)
            resolved = candidate
            break
          } catch { /* try next */ }
        }
        if (!resolved) {
          throw new BackupError(
            BackupErrorCode.PARENT_NOT_FOUND,
            `INCREMENTAL restore aborted: parent backing file not found for ${overlayPath} (looked for: ${candidates.join(', ')}). If the backup directory was moved, restore at the original root or relocate the FULL base alongside the overlays.`,
            { backupId: options.backupId, vmId: options.vmId, diskPath: backing }
          )
        }

        // Load the parent backup's metadata to learn whether IT is itself an
        // overlay (chain continues) or the FULL base (chain terminates). The
        // parent backupId is the directory segment of the recorded backing path.
        const parentBackupId = basename(dirname(backing))
        let parentMeta: BackupMetadata
        try {
          parentMeta = await this.getBackupMetadata(parentBackupId, currentMeta.vmId)
        } catch {
          // No manifest for the parent — treat the resolved parent as a terminal
          // base (we cannot prove it has its own backing file). This keeps a
          // single-level chain whose parent manifest is absent behaving exactly
          // as before (re-root the direct parent, convert against it).
          await this.assertImageIntact(resolved, options)
          levels.push({ overlayPath, resolvedParent: resolved, parentIsBase: true })
          break
        }
        const parentDisk: BackupDiskInfo | undefined = parentMeta.disks[diskIndex]
        const parentIsBase = !parentDisk?.backingFile

        // Only the read-only terminal base is integrity-checked here; intermediate
        // overlays are checked implicitly when their own backing parent is
        // verified on the next loop iteration (a deep check of an overlay would
        // try to open its stale embedded backing path and false-fail).
        if (parentIsBase) await this.assertImageIntact(resolved, options)
        levels.push({ overlayPath, resolvedParent: resolved, parentIsBase })

        if (parentIsBase || !parentDisk) break
        currentMeta = parentMeta
        currentDisk = parentDisk
      }

      if (levels.length > 0) {
        chains.set(this.imageKey(topOverlay), levels)
      }
    }
    return chains
  }

  /** Runs qemu-img check on an image, throwing CORRUPT_BACKUP on errors/corruptions. */
  private async assertImageIntact (imagePath: string, options: BackupRestoreOptions): Promise<void> {
    // gzip blobs are not directly checkable as qcow2; skip (restoreDiskFile
    // gunzips first). A .gz parent should never reach here because H4 blocks
    // gzip parents at incremental-creation time.
    if (imagePath.endsWith('.gz')) return
    try {
      const check = await this.qemuImg.checkImage(imagePath)
      if (check.errors > 0 || check.corruptions > 0) {
        throw new BackupError(
          BackupErrorCode.CORRUPT_BACKUP,
          `INCREMENTAL restore aborted: parent image ${imagePath} is corrupt (errors=${check.errors}, corruptions=${check.corruptions})`,
          { backupId: options.backupId, vmId: options.vmId, diskPath: imagePath }
        )
      }
    } catch (error) {
      if (error instanceof BackupError) throw error
      throw new BackupError(
        BackupErrorCode.CORRUPT_BACKUP,
        `INCREMENTAL restore aborted: could not verify parent image ${imagePath}: ${error instanceof Error ? error.message : String(error)}`,
        { backupId: options.backupId, vmId: options.vmId, diskPath: imagePath }
      )
    }
  }

  /**
   * Returns candidate absolute paths for a recorded backing file, re-derived
   * against the current backupRootDir. Backup dirs get moved/restored on new
   * hosts, so the absolute path baked into the manifest can be stale; we try the
   * recorded path first, then the same `<vmId>/<backupId>/<file>` tail under the
   * live root.
   */
  private candidateBackingPaths (recordedPath: string, vmId: string): string[] {
    const candidates = [recordedPath]
    // recordedPath looks like .../<vmId>/<backupId>/disk-N.qcow2 — re-root the
    // trailing <backupId>/<file> under our current backupRootDir/<vmId>.
    const file = basename(recordedPath)
    const parentDir = basename(dirname(recordedPath)) // the backupId segment
    if (parentDir && file) {
      const rederived = join(this.backupRootDir, vmId, parentDir, file)
      if (rederived !== recordedPath) candidates.push(rederived)
    }
    return candidates
  }

  /**
   * L65: durable rename — fsync the new file's data, rename it over the target,
   * then fsync the parent directory so the rename itself is on stable storage.
   * A crash after this returns can never resurrect the old target or lose the
   * new contents.
   */
  private async durableRename (tmpPath: string, targetPath: string): Promise<void> {
    // fsync the fully-written temp file's data + metadata before swapping.
    const fh = await open(tmpPath, 'r+')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmpPath, targetPath)
    // fsync the parent directory so the rename (a directory metadata change) is
    // durable — otherwise a crash could leave the old name or no name at all.
    await this.fsyncDir(dirname(targetPath))
  }

  /** Best-effort directory fsync (opening a dir for sync is POSIX; ignore EISDIR quirks). */
  private async fsyncDir (dirPath: string): Promise<void> {
    let dh: Awaited<ReturnType<typeof open>> | null = null
    try {
      dh = await open(dirPath, 'r')
      await dh.sync()
    } catch (error) {
      // Some filesystems reject dir fsync; log and continue (the file fsync above
      // already covers the data).
      this.debug.log('error', `Directory fsync skipped for ${dirPath}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (dh) await dh.close().catch(() => undefined)
    }
  }

  /** Validates a BackupConfig before starting an operation. */
  private validateConfig (config: BackupConfig): void {
    if (!config.vmId || config.vmId.trim().length === 0) {
      throw new BackupError(BackupErrorCode.INVALID_CONFIG, 'vmId is required')
    }

    if (!config.diskPaths || config.diskPaths.length === 0) {
      throw new BackupError(
        BackupErrorCode.INVALID_CONFIG,
        'At least one diskPath is required',
        { vmId: config.vmId }
      )
    }

    if (!config.destinationDir || config.destinationDir.trim().length === 0) {
      if (config.type !== BackupType.SNAPSHOT) {
        throw new BackupError(
          BackupErrorCode.INVALID_DESTINATION,
          'destinationDir is required for FULL and INCREMENTAL backups',
          { vmId: config.vmId }
        )
      }
    }

    if (config.type === BackupType.INCREMENTAL && !config.parentBackupId) {
      throw new BackupError(
        BackupErrorCode.PARENT_NOT_FOUND,
        'parentBackupId is required for INCREMENTAL backups',
        { vmId: config.vmId }
      )
    }
  }

  /**
   * Writes the backup manifest JSON to disk DURABLY (L65): write to a temp file,
   * fsync it, rename over the manifest, then fsync the directory. The manifest is
   * the only record of where a backup's files live and whether it COMPLETED — a
   * torn manifest makes the whole backup undiscoverable.
   */
  private async writeManifest (destDir: string, metadata: BackupMetadata): Promise<void> {
    const manifestPath = join(destDir, BACKUP_MANIFEST_FILENAME)
    const tmpPath = `${manifestPath}.tmp`
    await writeFile(tmpPath, JSON.stringify(metadata, null, 2), 'utf-8')
    await this.durableRename(tmpPath, manifestPath)
    this.debug.log(`Manifest written: ${manifestPath}`)
  }

  /** Builds BackupDiskInfo by measuring the backup file size on disk. */
  private async buildDiskInfo (
    sourcePath: string,
    backupPath: string,
    originalSize: number,
    format: string
  ): Promise<BackupDiskInfo> {
    let backupSize = 0
    try {
      const fileStat = await stat(backupPath)
      backupSize = fileStat.size
    } catch {
      // File may not exist (e.g. snapshot backup)
    }

    return {
      sourcePath,
      backupPath,
      originalSize,
      backupSize,
      format
    }
  }

  /**
   * Restores a single disk file backup → target ATOMICALLY.
   *
   * Converts into a temp file then renames over the target only on success, so a
   * mid-convert failure (ENOSPC, crash, corrupt source) never truncates the
   * existing target — which may be the only good copy. A gzip-compressed backup
   * (.gz) is decompressed to a temp first. Serialized per target image.
   *
   * @param resolvedChain - For an INCREMENTAL overlay, the full backing chain
   *   RESOLVED by verifyIncrementalChain (each level's parent re-rooted under the
   *   current backupRootDir), ordered from this overlay DOWN to the FULL base.
   *   When the backup dir was moved, the EMBEDDED backing paths at EVERY level
   *   are stale and `qemu-img convert` would fail reading them; we materialize a
   *   temp COPY of each non-base level and metadata-only rebase it onto the
   *   correct (re-rooted) parent — chaining temp→temp down to the read-only FULL
   *   base (referenced in place, never copied). The pristine backup overlays are
   *   never mutated, and the target stays untouched on any failure (temp +
   *   rename). A single-level chain materializes exactly ONE temp copy, matching
   *   the prior behavior.
   */
  private async restoreDiskFile (sourceBackupPath: string, targetPath: string, resolvedChain: ResolvedChainLevel[] | null = null): Promise<void> {
    // LOW: lock on the CANONICAL key (resolved path), matching every other
    // imageLock site. Locking the raw targetPath would fail to serialize against
    // a concurrent op on the same disk reached via a different path spelling
    // (`./`, `..`, relative). The caller does not hold this key.
    await this.imageLock.runExclusive(this.imageKey(targetPath), async () => {
      const tmpPath = `${targetPath}.restore.tmp`
      let gunzipTmp: string | null = null
      // Temp copies of each non-base chain level (top overlay first), cleaned up
      // in the finally. The pristine backup files are never touched.
      const chainTmps: string[] = []
      try {
        // If the backup is gzip-compressed, decompress to a temp file first.
        let convertSource = sourceBackupPath
        if (sourceBackupPath.endsWith('.gz')) {
          gunzipTmp = `${targetPath}.gunzip.tmp`
          // gunzip -c writes to stdout; redirect via our executor into the temp.
          await this.gunzipTo(sourceBackupPath, gunzipTmp)
          convertSource = gunzipTmp
        } else if (resolvedChain && resolvedChain.length > 0) {
          // LOW (relocated chain): the embedded backing path at EVERY level may
          // be stale (backup dir moved). Materialize the chain into temp copies
          // bottom-up so each temp level points at the correct re-rooted parent
          // and the top temp overlay reads cleanly through to the FULL base.
          //
          // resolvedChain is ordered TOP→DOWN: index 0 is THIS overlay, the last
          // entry is the level whose parent is the read-only FULL base. We build
          // the temp copies from the BOTTOM up, threading each temp's backing
          // pointer onto the temp (or real base) below it.
          //
          // `childBacking` is the path that the NEXT level up must rebase onto.
          // For the bottom level it is the real re-rooted base; for higher levels
          // it is the temp copy we just produced.
          let childBacking: string | null = null
          for (let level = resolvedChain.length - 1; level >= 0; level--) {
            const entry = resolvedChain[level]
            const tmp = `${targetPath}.chain${level}.tmp`
            await this.safeUnlink(tmp)
            // Copy the PRISTINE overlay for this level — never mutate the backup.
            await copyFile(entry.overlayPath, tmp)
            chainTmps.push(tmp)
            // Rebase (-u = unsafe/metadata-only, no data copy) onto the correct
            // parent: the real re-rooted base for the bottom level, or the temp
            // copy of the level below for every higher level.
            const backingTarget = childBacking ?? entry.resolvedParent
            await this.executor.execute('qemu-img', ['rebase', '-u', '-b', backingTarget, '-F', 'qcow2', '--', tmp], { timeoutMs: 0 })
            childBacking = tmp
          }
          // The top overlay's temp copy (index 0) is the convert source. Because
          // we iterated bottom-up, childBacking now holds it.
          convertSource = childBacking as string
        }

        await this.qemuImg.convertImage({
          sourcePath: convertSource,
          destPath: tmpPath,
          destFormat: 'qcow2',
          compress: false
        })

        // Atomic + DURABLE swap: fsync the new image, rename over the target, then
        // fsync the parent dir — so a crash right after restore cannot resurrect
        // the old target or lose the freshly written data (L65).
        await this.durableRename(tmpPath, targetPath)
      } catch (error) {
        // Never leave a partial temp behind; the original target is untouched.
        await this.safeUnlink(tmpPath)
        const msg = error instanceof Error ? error.message : String(error)
        if (/no space left on device|enospc/i.test(msg)) {
          throw new BackupError(
            BackupErrorCode.OPERATION_FAILED,
            `Restore aborted: out of disk space writing ${targetPath} (original left intact)`,
            { diskPath: targetPath }
          )
        }
        throw error
      } finally {
        if (gunzipTmp) await this.safeUnlink(gunzipTmp)
        for (const tmp of chainTmps) await this.safeUnlink(tmp)
      }
    })
  }

  /**
   * Decompresses a .gz backup to destPath WITHOUT piping binary through stdout
   * (the command executor buffers stdout as a UTF-8 string, which would corrupt a
   * binary qcow2). Instead copy the .gz next to the destination and gunzip it in
   * place: `gunzip -f <destPath>.gz` yields <destPath> and removes the .gz copy.
   */
  private async gunzipTo (gzPath: string, destPath: string): Promise<void> {
    const tmpGz = `${destPath}.gz`
    await copyFile(gzPath, tmpGz)
    try {
      // Disk-sized decompression — no timeout (would otherwise be killed on a
      // multi-GB image, aborting the restore).
      await this.executor.execute('gunzip', ['-f', tmpGz], { timeoutMs: 0 })
    } catch (error) {
      await this.safeUnlink(tmpGz)
      throw error
    }
  }

  /** Best-effort unlink that swallows ENOENT. */
  private async safeUnlink (filePath: string): Promise<void> {
    try {
      await unlink(filePath)
    } catch {
      /* file may not exist — fine */
    }
  }

  /**
   * Compresses a file with gzip. `gzip -f` RENAMES the input to `<path>.gz` and
   * removes the original, so we return the new path for the caller to record.
   */
  private async gzipFile (filePath: string): Promise<string> {
    // Disk-sized compression — no timeout (a multi-GB image takes minutes).
    await this.executor.execute('gzip', ['-f', filePath], { timeoutMs: 0 })
    const gzPath = `${filePath}.gz`
    this.debug.log(`Gzipped: ${filePath} -> ${gzPath}`)
    return gzPath
  }

  /** Emits a progress event. */
  private emitProgress (
    backupId: string,
    vmId: string,
    currentDisk: number,
    totalDisks: number,
    diskProgress: number
  ): void {
    const overallProgress = Math.round(((currentDisk + diskProgress / 100) / totalDisks) * 100)
    this.emit('progress', {
      backupId,
      vmId,
      currentDisk,
      totalDisks,
      diskProgress,
      overallProgress
    })
  }

  /** Safely removes a directory, ignoring errors (used during cleanup). */
  private async safeCleanupDir (dirPath: string): Promise<void> {
    try {
      await rm(dirPath, { recursive: true, force: true })
    } catch {
      // Intentionally ignored — best-effort cleanup
    }
  }
}
