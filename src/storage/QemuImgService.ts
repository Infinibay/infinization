import { CommandExecutor } from '@utils/commandExecutor'
import { Debugger } from '@utils/debug'
import {
  ImageInfo,
  ImageCheckResult,
  ImageFormat,
  SnapshotInfo,
  CreateImageOptions,
  ConvertImageOptions,
  StorageError,
  StorageErrorCode
} from '../types/storage.types'

/**
 * QemuImgService manages disk image operations using qemu-img.
 * Uses safe command execution via spawn (no shell concatenation).
 *
 * @example
 * const qemuImg = new QemuImgService()
 *
 * // Create a new qcow2 image with options
 * await qemuImg.createImage({
 *   path: '/path/to/disk.qcow2',
 *   sizeGB: 50,
 *   format: 'qcow2',
 *   preallocation: 'metadata'
 * })
 *
 * // Get image information
 * const info = await qemuImg.getImageInfo('/path/to/disk.qcow2')
 */
export class QemuImgService {
  private executor: CommandExecutor
  private debug: Debugger

  constructor () {
    this.executor = new CommandExecutor()
    this.debug = new Debugger('qemu-img')
  }

  /**
   * Creates a new disk image.
   * @param options - Image creation options
   * @throws StorageError if image creation fails
   */
  async createImage (options: CreateImageOptions): Promise<void> {
    const { path, sizeGB, format, clusterSize, preallocation } = options
    this.debug.log(`Creating ${format} image: ${path} (${sizeGB}GB)`)

    const args: string[] = ['create', '-f', format]

    // Add optional qcow2-specific options
    if (format === 'qcow2') {
      const qcow2Options: string[] = []
      if (clusterSize) {
        qcow2Options.push(`cluster_size=${clusterSize}`)
      }
      if (preallocation) {
        qcow2Options.push(`preallocation=${preallocation}`)
      }
      if (qcow2Options.length > 0) {
        args.push('-o', qcow2Options.join(','))
      }
    }

    args.push(path, `${sizeGB}G`)

    try {
      await this.executor.execute('qemu-img', args)
      this.debug.log(`Image created successfully: ${path}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (errorMessage.includes('already exists') || errorMessage.includes('File exists')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_ALREADY_EXISTS,
          `Image already exists: ${path}`,
          path,
          'qemu-img create'
        )
      }

      if (errorMessage.includes('Permission denied')) {
        throw new StorageError(
          StorageErrorCode.PERMISSION_DENIED,
          `Permission denied creating image: ${path}`,
          path,
          'qemu-img create'
        )
      }

      this.debug.log('error', `Failed to create image ${path}: ${errorMessage}`)
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Failed to create image ${path}: ${errorMessage}`,
        path,
        'qemu-img create'
      )
    }
  }

