/**
 * NftablesPersistence handles exporting and importing nftables rules to/from disk.
 * This enables firewall rules to survive system reboots.
 *
 * The persistence mechanism works as follows:
 * 1. After any rule change, exportToDisk() saves the current infinization table
 * 2. On system boot, a systemd service loads rules using restoreFromDisk()
 * 3. Individual VM rule files are also maintained for debugging/recovery
 *
 * @example
 * import { NftablesPersistence } from '@network/NftablesPersistence'
 *
 * const persistence = new NftablesPersistence()
 *
 * // Export current rules to disk after changes
 * await persistence.exportToDisk()
 *
 * // Restore rules on system boot
 * await persistence.restoreFromDisk()
 */

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { CommandExecutor } from '@utils/commandExecutor'
import { Debugger } from '@utils/debug'
import {
  INFINIZATION_TABLE_NAME,
  INFINIZATION_TABLE_FAMILY
} from '../types/firewall.types'

// ============================================================================
// Constants
// ============================================================================

/** Directory for nftables persistence files */
export const NFTABLES_PERSISTENCE_DIR = '/etc/infinization/nftables'

/** Main ruleset file containing the full infinization table */
export const NFTABLES_MAIN_FILE = `${NFTABLES_PERSISTENCE_DIR}/infinization.nft`

/** Backup file for the previous ruleset (for rollback) */
export const NFTABLES_BACKUP_FILE = `${NFTABLES_PERSISTENCE_DIR}/infinization.nft.bak`

/** Lock file to prevent concurrent writes */
export const NFTABLES_LOCK_FILE = `${NFTABLES_PERSISTENCE_DIR}/.lock`

/** Maximum age of lock file before considering it stale (5 minutes) */
const LOCK_MAX_AGE_MS = 5 * 60 * 1000

// ============================================================================
// Types
// ============================================================================

export interface PersistenceResult {
  success: boolean
  filePath: string
  timestamp: Date
  error?: string
}

export interface RestoreResult {
  success: boolean
  rulesLoaded: boolean
  timestamp: Date
  error?: string
}

export interface PersistenceConfig {
  /** Directory for persistence files (default: /etc/infinization/nftables) */
  persistenceDir?: string
  /** Whether to create backup before overwriting (default: true) */
  createBackup?: boolean
  /** Whether to use file locking (default: true) */
  useLocking?: boolean
}

// ============================================================================
// NftablesPersistence Class
// ============================================================================

export class NftablesPersistence {
  private executor: CommandExecutor
  private debug: Debugger
  private config: Required<PersistenceConfig>

