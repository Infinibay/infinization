import { CommandExecutor } from '@utils/commandExecutor'
import { Debugger } from '@utils/debug'
import {
  SnapshotInfo,
  SnapshotCreateOptions,
  StorageError,
  StorageErrorCode,
  MAX_SNAPSHOT_NAME_LENGTH
} from '../types/storage.types'

/**
 * SnapshotManager manages internal qcow2 snapshots using qemu-img.
 * Uses safe command execution via spawn (no shell concatenation).
 *
 * @example
 * const snapshots = new SnapshotManager()
 * const imagePath = '/path/to/disk.qcow2'
 *
 * // Create snapshot with options
 * await snapshots.createSnapshot({
 *   imagePath,
 *   name: 'before-update',
 *   description: 'Snapshot before system update'
 * })
 *
 * // List snapshots
 * const list = await snapshots.listSnapshots(imagePath)
 *
 * // Revert to snapshot
 * await snapshots.revertSnapshot(imagePath, 'before-update')
 */
export class SnapshotManager {
  private executor: CommandExecutor
  private debug: Debugger

  constructor () {
    this.executor = new CommandExecutor()
    this.debug = new Debugger('snapshot-manager')
  }

  /**
   * Creates a new internal snapshot in a qcow2 image.
   * WARNING: VM must be stopped before creating snapshots.
   * @param options - Snapshot creation options
   * @throws StorageError if snapshot creation fails or name is invalid
   */
  async createSnapshot (options: SnapshotCreateOptions): Promise<void> {
    const { imagePath, name, description } = options
    this.validateSnapshotName(name)
    const descMsg = description ? ` (${description})` : ''
    this.debug.log(`Creating snapshot '${name}'${descMsg} in image: ${imagePath}`)

    try {
      await this.executor.execute('qemu-img', [
        'snapshot',
        '-c', name,
        imagePath
      ])
      this.debug.log(`Snapshot '${name}' created successfully`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (errorMessage.includes('already exists')) {
        throw new StorageError(
          StorageErrorCode.SNAPSHOT_ALREADY_EXISTS,
          `Snapshot '${name}' already exists in image ${imagePath}`,
          imagePath,
          'qemu-img snapshot -c'
        )
      }

      if (errorMessage.includes('in use') || errorMessage.includes('locked')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_IN_USE,
          `Cannot create snapshot: image ${imagePath} is in use. Stop the VM first.`,
          imagePath,
          'qemu-img snapshot -c'
        )
      }

      if (errorMessage.includes('No such file') || errorMessage.includes('Could not open')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_NOT_FOUND,
          `Image not found: ${imagePath}`,
          imagePath,
          'qemu-img snapshot -c'
        )
      }

      this.debug.log('error', `Failed to create snapshot '${name}' in image ${imagePath}: ${errorMessage}`)
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Failed to create snapshot '${name}' in image ${imagePath}: ${errorMessage}`,
        imagePath,
        'qemu-img snapshot -c'
      )
    }
  }

  /**
   * Lists all snapshots in a qcow2 image.
   * @param imagePath - Path to the qcow2 image file
   * @returns Array of SnapshotInfo objects
   * @throws StorageError if listing fails
   */
  async listSnapshots (imagePath: string): Promise<SnapshotInfo[]> {
    this.debug.log(`Listing snapshots in image: ${imagePath}`)

    try {
      const output = await this.executor.execute('qemu-img', [
        'snapshot',
        '-l',
        imagePath
      ])

      const snapshots = this.parseSnapshotList(output)
      this.debug.log(`Found ${snapshots.length} snapshot(s) in image ${imagePath}`)
      return snapshots
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (errorMessage.includes('No such file') || errorMessage.includes('Could not open')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_NOT_FOUND,
          `Image not found: ${imagePath}`,
          imagePath,
          'qemu-img snapshot -l'
        )
      }

      this.debug.log('error', `Failed to list snapshots for image ${imagePath}: ${errorMessage}`)
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Failed to list snapshots for image ${imagePath}: ${errorMessage}`,
        imagePath,
        'qemu-img snapshot -l'
      )
    }
  }

  /**
   * Reverts a qcow2 image to a previous snapshot state.
   * WARNING: VM must be stopped before reverting.
   * @param imagePath - Path to the qcow2 image file
   * @param snapshotName - Name of the snapshot to revert to
   * @throws StorageError if snapshot doesn't exist or revert fails
   */
  async revertSnapshot (imagePath: string, snapshotName: string): Promise<void> {
    this.debug.log(`Reverting image ${imagePath} to snapshot '${snapshotName}'`)

    try {
      await this.executor.execute('qemu-img', [
        'snapshot',
        '-a', snapshotName,
        imagePath
      ])
      this.debug.log(`Image reverted to snapshot '${snapshotName}' successfully`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (errorMessage.includes('not found') || errorMessage.includes('does not exist')) {
        throw new StorageError(
          StorageErrorCode.SNAPSHOT_NOT_FOUND,
          `Snapshot '${snapshotName}' not found in image ${imagePath}`,
          imagePath,
          'qemu-img snapshot -a'
        )
      }

      if (errorMessage.includes('in use') || errorMessage.includes('locked')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_IN_USE,
          `Cannot revert snapshot: image ${imagePath} is in use. Stop the VM first.`,
          imagePath,
          'qemu-img snapshot -a'
        )
      }

      if (errorMessage.includes('No such file') || errorMessage.includes('Could not open')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_NOT_FOUND,
          `Image not found: ${imagePath}`,
          imagePath,
          'qemu-img snapshot -a'
        )
      }

      this.debug.log('error', `Failed to revert to snapshot '${snapshotName}' in image ${imagePath}: ${errorMessage}`)
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Failed to revert to snapshot '${snapshotName}' in image ${imagePath}: ${errorMessage}`,
        imagePath,
        'qemu-img snapshot -a'
      )
    }
  }

  /**
   * Deletes a snapshot from a qcow2 image.
   * @param imagePath - Path to the qcow2 image file
   * @param snapshotName - Name of the snapshot to delete
   * @throws StorageError if deletion fails (handles non-existent snapshots gracefully)
   */
  async deleteSnapshot (imagePath: string, snapshotName: string): Promise<void> {
    this.debug.log(`Deleting snapshot '${snapshotName}' from image: ${imagePath}`)

    try {
      await this.executor.execute('qemu-img', [
        'snapshot',
        '-d', snapshotName,
        imagePath
      ])
      this.debug.log(`Snapshot '${snapshotName}' deleted successfully`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Handle gracefully if snapshot doesn't exist
      if (errorMessage.includes('not found') || errorMessage.includes('does not exist')) {
        this.debug.log(`Snapshot '${snapshotName}' does not exist in image ${imagePath}, nothing to delete`)
        return
      }

      if (errorMessage.includes('No such file') || errorMessage.includes('Could not open')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_NOT_FOUND,
          `Image not found: ${imagePath}`,
          imagePath,
          'qemu-img snapshot -d'
        )
      }

      this.debug.log('error', `Failed to delete snapshot '${snapshotName}' from image ${imagePath}: ${errorMessage}`)
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Failed to delete snapshot '${snapshotName}' from image ${imagePath}: ${errorMessage}`,
        imagePath,
        'qemu-img snapshot -d'
      )
    }
  }

  /**
   * Checks if a snapshot exists in a qcow2 image.
   * @param imagePath - Path to the qcow2 image file
   * @param snapshotName - Name of the snapshot to check
   * @returns true if snapshot exists, false otherwise
   */
  async snapshotExists (imagePath: string, snapshotName: string): Promise<boolean> {
    this.debug.log(`Checking if snapshot '${snapshotName}' exists in image: ${imagePath}`)

    try {
      const snapshots = await this.listSnapshots(imagePath)
      const exists = snapshots.some(snap => snap.name === snapshotName)
      this.debug.log(`Snapshot '${snapshotName}' ${exists ? 'exists' : 'does not exist'}`)
      return exists
    } catch {
      // If we can't list snapshots, assume it doesn't exist
      this.debug.log(`Could not check snapshot existence, assuming not present`)
      return false
    }
  }

  /**
   * Validates a snapshot name.
   * @param name - The snapshot name to validate
   * @throws StorageError if name is invalid
   */
  private validateSnapshotName (name: string): void {
    if (!name || name.trim().length === 0) {
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        'Snapshot name cannot be empty',
        undefined,
        'qemu-img snapshot'
      )
    }

    if (name.length > MAX_SNAPSHOT_NAME_LENGTH) {
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Snapshot name cannot exceed ${MAX_SNAPSHOT_NAME_LENGTH} characters`,
        undefined,
        'qemu-img snapshot'
      )
    }

    const validPattern = /^[a-zA-Z0-9_-]+$/
    if (!validPattern.test(name)) {
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        'Snapshot name can only contain alphanumeric characters, hyphens, and underscores',
        undefined,
        'qemu-img snapshot'
      )
    }
  }

  /**
   * Parses the output of qemu-img snapshot -l command.
   *
   * Output format example:
   * ```
   * Snapshot list:
   * ID        TAG                 VM SIZE                DATE       VM CLOCK
   * 1         snap1                    0 B 2024-01-15 10:30:00   00:00:00.000
   * 2         snap2                    0 B 2024-01-16 14:45:30   00:00:00.000
   * ```
   *
   * Parsing strategy:
   * - Split on multiple whitespace to handle variable column widths
   * - Verify minimum column count before extracting fields
   * - Handle size strings that may contain spaces (e.g., "0 B", "256 MiB")
   * - Treat snapshot IDs as strings (not necessarily numeric)
   * - Log warnings for unparseable lines
   *
   * @param output - The stdout from qemu-img snapshot -l
   * @returns Array of SnapshotInfo objects
   */
  private parseSnapshotList (output: string): SnapshotInfo[] {
    const snapshots: SnapshotInfo[] = []
    const lines = output.split('\n')

    // Find the data lines (skip header lines)
    let dataStarted = false
    for (const line of lines) {
      const trimmed = line.trim()

      // Skip empty lines
      if (!trimmed) continue

      // Skip header lines - look for "Snapshot list:" or column headers
      if (trimmed.startsWith('Snapshot list:') || trimmed.match(/^ID\s+TAG/i)) {
        dataStarted = true
        continue
      }

      // Only process lines after headers
      if (!dataStarted) continue

      // Parse snapshot line using a more robust approach
      // Split on 2+ whitespace characters to separate columns
      const columns = trimmed.split(/\s{2,}/)

      // We need at least: ID, TAG, VM SIZE, DATE, VM CLOCK
      // But VM SIZE might have been split if it contains single space
      if (columns.length < 4) {
        this.debug.log('error', `Skipping unparseable snapshot line (too few columns): "${trimmed}"`)
        continue
      }

      // Try the regex approach first for well-formatted output
      // Pattern: ID (any non-whitespace), TAG (any non-whitespace), VM SIZE (anything before date),
      //          DATE (YYYY-MM-DD HH:MM:SS), VM CLOCK (timestamp format)
      const regexMatch = trimmed.match(/^(\S+)\s+(\S+)\s+(.+?)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)/)

      if (regexMatch) {
        const vmSizeStr = regexMatch[3].trim()
        const vmSize = this.parseSize(vmSizeStr)

        snapshots.push({
          id: regexMatch[1],
          name: regexMatch[2],
          vmSize,
          date: regexMatch[4],
          vmClock: regexMatch[5]
        })
        continue
      }

      // Fallback: try column-based parsing for unusual formats
      // Assume: columns[0] = ID, columns[1] = TAG, last = VM CLOCK, second-to-last = DATE (if date-like)
      // Everything in between = VM SIZE
      if (columns.length >= 4) {
        const id = columns[0]
        const name = columns[1]
        const vmClock = columns[columns.length - 1]

        // Check if second-to-last looks like a date
        const potentialDate = columns[columns.length - 2]
        const dateMatch = potentialDate.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/)
        if (dateMatch) {
          const vmSizeStr = columns.slice(2, -2).join(' ')
          const vmSize = this.parseSize(vmSizeStr)

          snapshots.push({
            id,
            name,
            vmSize,
            date: potentialDate,
            vmClock
          })
          continue
        }
      }

      // If we get here, log a warning about unparseable line
      this.debug.log('error', `Skipping unparseable snapshot line (format not recognized): "${trimmed}"`)
    }

    return snapshots
  }

  /**
   * Parses a human-readable size string to bytes.
   * @param sizeStr - Size string like "0 B", "1 KiB", "256 MiB"
   * @returns Size in bytes
   */
  private parseSize (sizeStr: string): number {
    const match = sizeStr.match(/^([\d.]+)\s*(\w+)?$/)
    if (!match) return 0

    const value = parseFloat(match[1])
    const unit = (match[2] || 'B').toUpperCase()

    const multipliers: Record<string, number> = {
      B: 1,
      KIB: 1024,
      MIB: 1024 * 1024,
      GIB: 1024 * 1024 * 1024,
      TIB: 1024 * 1024 * 1024 * 1024,
      KB: 1000,
      MB: 1000 * 1000,
      GB: 1000 * 1000 * 1000,
      TB: 1000 * 1000 * 1000 * 1000
    }

    return value * (multipliers[unit] || 1)
  }
}
