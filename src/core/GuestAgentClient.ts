import * as net from 'net'
import { Debugger } from '../utils/debug'
import { GuestExecResult, GuestExecStatusResult } from '../types/qmp.types'

/**
 * Pending command structure for tracking in-flight QGA commands.
 */
interface PendingCommand<T = unknown> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

interface QGAResponse {
  return?: unknown
  error?: { class: string, desc: string }
  id?: string
}

export interface GuestAgentClientOptions {
  connectTimeout?: number
  commandTimeout?: number
}

const DEFAULT_OPTIONS: Required<GuestAgentClientOptions> = {
  connectTimeout: 5000,
  commandTimeout: 30000
}

/**
 * Client for the QEMU Guest Agent (QGA).
 *
 * QGA shares the line-delimited JSON wire format with QMP, but its handshake
 * is fundamentally different:
 *
 *   - QGA sends NO greeting on connect.
 *   - QGA does NOT accept `qmp_capabilities`.
 *   - Commands like `guest-exec`, `guest-exec-status`, `guest-ping`, `guest-info`
 *     are only valid on the QGA socket, never on the QMP socket.
 *
 * Use this client when talking to `guestAgentSocketPath`. Use `QMPClient` for
 * `qmpSocketPath`.
 */
export class GuestAgentClient {
  /** Max time to wait for a graceful socket close before forcing teardown. */
  private static readonly DISCONNECT_TIMEOUT_MS = 3000
  private socket: net.Socket | null = null
  private connected = false
  private socketPath: string
  private options: Required<GuestAgentClientOptions>
  private commandId = 0
  private pendingCommands: Map<string, PendingCommand> = new Map()
  private buffer = ''
  private debug: Debugger

  constructor (socketPath: string, options?: GuestAgentClientOptions) {
    this.socketPath = socketPath
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.debug = new Debugger('qga-client')
  }

  public async connect (): Promise<void> {
    if (this.connected) return

    this.debug.log(`Connecting to QGA socket ${this.socketPath}`)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanup()
        reject(new Error(`QGA connection timeout after ${this.options.connectTimeout}ms`))
      }, this.options.connectTimeout)

      const sock = net.createConnection(this.socketPath)
      this.socket = sock

      sock.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout)
        this.cleanup()
        reject(new Error(`QGA socket error: ${err.message}`))
      })

      sock.once('connect', () => {
        clearTimeout(timeout)
        this.connected = true
        this.debug.log('QGA socket connected')
        resolve()
      })

      sock.on('data', (data: Buffer) => this.handleData(data))
      sock.on('close', () => this.handleDisconnect())
    })
  }

  public async disconnect (): Promise<void> {
    if (!this.socket) return

    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('QGA client disconnected'))
      this.pendingCommands.delete(id)
    }

    return new Promise((resolve) => {
      if (!this.socket) {
        resolve()
        return
      }
      // Bound the wait: if the remote never sends 'close' (hung guest), force a
      // local teardown after a short timeout so disconnect() always settles and
      // cannot hang the facade's finally block indefinitely.
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.cleanup()
        resolve()
      }
      const timer = setTimeout(finish, GuestAgentClient.DISCONNECT_TIMEOUT_MS)
      timer.unref?.()
      this.socket.once('close', finish)
      this.socket.end()
    })
  }

  public isConnected (): boolean {
    return this.connected
  }

  public async execute<T = unknown> (
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to QGA socket')
    }

    const id = String(++this.commandId)
    const message: { execute: string, id: string, arguments?: Record<string, unknown> } = {
      execute: command,
      id
    }
    if (args && Object.keys(args).length > 0) {
      message.arguments = args
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id)
        reject(new Error(`QGA command '${command}' timed out after ${this.options.commandTimeout}ms`))
      }, this.options.commandTimeout)

      this.pendingCommands.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout
      })

      const json = JSON.stringify(message) + '\n'
      this.socket!.write(json)
    })
  }

  /**
   * Execute a command inside the guest VM via QEMU Guest Agent (guest-exec).
   *
   * Spawns a process inside the guest, polls `guest-exec-status` until it exits,
   * and returns the decoded stdout/stderr and exit code.
   *
   * If the polling deadline expires the method throws, but a final
   * `guest-exec-status` is attempted in `finally` so QGA can reap the entry.
   */
  public async guestExec (
    command: string,
    args?: string[],
    options?: { timeout?: number, cwd?: string }
  ): Promise<{ stdout: string, stderr: string, exitCode: number }> {
    const execArgs: Record<string, unknown> = {
      path: command,
      'capture-output': true
    }
    if (args && args.length > 0) {
      execArgs.arg = args
    }
    // NOTE: the QEMU Guest Agent `guest-exec` schema has no `cwd` parameter —
    // passing one makes QGA reject the whole command. Working directory is not
    // supported here; callers must use absolute paths. `options.cwd` is ignored.

    const result = await this.execute<GuestExecResult>('guest-exec', execArgs)

    if (!result || result.pid == null || result.pid === -1) {
      throw new Error('Guest agent returned no pid (guest-exec not supported?)')
    }

    const pid = result.pid
    const timeout = options?.timeout ?? this.options.commandTimeout
    const deadline = Date.now() + timeout
    const pollInterval = 200

    try {
      while (Date.now() < deadline) {
        const status = await this.execute<GuestExecStatusResult>('guest-exec-status', { pid })

        if (status.exited) {
          const decode = (b64: string | null | undefined): string =>
            b64 ? Buffer.from(b64, 'base64').toString('utf-8') : ''

          return {
            stdout: decode(status['out-data']),
            stderr: decode(status['err-data']),
            exitCode: status.exitcode ?? -1
          }
        }

        await new Promise<void>(resolve => setTimeout(resolve, pollInterval))
      }

      throw new Error(
        `guest-exec timed out for command "${command}" (pid ${pid}) after ${timeout}ms`
      )
    } finally {
      // Best-effort: drain the pid one last time so QGA can reap the entry.
      // Swallow any error since we may already be throwing the timeout above.
      try {
        await this.execute<GuestExecStatusResult>('guest-exec-status', { pid })
      } catch {
        /* ignore */
      }
    }
  }

  private handleData (data: Buffer): void {
    this.buffer += data.toString('utf-8')

    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.length === 0) continue

      try {
        const message = JSON.parse(line) as QGAResponse
        this.handleResponse(message)
      } catch (err) {
        this.debug.log('error', `Failed to parse QGA JSON: ${line}`)
      }
    }
  }

  private handleResponse (response: QGAResponse): void {
    const id = response.id
    if (!id) {
      this.debug.log('error', 'QGA response without id')
      return
    }
    const pending = this.pendingCommands.get(id)
    if (!pending) {
      this.debug.log('error', `No pending QGA command for id: ${id}`)
      return
    }

    clearTimeout(pending.timeout)
    this.pendingCommands.delete(id)

    if (response.error) {
      pending.reject(new Error(`QGA error: ${response.error.desc} (${response.error.class})`))
    } else {
      pending.resolve(response.return)
    }
  }

  private handleDisconnect (): void {
    this.connected = false
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('QGA connection closed'))
      this.pendingCommands.delete(id)
    }
  }

  private cleanup (): void {
    this.connected = false
    this.buffer = ''
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
  }
}
