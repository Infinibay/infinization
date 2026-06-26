/**
 * GuestAgentClient defect tests:
 *  (a) guestExec/guestExecRaw must NOT corrupt binary guest output.
 *  (b) execute() must clear the pending entry + timer if socket.write throws
 *      synchronously (no leaked 30s timer, immediate reject).
 */
import { GuestAgentClient } from '../src/core/GuestAgentClient'

/** A fake net.Socket the client can write to and we can feed responses into. */
class FakeSocket {
  public written: string[] = []
  public throwOnWrite: Error | null = null
  private dataCb: ((b: Buffer) => void) | null = null
  /** Auto-responder: maps an outgoing `execute` command name -> response builder. */
  public onWrite: ((msg: { execute: string, id: string, arguments?: any }) => void) | null = null
  on (event: string, cb: any): this { if (event === 'data') this.dataCb = cb; return this }
  once (): this { return this }
  removeAllListeners (): this { return this }
  destroy (): void {}
  end (): void {}
  write (json: string): void {
    if (this.throwOnWrite) throw this.throwOnWrite
    this.written.push(json)
    if (this.onWrite) {
      const msg = JSON.parse(json.trim())
      // respond on a microtask so the client has registered its pending entry
      Promise.resolve().then(() => this.onWrite && this.onWrite(msg))
    }
  }
  /** Push a wire-format response line as if it arrived from the guest. */
  feed (obj: unknown): void {
    if (this.dataCb) this.dataCb(Buffer.from(JSON.stringify(obj) + '\n', 'utf-8'))
  }
}

/** Wires a connected client around a FakeSocket without opening a real socket. */
function connectedClient (): { client: GuestAgentClient, sock: FakeSocket } {
  const client = new GuestAgentClient('/tmp/does-not-matter.sock')
  const sock = new FakeSocket()
  ;(client as any).socket = sock
  ;(client as any).connected = true
  // register the data handler the same way connect() would
  sock.on('data', (b: Buffer) => (client as any).handleData(b))
  return { client, sock }
}

describe('GuestAgentClient — binary-safe guest output', () => {
  it('guestExecRaw returns exact bytes (no UTF-8 mangling)', async () => {
    const { client, sock } = connectedClient()
    // bytes that are NOT valid UTF-8 (0xFF 0xFE 0x00 0x80) — toString('utf-8')
    // would replace these with U+FFFD and lose them.
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41])
    const b64 = raw.toString('base64')

    sock.onWrite = (msg) => {
      if (msg.execute === 'guest-exec') {
        sock.feed({ id: msg.id, return: { pid: 7, executed: true } })
      } else if (msg.execute === 'guest-exec-status') {
        sock.feed({ id: msg.id, return: { exited: true, exitcode: 0, 'out-data': b64, 'err-data': null } })
      }
    }
    const res = await client.guestExecRaw('/bin/cat', ['x'])

    expect(Buffer.compare(res.stdout, raw)).toBe(0)
    expect(res.exitCode).toBe(0)
  })

  it('guestExec string decode is lossless for bytes (latin1) — round-trips back to the same buffer', async () => {
    const { client, sock } = connectedClient()
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41])
    const b64 = raw.toString('base64')

    sock.onWrite = (msg) => {
      if (msg.execute === 'guest-exec') {
        sock.feed({ id: msg.id, return: { pid: 9, executed: true } })
      } else if (msg.execute === 'guest-exec-status') {
        sock.feed({ id: msg.id, return: { exited: true, exitcode: 0, 'out-data': b64, 'err-data': null } })
      }
    }
    const res = await client.guestExec('/bin/cat', ['x'])

    // latin1 string -> buffer must reproduce the original bytes exactly.
    expect(Buffer.compare(Buffer.from(res.stdout, 'latin1'), raw)).toBe(0)
  })
})

describe('GuestAgentClient — execute() write failure handling', () => {
  it('rejects immediately and leaves no pending command when socket.write throws', async () => {
    const { client, sock } = connectedClient()
    sock.throwOnWrite = new Error('EPIPE: broken pipe')

    await expect(client.execute('guest-ping')).rejects.toThrow(/EPIPE/)
    // no leaked pending entry (would otherwise fire a 30s timer with no owner)
    expect((client as any).pendingCommands.size).toBe(0)
  })
})
