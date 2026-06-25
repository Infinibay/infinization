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
import { mkdir, readFile, writeFile, rm, stat, readdir } from 'fs/promises'
import { randomUUID } from 'crypto'
import { join, dirname } from 'path'

import { QemuImgService } from '../storage/QemuImgService'
import { SnapshotManager } from '../storage/SnapshotManager'
import { CommandExecutor } from '../utils/commandExecutor'
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
  DEFAULT_BACKUP_DIR
} from '../types/backup.types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options accepted by the BackupService constructor. */
export interface BackupServiceOptions {
  /** Root directory for all backup storage (default: DEFAULT_BACKUP_DIR) */
  backupRootDir?: string
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

  /** Tracks in-progress backups to enforce concurrency limits. */
  private readonly activeBackups: Map<string, BackupMetadata> = new Map()

  constructor (options?: BackupServiceOptions) {
    super()
    this.qemuImg = new QemuImgService()
    this.snapshotMgr = new SnapshotManager()
    this.executor = new CommandExecutor()
    this.debug = new Debugger('backup-service')
    this.backupRootDir = options?.backupRootDir ?? DEFAULT_BACKUP_DIR
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

    try {
      switch (config.type) {
        case BackupType.FULL:
          await this.executeFullBackup(config, destDir, metadata, compression)
          break
        case BackupType.INCREMENTAL:
          await this.executeIncrementalBackup(config, destDir, metadata, compression)
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
      this.activeBackups.delete(backupId)
    }

    // Persist manifest
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

    try {
      for (let i = 0; i < metadata.disks.length; i++) {
        const sourceDisk = metadata.disks[i]
        const targetPath = options.diskPaths[i]

        // Check if target already exists
        if (!options.overwriteExisting) {
          try {
            await stat(targetPath)
            throw new BackupError(
              BackupErrorCode.TARGET_EXISTS,
              `Target disk already exists: ${targetPath}. Set overwriteExisting to true to overwrite.`,
              { backupId: options.backupId, vmId: options.vmId, diskPath: targetPath }
            )
          } catch (error) {
            // stat throws if file doesn't exist — that's what we want
            if (error instanceof BackupError) throw error
          }
        }

        // Ensure target directory exists
        await mkdir(dirname(targetPath), { recursive: true })

        if (metadata.type === BackupType.SNAPSHOT) {
          // For snapshot backups, revert to the snapshot
          await this.snapshotMgr.revertSnapshot(sourceDisk.sourcePath, sourceDisk.backupPath)
          restoredDiskPaths.push(sourceDisk.sourcePath)
        } else {
          // For FULL/INCREMENTAL, copy the backup file to the target path
          await this.restoreDiskFile(sourceDisk.backupPath, targetPath)
          restoredDiskPaths.push(targetPath)
        }

        this.debug.log(`Restored disk ${i + 1}/${metadata.disks.length}: ${targetPath}`)
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

    // For snapshot backups, also delete the internal snapshot
    try {
      const metadata = await this.getBackupMetadata(backupId)
      if (metadata.type === BackupType.SNAPSHOT) {
        for (const disk of metadata.disks) {
          // backupPath holds the snapshot name for snapshot-type backups
          await this.snapshotMgr.deleteSnapshot(disk.sourcePath, disk.backupPath)
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
  // Private — Backup Strategies
  // =========================================================================

  /**
   * FULL backup: copies each disk via `qemu-img convert` to a standalone file.
   */
  private async executeFullBackup (
    config: BackupConfig,
    destDir: string,
    metadata: BackupMetadata,
    compression: BackupCompression
  ): Promise<void> {
    for (let i = 0; i < config.diskPaths.length; i++) {
      const sourcePath = config.diskPaths[i]
      const backupFileName = `disk-${i}.qcow2`
      const backupPath = join(destDir, backupFileName)

      this.debug.log(`FULL backup: copying disk ${i + 1}/${config.diskPaths.length}: ${sourcePath}`)

      // Get source info for metadata
      const sourceInfo = await this.qemuImg.getImageInfo(sourcePath)

      await this.qemuImg.convertImage({
        sourcePath,
        destPath: backupPath,
        destFormat: 'qcow2',
        compress: compression === BackupCompression.QCOW2
      })

      // Apply gzip on top if requested
      if (compression === BackupCompression.GZIP) {
        await this.gzipFile(backupPath)
      }

      const diskInfo = await this.buildDiskInfo(sourcePath, backupPath, sourceInfo.actualSize, 'qcow2')
      metadata.disks.push(diskInfo)
      metadata.totalSize += diskInfo.backupSize
      metadata.totalOriginalSize += diskInfo.originalSize

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
    compression: BackupCompression
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

    for (let i = 0; i < config.diskPaths.length; i++) {
      const sourcePath = config.diskPaths[i]
      const parentDiskBackupPath = parentMeta.disks[i].backupPath
      const backupFileName = `disk-${i}.qcow2`
      const backupPath = join(destDir, backupFileName)

      this.debug.log(
        `INCREMENTAL backup: creating overlay for disk ${i + 1}/${config.diskPaths.length}`
      )

      const sourceInfo = await this.qemuImg.getImageInfo(sourcePath)

      // Create a qcow2 overlay with the parent backup as the backing file
      const args = ['create', '-f', 'qcow2', '-b', parentDiskBackupPath, '-F', 'qcow2', '--', backupPath]
      await this.executor.execute('qemu-img', args)

      // Optionally apply compression to the overlay
      if (compression === BackupCompression.QCOW2) {
        await this.qemuImg.convertImage({
          sourcePath: backupPath,
          destPath: backupPath + '.tmp',
          destFormat: 'qcow2',
          compress: true
        })
        // Replace original with compressed version
        await this.executor.execute('mv', [backupPath + '.tmp', backupPath])
      }

      const diskInfo = await this.buildDiskInfo(sourcePath, backupPath, sourceInfo.actualSize, 'qcow2')
      diskInfo.backingFile = parentDiskBackupPath
      metadata.disks.push(diskInfo)
      metadata.totalSize += diskInfo.backupSize
      metadata.totalOriginalSize += diskInfo.originalSize

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

    this.emitProgress(metadata.id, config.vmId, 0, 1, 100)
  }

  // =========================================================================
  // Private — Helpers
  // =========================================================================

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

  /** Writes the backup manifest JSON to disk. */
  private async writeManifest (destDir: string, metadata: BackupMetadata): Promise<void> {
    const manifestPath = join(destDir, BACKUP_MANIFEST_FILENAME)
    await writeFile(manifestPath, JSON.stringify(metadata, null, 2), 'utf-8')
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

  /** Restores a single disk file by copying backup → target. */
  private async restoreDiskFile (sourceBackupPath: string, targetPath: string): Promise<void> {
    // Use qemu-img convert to ensure a clean, standalone image
    await this.qemuImg.convertImage({
      sourcePath: sourceBackupPath,
      destPath: targetPath,
      destFormat: 'qcow2',
      compress: false
    })
  }

  /** Compresses a file with gzip via OS-level gzip command. */
  private async gzipFile (filePath: string): Promise<void> {
    await this.executor.execute('gzip', ['-f', filePath])
    this.debug.log(`Gzipped: ${filePath}`)
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
