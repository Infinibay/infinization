import { ChildProcess, spawn } from 'child_process'
import { promises as fsPromises } from 'fs'
import { Debugger } from '../utils/debug'
import { isProcessAlive as sharedIsProcessAlive, waitForProcessExit as sharedWaitForProcessExit } from '../utils/processIdentity'
import { QemuCommandBuilder, QemuCommandWithPinning } from './QemuCommandBuilder'

/**
 * QemuProcess manages the lifecycle of a QEMU virtual machine process.
 * It handles starting, stopping, and monitoring QEMU processes.
 *
 * When -daemonize is used with a pidfile, the process reads the PID from the
 * pidfile after spawn to track the actual daemonized QEMU process. Without
 * -daemonize, the spawned child process PID is used directly.
 */
export class QemuProcess {
  private process: ChildProcess | null = null
  private pid: number | null = null
  private qmpSocketPath: string | null = null
  private pidFilePath: string | null = null
  private debug: Debugger
  private stopping: boolean = false

  // CPU pinning information (populated after start)
  private cpuPinningApplied: boolean = false
  private pinnedCores: number[] = []
  private numaNodes: number[] = []

  /**
   * Create a new QemuProcess instance
   * @param vmId - Unique identifier for the VM
   * @param commandBuilder - Configured QemuCommandBuilder instance
   */
  constructor (
    private vmId: string,
    private commandBuilder: QemuCommandBuilder
  ) {
    this.debug = new Debugger('qemu-process')
  }

  /**
   * Set the QMP socket path (for waiting after start)
   * @param path - Path to QMP socket
   */
  setQmpSocketPath (path: string): void {
    this.qmpSocketPath = path
  }

  /**
   * Set the PID file path (for cleanup and daemonized PID tracking)
   * @param path - Path to PID file
   */
  setPidFilePath (path: string): void {
    this.pidFilePath = path
  }

