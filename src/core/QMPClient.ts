import { EventEmitter } from 'events'
import * as net from 'net'
import { Debugger } from '../utils/debug'
import {
  QMPGreeting,
  QMPMessage,
  QMPResponse,
  QMPEvent,
  QMPEventType,
  QMPClientOptions,
  QMPStatusInfo,
  QMPCpuInfo,
  QMPBlockInfo,
  QMPBalloonInfo
} from '../types/qmp.types'

/**
 * Default configuration values for QMPClient
 */
const DEFAULT_OPTIONS: Required<QMPClientOptions> = {
  connectTimeout: 5000,
  commandTimeout: 30000,
  reconnect: false,
  reconnectDelay: 1000,
  maxReconnectAttempts: 3
}

/**
 * Pending command structure for tracking in-flight commands
 */
interface PendingCommand<T = unknown> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

/**
 * QMPClient provides communication with QEMU via the QMP (QEMU Machine Protocol).
 *
 * QMP is a JSON-based protocol that allows clients to control and monitor QEMU
 * instances over Unix sockets. This client handles:
 * - Connection management with automatic handshake
 * - Command execution with response parsing
 * - Event subscription for VM state changes
 *
 * @example
 * ```typescript
 * const client = new QMPClient('/var/run/qemu/vm1.sock')
 * await client.connect()
 *
 * const status = await client.queryStatus()
 * console.log('VM status:', status.status)
 *
 * client.on('SHUTDOWN', (data) => {
 *   console.log('VM shutdown:', data)
 * })
 *
 * await client.powerdown()
 * await client.disconnect()
 * ```
 */
export class QMPClient extends EventEmitter {
  private socket: net.Socket | null = null
  private connected: boolean = false
  private socketPath: string
  private options: Required<QMPClientOptions>
  private commandId: number = 0
  private pendingCommands: Map<string, PendingCommand> = new Map()
  private debug: Debugger
  private buffer: string = ''
  private greeting: QMPGreeting | null = null
  private reconnectAttempts: number = 0

  /**
   * Creates a new QMPClient instance
   * @param socketPath Path to the QMP Unix socket
   * @param options Optional configuration options
   */
  constructor (socketPath: string, options?: QMPClientOptions) {
    super()
    this.socketPath = socketPath
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.debug = new Debugger('qmp-client')
  }