  /**
   * Gets detailed information about a disk image.
   * @param path - Path to the image file
   * @returns ImageInfo object with image details
   * @throws StorageError if image doesn't exist or info cannot be retrieved
   */
  async getImageInfo (path: string): Promise<ImageInfo> {
    this.debug.log(`Getting info for image: ${path}`)

    try {
      const output = await this.executor.execute('qemu-img', [
        'info',
        '--output=json',
        path
      ])

      const info = JSON.parse(output)
      const imageInfo: ImageInfo = {
        filename: info.filename,
        format: info.format as ImageFormat,
        virtualSize: info['virtual-size'],
        actualSize: info['actual-size'] || 0,
        clusterSize: info['cluster-size'],
        encrypted: info.encrypted || false,
        backingFile: info['backing-filename']
      }

      // Parse snapshots if present
      if (info.snapshots && Array.isArray(info.snapshots)) {
        imageInfo.snapshots = info.snapshots.map((snap: Record<string, unknown>) => ({
          id: String(snap.id),
          name: String(snap.name),
          vmSize: Number(snap['vm-state-size']) || 0,
          date: String(snap.date || ''),
          vmClock: String(snap['vm-clock-sec'] || '0')
        }))
      }

      this.debug.log(`Image info retrieved: format=${imageInfo.format}, virtualSize=${imageInfo.virtualSize}`)
      return imageInfo
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (errorMessage.includes('No such file') || errorMessage.includes('Could not open')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_NOT_FOUND,
          `Image not found: ${path}`,
          path,
          'qemu-img info'
        )
      }

      if (errorMessage.includes('JSON') || errorMessage.includes('Unexpected token')) {
        this.debug.log('error', `Failed to parse image info for ${path}: invalid output`)
        throw new StorageError(
          StorageErrorCode.PARSE_ERROR,
          `Failed to parse image info for ${path}: invalid output`,
          path,
          'qemu-img info'
        )
      }

      this.debug.log('error', `Failed to get info for image ${path}: ${errorMessage}`)
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Failed to get info for image ${path}: ${errorMessage}`,
        path,
        'qemu-img info'
      )
    }
  }

  /**
   * Resizes a disk image.
   * WARNING: VM must be stopped before resizing.
   * @param path - Path to the image file
   * @param newSizeGB - New size in gigabytes
   * @throws StorageError if resize fails or VM is running
   */
  async resizeImage (path: string, newSizeGB: number): Promise<void> {
    this.debug.log(`Resizing image: ${path} to ${newSizeGB}GB`)

    if (newSizeGB <= 0) {
      throw new StorageError(
        StorageErrorCode.INVALID_SIZE,
        `Invalid size: ${newSizeGB}GB. Size must be positive.`,
        path,
        'qemu-img resize'
      )
    }

    try {
      await this.executor.execute('qemu-img', [
        'resize',
        path,
        `${newSizeGB}G`
      ])
      this.debug.log(`Image resized successfully: ${path} to ${newSizeGB}GB`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (errorMessage.includes('in use') || errorMessage.includes('locked')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_IN_USE,
          `Cannot resize image ${path}: image is in use. Stop the VM first.`,
          path,
          'qemu-img resize'
        )
      }

      if (errorMessage.includes('No such file') || errorMessage.includes('Could not open')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_NOT_FOUND,
          `Image not found: ${path}`,
          path,
          'qemu-img resize'
        )
      }

      this.debug.log('error', `Failed to resize image ${path}: ${errorMessage}`)
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Failed to resize image ${path}: ${errorMessage}`,
        path,
        'qemu-img resize'
      )
    }
  }

  /**
   * Converts a disk image to a different format.
   * @param options - Image conversion options
   * @throws StorageError if conversion fails
   */
  async convertImage (options: ConvertImageOptions): Promise<void> {
    const { sourcePath, destPath, destFormat, compress } = options
    this.debug.log(`Converting image: ${sourcePath} -> ${destPath} (format: ${destFormat})`)

    try {
      // Get source format
      const sourceInfo = await this.getImageInfo(sourcePath)
      const sourceFormat = sourceInfo.format

      const args: string[] = [
        'convert',
        '-f', sourceFormat,
        '-O', destFormat
      ]

      // Add compression if enabled (qcow2 only)
      if (compress && destFormat === 'qcow2') {
        args.push('-c')
      }

      args.push(sourcePath, destPath)

      await this.executor.execute('qemu-img', args)
      this.debug.log(`Image converted successfully: ${sourcePath} -> ${destPath}`)
    } catch (error) {
      // Re-throw StorageErrors as-is
      if (error instanceof StorageError) {
        throw error
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      this.debug.log('error', `Failed to convert image ${sourcePath} to ${destPath}: ${errorMessage}`)
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Failed to convert image ${sourcePath} to ${destPath}: ${errorMessage}`,
        sourcePath,
        'qemu-img convert'
      )
    }
  }

  /**
   * Checks a disk image for errors and corruption.
   * @param path - Path to the image file
   * @returns ImageCheckResult with error counts
   * @throws StorageError if check fails to execute (not if corruption is found)
   */
  async checkImage (path: string): Promise<ImageCheckResult> {
    this.debug.log(`Checking image: ${path}`)

    try {
      const output = await this.executor.execute('qemu-img', [
        'check',
        '--output=json',
        path
      ])

      const checkResult = JSON.parse(output)
      const imageCheckResult: ImageCheckResult = {
        errors: checkResult['check-errors'] || 0,
        leaks: checkResult.leaks || 0,
        corruptions: checkResult.corruptions || 0,
        totalClusters: checkResult['total-clusters'] || 0,
        allocatedClusters: checkResult['allocated-clusters'] || 0
      }

      this.debug.log(`Image check completed: errors=${imageCheckResult.errors}, leaks=${imageCheckResult.leaks}`)
      return imageCheckResult
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // qemu-img check returns non-zero exit code if errors found, but still outputs JSON to stdout
      // Extract stdout section from error message (format: "stdout: <content>\nstderr: <content>")
      const stdoutMatch = errorMessage.match(/stdout:\s*([\s\S]*?)\nstderr:/)
      if (stdoutMatch && stdoutMatch[1].trim()) {
        try {
          const checkResult = JSON.parse(stdoutMatch[1].trim())
          const result: ImageCheckResult = {
            errors: checkResult['check-errors'] || 0,
            leaks: checkResult.leaks || 0,
            corruptions: checkResult.corruptions || 0,
            totalClusters: checkResult['total-clusters'] || 0,
            allocatedClusters: checkResult['allocated-clusters'] || 0
          }
          this.debug.log(`Image check completed with issues: errors=${result.errors}, leaks=${result.leaks}, corruptions=${result.corruptions}`)
          return result
        } catch {
          // JSON parse failed, fall through to error
          this.debug.log('error', `Failed to parse qemu-img check output as JSON`)
        }
      }

      if (errorMessage.includes('No such file') || errorMessage.includes('Could not open')) {
        throw new StorageError(
          StorageErrorCode.IMAGE_NOT_FOUND,
          `Image not found: ${path}`,
          path,
          'qemu-img check'
        )
      }

      this.debug.log('error', `Failed to check image ${path}: ${errorMessage}`)
      throw new StorageError(
        StorageErrorCode.COMMAND_FAILED,
        `Failed to check image ${path}: ${errorMessage}`,
        path,
        'qemu-img check'
      )
    }
  }
}
