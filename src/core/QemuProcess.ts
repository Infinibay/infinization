import { ChildProcess, spawn } from 'child_process'
import { promises as fsPromises } from 'fs'
import { Debugger } from '../utils/debug'
import { QemuCommandBuilder } from './QemuCommandBuilder'

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
   */
  async start (): Promise<void> {
    const { command, args } = this.commandBuilder.buildCommand()
    const isDaemonized = this.commandBuilder.isDaemonizeEnabled()
    const pidfilePath = this.pidFilePath || this.commandBuilder.getPidfilePath()

    // Log command in a readable format
    this.debug.log(`Starting VM ${this.vmId}`)
    this.debug.log(`Command: ${command}`)
    this.debug.log(`Arguments (${args.length}):`)
    for (let i = 0; i < args.length; i += 2) {
      const arg = args[i]
      const value = args[i + 1]
      if (value && !value.startsWith('-')) {
        this.debug.log(`  ${arg} ${value}`)
      } else {
        this.debug.log(`  ${arg}`)
        if (value) i-- // Reprocess value as next arg
      }
    }
    this.debug.log(`Full command: ${command} ${args.join(' ')}`)

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

      this.process = spawn(command, args, {
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
        startCompleted = true

        // For daemonized processes with pidfile, read the actual daemon PID
        if (isDaemonized && pidfilePath) {
          try {
            await this.waitForPidFile(pidfilePath)
            const pidContent = await fsPromises.readFile(pidfilePath, 'utf-8')
            const daemonPid = parseInt(pidContent.trim(), 10)
            if (!isNaN(daemonPid)) {
              this.pid = daemonPid
              this.debug.log(`VM ${this.vmId} daemonized with PID ${this.pid}`)
            }
          } catch (error) {
            this.debug.log('warn', `Failed to read daemon PID from ${pidfilePath}: ${(error as Error).message}`)
          }
        }

        this.debug.log(`VM ${this.vmId} ready`)
        resolve()
      }

      const handleStartupError = (error: Error) => {
        if (startCompleted) return
        startCompleted = true
        reject(error)
      }

      // Wait for QMP socket if configured
      if (this.qmpSocketPath) {
        this.waitForQmpSocketWithEarlyExit(() => processExited, stderrBuffer)
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

          // Poll for process exit
          this.waitForProcessExit(timeoutMs)
            .then(async () => {
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
   * Force kill the QEMU process
   */
  async forceKill (): Promise<void> {
    if (!this.pid) {
      return
    }

    this.debug.log(`Force killing VM ${this.vmId} (PID ${this.pid})`)

    try {
      process.kill(this.pid, 'SIGKILL')
    } catch (error) {
      // Process might already be dead
      this.debug.log('warn', `Failed to kill process: ${(error as Error).message}`)
    }

    // Wait for process to actually exit
    await this.waitForProcessExit(5000)
    await this.cleanupPidFile()

    this.process = null
    this.pid = null
  }

  /**
   * Check if the process is alive
   */
  isAlive (): boolean {
    if (!this.pid) {
      return false
    }

    try {
      // Signal 0 doesn't kill, just checks if process exists
      process.kill(this.pid, 0)
      return true
    } catch {
      return false
    }
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
   * Wait for process to exit
   */
  private async waitForProcessExit (timeoutMs: number): Promise<void> {
    const startTime = Date.now()
    const pollInterval = 100

    while (Date.now() - startTime < timeoutMs) {
      if (!this.isAlive()) {
        return
      }
      await this.sleep(pollInterval)
    }
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
}