  /**
   * Connects to the QMP socket and performs the protocol handshake
   * @returns Promise that resolves when connected and ready
   * @throws Error if connection fails or times out
   */
  public async connect (): Promise<void> {
    if (this.connected) {
      this.debug.log('Already connected')
      return
    }

    this.debug.log(`Connecting to ${this.socketPath}`)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanup()
        reject(new Error(`Connection timeout after ${this.options.connectTimeout}ms`))
      }, this.options.connectTimeout)

      this.socket = net.createConnection(this.socketPath)

      this.socket.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout)
        this.cleanup()
        const message = this.getErrorMessage(err)
        this.debug.log('error', message)
        reject(new Error(message))
      })

      this.socket.once('connect', () => {
        this.debug.log('Socket connected, waiting for greeting')
      })

      // Handle incoming data
      this.socket.on('data', (data: Buffer) => {
        this.handleData(data)
      })

      // Handle socket close
      this.socket.on('close', () => {
        this.handleDisconnect()
      })

      // Wait for greeting and perform handshake
      this.once('_greeting', async () => {
        clearTimeout(timeout)
        try {
          await this.performHandshake()
          this.connected = true
          this.reconnectAttempts = 0
          this.debug.log('Connected and ready')
          resolve()
        } catch (err) {
          this.cleanup()
          reject(err)
        }
      })
    })
  }

  /**
   * Disconnects from the QMP socket gracefully
   */
  public async disconnect (): Promise<void> {
    if (!this.socket) {
      return
    }

    this.debug.log('Disconnecting')

    // Reject all pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Client disconnected'))
      this.pendingCommands.delete(id)
    }

    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.once('close', () => {
          this.cleanup()
          resolve()
        })
        this.socket.end()
      } else {
        resolve()
      }
    })
  }

  /**
   * Returns whether the client is currently connected
   */
  public isConnected (): boolean {
    return this.connected
  }

  /**
   * Returns the QMP greeting received from the server
   */
  public getGreeting (): QMPGreeting | null {
    return this.greeting
  }

  /**
   * Executes a QMP command and returns the response
   * @param command The QMP command name
   * @param args Optional command arguments
   * @returns Promise that resolves with the command response
   * @throws Error if command fails or times out
   */
  public async execute<T = unknown> (command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to QMP socket')
    }

    const id = String(++this.commandId)
    const message: QMPMessage = {
      execute: command,
      id
    }

    if (args && Object.keys(args).length > 0) {
      message.arguments = args
    }

    this.debug.log(`Executing command: ${command} (id: ${id})`)

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id)
        const error = new Error(`Command '${command}' timed out after ${this.options.commandTimeout}ms`)
        this.debug.log('error', error.message)
        reject(error)
      }, this.options.commandTimeout)

      this.pendingCommands.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout
      })

      this.sendCommand(message)
    })
  }

  // ===========================================================================
  // Essential Command Helpers
  // ===========================================================================

  /**
   * Queries the current VM status
   * @returns Promise with VM status information
   */
  public async queryStatus (): Promise<QMPStatusInfo> {
    return this.execute<QMPStatusInfo>('query-status')
  }

  /**
   * Sends a powerdown request to the guest OS
   * This triggers a clean shutdown through ACPI
   */
  public async powerdown (): Promise<void> {
    await this.execute('system_powerdown')
  }

  /**
   * Resets the VM (equivalent to pressing reset button)
   */
  public async reset (): Promise<void> {
    await this.execute('system_reset')
  }

  /**
   * Pauses VM execution
   */
  public async stop (): Promise<void> {
    await this.execute('stop')
  }

  /**
   * Resumes VM execution after being paused
   */
  public async cont (): Promise<void> {
    await this.execute('cont')
  }

  /**
   * Terminates the QEMU process immediately
   */
  public async quit (): Promise<void> {
    await this.execute('quit')
  }

  /**
   * Ejects media from a removable device
   * @param device The device name to eject
   * @param force Whether to force ejection even if locked
   */
  public async eject (device: string, force?: boolean): Promise<void> {
    const args: Record<string, unknown> = { device }
    if (force !== undefined) {
      args.force = force
    }
    await this.execute('eject', args)
  }

  /**
   * Queries CPU information
   * @returns Promise with array of CPU info
   */
  public async queryCpus (): Promise<QMPCpuInfo[]> {
    return this.execute<QMPCpuInfo[]>('query-cpus-fast')
  }

  /**
   * Queries block device information
   * @returns Promise with array of block device info
   */
  public async queryBlock (): Promise<QMPBlockInfo[]> {
    return this.execute<QMPBlockInfo[]>('query-block')
  }

  /**
   * Request the guest to adjust its memory to the specified size.
   *
   * The balloon driver in the guest will inflate or deflate to reach the target size.
   * This operation is asynchronous - the actual memory change happens over time
   * as the guest OS cooperates with the balloon driver.
   *
   * @param value - Target memory size in bytes
   * @throws Error if balloon device is not enabled or guest doesn't have balloon driver
   *
   * @remarks
   * - Guest must have virtio-balloon driver installed
   * - Use `queryBalloon()` to verify the current balloon size
   * - The guest may not honor the request if it needs the memory
   *
   * @example
   * ```typescript
   * // Request guest to use 2GB of memory
   * await client.balloon(2 * 1024 * 1024 * 1024)
   *
   * // Verify the change took effect
   * const info = await client.queryBalloon()
   * console.log('Current memory:', info.actual / (1024 ** 3), 'GB')
   * ```
   */
  public async balloon (value: number): Promise<void> {
    await this.execute('balloon', { value })
  }

  /**
   * Query the current balloon device memory allocation.
   *
   * Returns the current memory size as reported by the balloon device.
   * This reflects the actual memory currently allocated to the VM.
   *
   * @returns Promise with balloon info containing current memory in bytes
   * @throws Error if balloon device is not enabled in the VM
   *
   * @example
   * ```typescript
   * const info = await client.queryBalloon()
   * console.log('Current balloon size:', info.actual / (1024 ** 3), 'GB')
   * ```
   */
  public async queryBalloon (): Promise<QMPBalloonInfo> {
    return this.execute<QMPBalloonInfo>('query-balloon')
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Handles incoming data from the socket
   */
  private handleData (data: Buffer): void {
    this.buffer += data.toString('utf-8')

    // QMP uses line-delimited JSON
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)

      if (line.length === 0) {
        continue
      }

      try {
        const message = JSON.parse(line)
        this.processMessage(message)
      } catch (err) {
        this.debug.log('error', `Failed to parse JSON: ${line}`)
      }
    }
  }

  /**
   * Processes a parsed QMP message
   */
  private processMessage (message: Record<string, unknown>): void {
    // Check if it's a greeting
    if ('QMP' in message) {
      this.handleGreeting(message as QMPGreeting)
      return
    }

    // Check if it's an event
    if ('event' in message) {
      this.handleEvent(message as QMPEvent)
      return
    }

    // Check if it's a response (has return or error)
    if ('return' in message || 'error' in message) {
      this.handleResponse(message as QMPResponse)
      return
    }

    this.debug.log('error', `Unknown message type: ${JSON.stringify(message)}`)
  }

  /**
   * Handles the QMP greeting message
   */
  private handleGreeting (greeting: QMPGreeting): void {
    this.greeting = greeting
    const version = greeting.QMP.version.qemu
    this.debug.log(`Received greeting: QEMU ${version.major}.${version.minor}.${version.micro}`)
    this.emit('_greeting', greeting)
  }

  /**
   * Performs the QMP handshake by sending qmp_capabilities
   */
  private async performHandshake (): Promise<void> {
    this.debug.log('Performing handshake')

    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null

      // Define handshake handler in outer scope so timeout can access it
      const handshakeHandler = (response: QMPResponse) => {
        if (response.id !== '_handshake') {
          return
        }

        // Clean up listener and timeout
        this.off('_response', handshakeHandler)
        if (timeoutHandle) {
          clearTimeout(timeoutHandle)
          timeoutHandle = null
        }

        if (response.error) {
          this.cleanup()
          reject(new Error(`Handshake failed: ${response.error.desc}`))
        } else {
          this.debug.log('Handshake completed')
          resolve()
        }
      }

      timeoutHandle = setTimeout(() => {
        // Clean up listener and reset state on timeout
        this.off('_response', handshakeHandler)
        timeoutHandle = null
        this.cleanup()
        reject(new Error('Handshake timeout'))
      }, this.options.connectTimeout)

      const message: QMPMessage = {
        execute: 'qmp_capabilities',
        id: '_handshake'
      }

      this.on('_response', handshakeHandler)
      this.sendCommand(message)
    })
  }

  /**
   * Sends a command message to the socket
   */
  private sendCommand (message: QMPMessage): void {
    if (!this.socket) {
      throw new Error('Socket not connected')
    }

    const json = JSON.stringify(message) + '\n'
    this.socket.write(json)
    this.debug.log(`Sent: ${message.execute}`)
  }

  /**
   * Handles a command response message
   */
  private handleResponse (response: QMPResponse): void {
    // Emit for handshake handling
    this.emit('_response', response)

    const id = response.id
    if (!id) {
      this.debug.log('error', 'Received response without id')
      return
    }

    const pending = this.pendingCommands.get(id)
    if (!pending) {
      this.debug.log('error', `No pending command for id: ${id}`)
      return
    }

    clearTimeout(pending.timeout)
    this.pendingCommands.delete(id)

    if (response.error) {
      const error = new Error(`QMP error: ${response.error.desc} (${response.error.class})`)
      this.debug.log('error', error.message)
      pending.reject(error)
    } else {
      this.debug.log(`Command ${id} completed`)
      pending.resolve(response.return)
    }
  }

  /**
   * Handles a QMP event message
   */
  private handleEvent (event: QMPEvent): void {
    const eventName = event.event as QMPEventType
    this.debug.log(`Event: ${eventName}`)
    this.emit(eventName, event.data, event.timestamp)
    this.emit('event', event)
  }

  /**
   * Handles socket disconnection
   */
  private handleDisconnect (): void {
    const wasConnected = this.connected
    this.connected = false
    this.debug.log('Disconnected')

    // Reject all pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Connection closed'))
      this.pendingCommands.delete(id)
    }

    if (wasConnected) {
      this.emit('disconnect')

      // Attempt reconnection if enabled
      if (this.options.reconnect && this.reconnectAttempts < this.options.maxReconnectAttempts) {
        this.attemptReconnect()
      }
    }
  }

  /**
   * Attempts to reconnect to the QMP socket
   */
  private attemptReconnect (): void {
    this.reconnectAttempts++
    this.debug.log(`Reconnection attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts}`)

    setTimeout(async () => {
      try {
        await this.connect()
        this.emit('reconnect')
      } catch (err) {
        if (this.reconnectAttempts < this.options.maxReconnectAttempts) {
          this.attemptReconnect()
        } else {
          this.debug.log('error', 'Max reconnection attempts reached')
          this.emit('reconnect_failed')
        }
      }
    }, this.options.reconnectDelay)
  }

  /**
   * Cleans up socket and state
   */
  private cleanup (): void {
    this.connected = false
    this.buffer = ''
    this.greeting = null

    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
  }

  /**
   * Converts socket errors to user-friendly messages
   */
  private getErrorMessage (err: NodeJS.ErrnoException): string {
    switch (err.code) {
      case 'ECONNREFUSED':
        return `Connection refused: QMP socket at ${this.socketPath} is not accepting connections`
      case 'ENOENT':
        return `Socket not found: ${this.socketPath} does not exist`
      case 'EACCES':
        return `Permission denied: Cannot access ${this.socketPath}`
      case 'ETIMEDOUT':
        return `Connection timed out: ${this.socketPath}`
      default:
        return `Socket error: ${err.message}`
    }
  }
}