  constructor (config: PersistenceConfig = {}) {
    this.executor = new CommandExecutor()
    this.debug = new Debugger('nftables-persistence')
    this.config = {
      persistenceDir: config.persistenceDir ?? NFTABLES_PERSISTENCE_DIR,
      createBackup: config.createBackup ?? true,
      useLocking: config.useLocking ?? true
    }
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Exports the current infinization nftables table to disk.
   * This should be called after any rule changes to ensure persistence.
   *
   * The export process:
   * 1. Acquires a lock to prevent concurrent writes
   * 2. Backs up the existing file (if createBackup is enabled)
   * 3. Exports the current table using `nft list table`
   * 4. Writes to a temp file then atomically renames
   * 5. Releases the lock
   *
   * @returns Result indicating success/failure
   */
  async exportToDisk (): Promise<PersistenceResult> {
    const timestamp = new Date()
    const mainFile = `${this.config.persistenceDir}/infinization.nft`

    this.debug.log('Exporting nftables rules to disk')

    try {
      // Ensure directory exists
      await this.ensureDirectory()

      // Acquire lock
      if (this.config.useLocking) {
        await this.acquireLock()
      }

      try {
        // Get current ruleset
        const ruleset = await this.getCurrentRuleset()

        if (!ruleset) {
          this.debug.log('No infinization table found, nothing to export')
          return {
            success: true,
            filePath: mainFile,
            timestamp,
            error: 'No infinization table exists'
          }
        }

        // Create backup of existing file
        if (this.config.createBackup) {
          await this.createBackup(mainFile)
        }

        // Write ruleset atomically (write to temp, then rename)
        const tempFile = `${mainFile}.tmp`
        const content = this.formatRulesetForExport(ruleset, timestamp)

        await fs.writeFile(tempFile, content, { mode: 0o644 })
        await fs.rename(tempFile, mainFile)

        this.debug.log(`Rules exported to ${mainFile}`)

        return {
          success: true,
          filePath: mainFile,
          timestamp
        }
      } finally {
        // Always release lock
        if (this.config.useLocking) {
          await this.releaseLock()
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.debug.log('error', `Failed to export rules: ${errorMsg}`)

      return {
        success: false,
        filePath: mainFile,
        timestamp,
        error: errorMsg
      }
    }
  }

  /**
   * Restores nftables rules from disk.
   * Called by the systemd service on system boot.
   *
   * The restore process:
   * 1. Checks if the persistence file exists
   * 2. Validates the file format (basic sanity check)
   * 3. Loads rules using `nft -f`
   *
   * @returns Result indicating success/failure
   */
  async restoreFromDisk (): Promise<RestoreResult> {
    const timestamp = new Date()
    const mainFile = `${this.config.persistenceDir}/infinization.nft`

    this.debug.log('Restoring nftables rules from disk')

    try {
      // Check if file exists
      const exists = await this.fileExists(mainFile)
      if (!exists) {
        this.debug.log('No persistence file found, nothing to restore')
        return {
          success: true,
          rulesLoaded: false,
          timestamp,
          error: 'No persistence file exists'
        }
      }

      // Read and validate file
      const content = await fs.readFile(mainFile, 'utf-8')
      if (!this.validateRulesetFormat(content)) {
        this.debug.log('error', 'Invalid ruleset format in persistence file')
        return {
          success: false,
          rulesLoaded: false,
          timestamp,
          error: 'Invalid ruleset format'
        }
      }

      // Load rules
      await this.executor.execute('nft', ['-f', mainFile])

      this.debug.log('Rules restored successfully')

      return {
        success: true,
        rulesLoaded: true,
        timestamp
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.debug.log('error', `Failed to restore rules: ${errorMsg}`)

      return {
        success: false,
        rulesLoaded: false,
        timestamp,
        error: errorMsg
      }
    }
  }

  /**
   * Checks if persistence file exists and is valid.
   *
   * @returns true if a valid persistence file exists
   */
  async hasPersistenceFile (): Promise<boolean> {
    const mainFile = `${this.config.persistenceDir}/infinization.nft`

    try {
      const exists = await this.fileExists(mainFile)
      if (!exists) return false

      const content = await fs.readFile(mainFile, 'utf-8')
      return this.validateRulesetFormat(content)
    } catch {
      return false
    }
  }

  /**
   * Removes the persistence file (e.g., when all VMs are deleted).
   *
   * @returns true if file was removed or didn't exist
   */
  async removePersistenceFile (): Promise<boolean> {
    const mainFile = `${this.config.persistenceDir}/infinization.nft`
    const backupFile = `${this.config.persistenceDir}/infinization.nft.bak`

    this.debug.log('Removing persistence files')

    try {
      // Remove main file
      if (await this.fileExists(mainFile)) {
        await fs.unlink(mainFile)
        this.debug.log('Removed main persistence file')
      }

      // Remove backup file
      if (await this.fileExists(backupFile)) {
        await fs.unlink(backupFile)
        this.debug.log('Removed backup file')
      }

      return true
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.debug.log('error', `Failed to remove persistence files: ${errorMsg}`)
      return false
    }
  }

  /**
   * Rolls back to the previous ruleset backup.
   * Useful if a rule change causes issues.
   *
   * @returns Result indicating success/failure
   */
  async rollbackToBackup (): Promise<RestoreResult> {
    const timestamp = new Date()
    const backupFile = `${this.config.persistenceDir}/infinization.nft.bak`

    this.debug.log('Rolling back to backup ruleset')

    try {
      const exists = await this.fileExists(backupFile)
      if (!exists) {
        this.debug.log('No backup file found')
        return {
          success: false,
          rulesLoaded: false,
          timestamp,
          error: 'No backup file exists'
        }
      }

      // Load backup rules
      await this.executor.execute('nft', ['-f', backupFile])

      // Copy backup to main file
      const mainFile = `${this.config.persistenceDir}/infinization.nft`
      await fs.copyFile(backupFile, mainFile)

      this.debug.log('Rolled back to backup successfully')

      return {
        success: true,
        rulesLoaded: true,
        timestamp
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.debug.log('error', `Failed to rollback: ${errorMsg}`)

      return {
        success: false,
        rulesLoaded: false,
        timestamp,
        error: errorMsg
      }
    }
  }

  /**
   * Gets information about the persistence state.
   *
   * @returns Object with persistence status info
   */
  async getStatus (): Promise<{
    persistenceDir: string
    mainFileExists: boolean
    backupFileExists: boolean
    mainFileModified?: Date
    tableExists: boolean
  }> {
    const mainFile = `${this.config.persistenceDir}/infinization.nft`
    const backupFile = `${this.config.persistenceDir}/infinization.nft.bak`

    const mainFileExists = await this.fileExists(mainFile)
    const backupFileExists = await this.fileExists(backupFile)

    let mainFileModified: Date | undefined
    if (mainFileExists) {
      const stats = await fs.stat(mainFile)
      mainFileModified = stats.mtime
    }

    // Check if table exists in kernel
    let tableExists = false
    try {
      await this.executor.execute('nft', [
        'list', 'table',
        INFINIZATION_TABLE_FAMILY, INFINIZATION_TABLE_NAME
      ])
      tableExists = true
    } catch {
      tableExists = false
    }

    return {
      persistenceDir: this.config.persistenceDir,
      mainFileExists,
      backupFileExists,
      mainFileModified,
      tableExists
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Gets the current infinization table ruleset from the kernel.
   */
  private async getCurrentRuleset (): Promise<string | null> {
    try {
      const output = await this.executor.execute('nft', [
        'list', 'table',
        INFINIZATION_TABLE_FAMILY, INFINIZATION_TABLE_NAME
      ])
      return output
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      // Table doesn't exist
      if (errorMsg.includes('does not exist') || errorMsg.includes('No such')) {
        return null
      }
      throw error
    }
  }

  /**
   * Formats the ruleset for export with header comments.
   */
  private formatRulesetForExport (ruleset: string, timestamp: Date): string {
    const header = [
      '#!/usr/sbin/nft -f',
      '#',
      '# Infinization nftables rules',
      `# Exported: ${timestamp.toISOString()}`,
      '# DO NOT EDIT - This file is managed by infinization',
      '#',
      ''
    ].join('\n')

    return header + ruleset + '\n'
  }

  /**
   * Validates that the content looks like a valid nftables ruleset.
   */
  private validateRulesetFormat (content: string): boolean {
    // Basic sanity checks
    if (!content || content.trim().length === 0) {
      return false
    }

    // Should contain table definition
    if (!content.includes(`table ${INFINIZATION_TABLE_FAMILY} ${INFINIZATION_TABLE_NAME}`)) {
      return false
    }

    // Should have at least one chain (forward chain)
    if (!content.includes('chain forward')) {
      return false
    }

    return true
  }

  /**
   * Creates a backup of the existing file.
   */
  private async createBackup (filePath: string): Promise<void> {
    const exists = await this.fileExists(filePath)
    if (!exists) {
      return
    }

    const backupPath = `${filePath}.bak`
    await fs.copyFile(filePath, backupPath)
    this.debug.log(`Backup created: ${backupPath}`)
  }

  /**
   * Ensures the persistence directory exists.
   */
  private async ensureDirectory (): Promise<void> {
    try {
      await fs.mkdir(this.config.persistenceDir, { recursive: true, mode: 0o755 })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (!errorMsg.includes('EEXIST')) {
        throw error
      }
    }
  }

  /**
   * Checks if a file exists.
   */
  private async fileExists (filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Acquires a lock file to prevent concurrent writes.
   */
  private async acquireLock (): Promise<void> {
    const lockFile = `${this.config.persistenceDir}/.lock`

    // Check for stale lock
    try {
      const stats = await fs.stat(lockFile)
      const age = Date.now() - stats.mtime.getTime()

      if (age > LOCK_MAX_AGE_MS) {
        this.debug.log('Removing stale lock file')
        await fs.unlink(lockFile)
      } else {
        // Lock is held by another process
        throw new Error('Lock file exists and is not stale')
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      // ENOENT means no lock file - that's fine
      if (!errorMsg.includes('ENOENT')) {
        if (errorMsg.includes('Lock file exists')) {
          throw error
        }
      }
    }

    // Ensure directory exists
    await this.ensureDirectory()

    // Create lock file with exclusive flag
    const handle = await fs.open(lockFile, 'wx')
    await handle.write(`${process.pid}\n${Date.now()}\n`)
    await handle.close()

    this.debug.log('Lock acquired')
  }

  /**
   * Releases the lock file.
   */
  private async releaseLock (): Promise<void> {
    const lockFile = `${this.config.persistenceDir}/.lock`

    try {
      await fs.unlink(lockFile)
      this.debug.log('Lock released')
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      // Ignore if file doesn't exist
      if (!errorMsg.includes('ENOENT')) {
        this.debug.log('warn', `Failed to release lock: ${errorMsg}`)
      }
    }
  }
}