  /**
   * Start the QEMU process
   *
   * If CPU pinning is enabled in the command builder, this method will use
   * `numactl` as a wrapper to pin the QEMU process to specific CPU cores
   * and NUMA memory nodes.
   */
  async start (): Promise<void> {
    // Check if CPU pinning is enabled and get the appropriate command
    let commandResult: QemuCommandWithPinning
    if (this.commandBuilder.isCpuPinningEnabled()) {
      commandResult = await this.commandBuilder.buildCommandWithPinning()
    } else {
      const baseCommand = this.commandBuilder.buildCommand()
      commandResult = {
        ...baseCommand,
        wrapperCommand: null,
        wrapperArgs: [],
        pinningApplied: false,
        pinnedCores: [],
        numaNodes: []
      }
    }

    // Store CPU pinning information
    this.cpuPinningApplied = commandResult.pinningApplied
    this.pinnedCores = commandResult.pinnedCores
    this.numaNodes = commandResult.numaNodes

    // Determine actual command and args based on wrapper presence
    let actualCommand: string
    let actualArgs: string[]

    if (commandResult.wrapperCommand) {
      // Use wrapper (e.g., numactl) with QEMU as an argument
      actualCommand = commandResult.wrapperCommand
      actualArgs = [
        ...commandResult.wrapperArgs,
        commandResult.command,
        ...commandResult.args
      ]
      this.debug.log(`CPU pinning enabled: cores [${commandResult.pinnedCores.join(',')}], NUMA nodes [${commandResult.numaNodes.join(',')}]`)
    } else {
      // Direct QEMU execution
      actualCommand = commandResult.command
      actualArgs = commandResult.args
    }

    const isDaemonized = this.commandBuilder.isDaemonizeEnabled()
    const pidfilePath = this.pidFilePath || this.commandBuilder.getPidfilePath()

    // Log command in a readable format
    this.debug.log(`Starting VM ${this.vmId}`)
    if (commandResult.wrapperCommand) {
      this.debug.log(`Wrapper: ${commandResult.wrapperCommand} ${commandResult.wrapperArgs.join(' ')}`)
    }
    this.debug.log(`Command: ${commandResult.command}`)
    this.debug.log(`Arguments (${commandResult.args.length}):`)
    for (let i = 0; i < commandResult.args.length; i += 2) {
      const arg = commandResult.args[i]
      const value = commandResult.args[i + 1]
      if (value && !value.startsWith('-')) {
        this.debug.log(`  ${arg} ${value}`)
      } else {
        this.debug.log(`  ${arg}`)
        if (value) i-- // Reprocess value as next arg
      }
    }
    this.debug.log(`Full command: ${actualCommand} ${actualArgs.join(' ')}`)

    return new Promise((resolve, reject) => {
      let stderrBuffer = ''
      let startCompleted = false
      let processExited = false
      let exitCode: number | null = null
      let exitSignal: NodeJS.Signals | null = null

      const handleEarlyExit = () => {
        if (!startCompleted && processExited) {
          // For daemonized processes, exit code 0 is expected (parent forks and exits)
          // We should NOT treat this as an error - the startup wait (pidfile/QMP) will handle success/failure
          if (isDaemonized && exitCode === 0) {
            this.debug.log(`VM ${this.vmId} parent process exited normally (daemonize fork), waiting for daemon startup...`)
            return
          }

          const errorMsg = stderrBuffer
            ? `VM ${this.vmId} exited during startup with code ${exitCode}, signal ${exitSignal}: ${stderrBuffer}`
            : `VM ${this.vmId} exited during startup with code ${exitCode}, signal ${exitSignal}`
          this.debug.log('error', errorMsg)
          reject(new Error(errorMsg))
        }
      }

      this.process = spawn(actualCommand, actualArgs, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      // Initially capture child process PID (will be updated for daemonized processes)
      this.pid = this.process.pid ?? null

      if (this.pid) {
        this.debug.log(`VM ${this.vmId} spawned with PID ${this.pid}`)
      }

      this.process.stdout?.on('data', (data) => {
        this.debug.log('stdout', data.toString())
      })

      this.process.stderr?.on('data', (data) => {
        const str = data.toString()
        stderrBuffer += str
        this.debug.log('stderr', str)
      })

      this.process.on('error', (error) => {
        this.debug.log('error', `Failed to start VM ${this.vmId}: ${error.message}`)
        if (!startCompleted) {
          startCompleted = true
          reject(error)
        }
      })

      this.process.on('exit', (code, signal) => {
        processExited = true
        exitCode = code
        exitSignal = signal
        this.debug.log(`VM ${this.vmId} exited with code ${code}, signal ${signal}`)
        if (stderrBuffer) {
          this.debug.log('error', `VM ${this.vmId} stderr output:\n${stderrBuffer}`)
        }
        if (code === 0 && isDaemonized) {
          this.debug.log(`VM ${this.vmId} daemonize fork completed (parent exited with code 0)`)
        }

        // For non-daemonized processes, clear state on exit
        if (!isDaemonized) {
          this.process = null
          this.pid = null
        }

        // Check for early exit during startup
        handleEarlyExit()
      })

      const completeStart = async () => {
        if (startCompleted) return

        // For daemonized processes the fork-parent (this.process) has already
        // exited; we must adopt the REAL daemon PID from the pidfile. If we cannot,
        // FAIL the start rather than resolving with a stale/recyclable fork PID —
        // otherwise stop()/forceKill()/isAlive() would later target the wrong PID.
        if (isDaemonized && pidfilePath) {
          let daemonPid = NaN
          try {
            await this.waitForPidFile(pidfilePath)
            const pidContent = await fsPromises.readFile(pidfilePath, 'utf-8')
            daemonPid = parseInt(pidContent.trim(), 10)
          } catch (error) {
            if (startCompleted) return
            startCompleted = true
            this.killSpawnedChild()
            reject(new Error(`Failed to read daemon PID for VM ${this.vmId} from ${pidfilePath}: ${(error as Error).message}`))
            return
          }
          if (isNaN(daemonPid) || daemonPid <= 0) {
            if (startCompleted) return
            startCompleted = true
            this.killSpawnedChild()
            reject(new Error(`Daemon pidfile for VM ${this.vmId} did not contain a valid PID`))
            return
          }
          this.pid = daemonPid
          // Drop the dead fork-parent handle so stop() signals the daemon PID
          // (process.kill branch) instead of the exited parent, and release its
          // listeners + unref it so it cannot pin the event loop or leak.
          if (this.process) {
            this.process.removeAllListeners()
            this.process.unref()
            this.process = null
          }
          this.debug.log(`VM ${this.vmId} daemonized with PID ${this.pid}`)
        }

        if (startCompleted) return
        startCompleted = true
        this.debug.log(`VM ${this.vmId} ready`)
        resolve()
      }

      const handleStartupError = (error: Error) => {
        if (startCompleted) return
        startCompleted = true
        // Never leak the child we spawned if startup failed.
        this.killSpawnedChild()
        reject(error)
      }

      // Wait for QMP socket if configured
      if (this.qmpSocketPath) {
        // For daemonized processes, don't treat parent exit (code 0) as an error
        // The daemon child is still starting up
        const shouldCheckEarlyExit = () => {
          if (!processExited) return false
          // For daemonized processes, exit code 0 means successful fork, not failure
          if (isDaemonized && exitCode === 0) return false
          return true
        }
        this.waitForQmpSocketWithEarlyExit(shouldCheckEarlyExit, stderrBuffer)
          .then(completeStart)
          .catch(handleStartupError)
      } else if (isDaemonized && pidfilePath) {
        // For daemonized processes, wait for pidfile
        this.waitForPidFile(pidfilePath)
          .then(completeStart)
          .catch(handleStartupError)
      } else {
        // For non-daemonized without QMP, poll for process alive status
        this.waitForProcessAliveWithEarlyExit(() => processExited, () => stderrBuffer)
          .then(completeStart)
          .catch(handleStartupError)
      }
    })
  }

  /**
   * Stop the QEMU process gracefully
   * @param timeoutMs - Timeout in milliseconds before force kill
   */
  async stop (timeoutMs: number = 30000): Promise<void> {
    if (this.stopping) {
      this.debug.log(`VM ${this.vmId} stop already in progress`)
      return
    }

    if (!this.pid) {
      this.debug.log(`VM ${this.vmId} is not running`)
      return
    }

    this.stopping = true
    this.debug.log(`Stopping VM ${this.vmId} (PID ${this.pid})`)

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(async () => {
          this.debug.log('warn', `VM ${this.vmId} did not stop gracefully, force killing`)
          try {
            await this.forceKill()
            resolve()
          } catch (error) {
            reject(error)
          }
        }, timeoutMs)

        // Use .once() to prevent listener accumulation
        if (this.process) {
          this.process.once('exit', async () => {
            clearTimeout(timeout)
            await this.cleanupPidFile()
            this.debug.log(`VM ${this.vmId} stopped`)
            resolve()
          })

          // Send SIGTERM for graceful shutdown
          this.process.kill('SIGTERM')
        } else {
          // Process handle not available (daemonized), use kill directly
          try {
            process.kill(this.pid!, 'SIGTERM')
          } catch (error) {
            clearTimeout(timeout)
            this.debug.log('warn', `Failed to send SIGTERM: ${(error as Error).message}`)
          }

          // Poll for process exit. Only resolve if it actually exited; otherwise
          // do nothing and let the outer timeout escalate to forceKill().
          this.waitForProcessExit(timeoutMs)
            .then(async (exited) => {
              if (!exited) return // outer setTimeout will force kill
              clearTimeout(timeout)
              await this.cleanupPidFile()
              this.debug.log(`VM ${this.vmId} stopped`)
              resolve()
            })
            .catch(() => {
              // Timeout will handle force kill
            })
        }
      })
    } finally {
      this.stopping = false
    }
  }

  /**
   * Kill and release the child we spawned (the fork-parent for daemonized mode,
   * or the QEMU process for non-daemonized mode). Best-effort; used on startup
   * failure so a failed start() never leaks the spawned process or its listeners.
   */
  private killSpawnedChild (): void {
    if (this.process) {
      try {
        this.process.removeAllListeners()
        if (this.process.pid && !this.process.killed) {
          this.process.kill('SIGKILL')
        }
        this.process.unref()
      } catch {
        /* best effort */
      }
      this.process = null
    }
  }

  /**
   * Force kill the QEMU process. Throws if the process is still alive after
   * SIGKILL + timeout, so the caller can alarm/retry instead of treating a live
   * process (still holding TAP/disk/display) as stopped.
   */
  async forceKill (): Promise<void> {
    if (!this.pid) {
      return
    }

    this.debug.log(`Force killing VM ${this.vmId} (PID ${this.pid})`)

    try {
      process.kill(this.pid, 'SIGKILL')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') {
        // ESRCH = already gone (fine). Anything else is a real failure.
        this.debug.log('warn', `Failed to kill process ${this.pid}: ${(error as Error).message}`)
      }
    }

    const gone = await sharedWaitForProcessExit(this.pid, 5000)
    await this.cleanupPidFile()

    if (!gone) {
      // Do NOT clear pid/process: the process is still alive and the caller must
      // know it was not reaped (it still holds the TAP/disk/display).
      throw new Error(`VM ${this.vmId} process ${this.pid} is still alive after SIGKILL`)
    }

    this.process = null
    this.pid = null
  }

  /**
   * Check if the process is alive (delegates to the shared zombie-aware check).
   */
  isAlive (): boolean {
    if (!this.pid) {
      return false
    }
    return sharedIsProcessAlive(this.pid)
  }

  /**
   * Get the current PID
   */
  getPid (): number | null {
    return this.pid
  }

  /**
   * Wait for PID file to appear and contain a valid PID
   */
  private async waitForPidFile (pidfilePath: string, timeoutMs: number = 5000): Promise<void> {
    const startTime = Date.now()
    const pollInterval = 100

    while (Date.now() - startTime < timeoutMs) {
      try {
        const content = await fsPromises.readFile(pidfilePath, 'utf-8')
        const pid = parseInt(content.trim(), 10)
        if (!isNaN(pid) && pid > 0) {
          return
        }
      } catch {
        // File doesn't exist yet or is empty
      }
      await this.sleep(pollInterval)
    }

    throw new Error(`PID file ${pidfilePath} not available after ${timeoutMs}ms`)
  }

  /**
   * Wait for QMP socket with early exit detection
   */
  private async waitForQmpSocketWithEarlyExit (
    hasExited: () => boolean,
    stderrBuffer: string,
    timeoutMs: number = 5000
  ): Promise<void> {
    const startTime = Date.now()
    const pollInterval = 100

    while (Date.now() - startTime < timeoutMs) {
      // Check for early exit
      if (hasExited()) {
        throw new Error(`Process exited before QMP socket became available: ${stderrBuffer}`)
      }

      try {
        await fsPromises.access(this.qmpSocketPath!)
        return
      } catch {
        await this.sleep(pollInterval)
      }
    }

    throw new Error(`QMP socket ${this.qmpSocketPath} not available after ${timeoutMs}ms`)
  }

  /**
   * Wait for process to be alive with early exit detection
   */
  private async waitForProcessAliveWithEarlyExit (
    hasExited: () => boolean,
    getStderr: () => string,
    timeoutMs: number = 1000
  ): Promise<void> {
    const startTime = Date.now()
    const pollInterval = 100

    while (Date.now() - startTime < timeoutMs) {
      // Check for early exit
      if (hasExited()) {
        throw new Error(`Process exited during startup: ${getStderr()}`)
      }

      if (this.pid && this.isAlive()) {
        return
      }

      await this.sleep(pollInterval)
    }

    if (!this.pid || !this.isAlive()) {
      throw new Error(`Failed to start VM ${this.vmId}: process not alive after ${timeoutMs}ms`)
    }
  }

  /**
   * Wait for the process to exit. Resolves true if it exited within the timeout,
   * false otherwise (delegates to the shared zombie-aware liveness check).
   */
  private async waitForProcessExit (timeoutMs: number): Promise<boolean> {
    if (!this.pid) return true
    return sharedWaitForProcessExit(this.pid, timeoutMs)
  }

  /**
   * Clean up PID file if it exists
   */
  private async cleanupPidFile (): Promise<void> {
    const pidfilePath = this.pidFilePath || this.commandBuilder.getPidfilePath()
    if (!pidfilePath) {
      return
    }

    try {
      await fsPromises.unlink(pidfilePath)
      this.debug.log(`Cleaned up PID file: ${pidfilePath}`)
    } catch (error) {
      // File might not exist, that's okay
      this.debug.log('warn', `Failed to cleanup PID file: ${(error as Error).message}`)
    }
  }

  /**
   * Sleep utility
   */
  private sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // ===========================================================================
  // CPU Pinning Information
  // ===========================================================================

  /**
   * Check if CPU pinning was applied to this process
   */
  isCpuPinningApplied (): boolean {
    return this.cpuPinningApplied
  }

  /**
   * Get the CPU cores this process is pinned to
   */
  getPinnedCores (): number[] {
    return [...this.pinnedCores]
  }

  /**
   * Get the NUMA nodes used for memory binding
   */
  getNumaNodes (): number[] {
    return [...this.numaNodes]
  }
}
