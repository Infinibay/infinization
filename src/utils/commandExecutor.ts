import { spawn } from 'child_process'
import { Debugger } from './debug'
import { redactSecrets } from './qemuArgSafety'

/** Default hard timeout. Bounds a hung child (e.g. nft blocked on a lock, a
 *  stalled qemu-img) to a finite wall-clock instead of pending forever while
 *  holding the caller's mutex. Long-running callers (large qemu-img convert,
 *  gzip of a multi-GB disk) should pass a larger `timeoutMs`, or 0 to disable. */
const DEFAULT_TIMEOUT_MS = 600_000 // 10 minutes
/** Cap on buffered stdout/stderr (each) so flooded output cannot OOM the host. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024 // 64 MB
/** How long to wait after SIGTERM before escalating to SIGKILL. */
const DEFAULT_KILL_GRACE_MS = 5_000
/** Bound on stdout/stderr embedded in an Error message (full text stays on the
 *  structured fields). Keeps secrets/large rulesets out of logs. */
const MSG_TAIL = 8 * 1024

export interface CommandOptions {
  /** A string written to the child's stdin (used for `nft -f -`). */
  stdin?: string
  /** Hard timeout in ms (SIGTERM then SIGKILL). 0 disables. Default 10 min. */
  timeoutMs?: number
  /** Max bytes buffered for stdout/stderr each; on exceed the child is killed. */
  maxBuffer?: number
  /** Grace period between SIGTERM and SIGKILL on timeout/overflow. */
  killGraceMs?: number
}

/**
 * Structured execution error. Carries the exit code/signal and the full
 * stdout/stderr so callers can classify failures on `code`/fields instead of
 * substring-matching a concatenated message string. The `message` itself only
 * embeds a bounded tail of the output.
 */
export class CommandExecutionError extends Error {
  constructor (
    message: string,
    public readonly code: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly timedOut: boolean
  ) {
    super(message)
    this.name = 'CommandExecutionError'
  }
}

function tail (s: string): string {
  return s.length > MSG_TAIL ? '...' + s.slice(-MSG_TAIL) : s
}

/**
 * CommandExecutor provides safe command execution using spawn — never shell
 * concatenation, and now with a hard timeout, an output cap, and structured
 * errors so a stuck or runaway child cannot hang the caller forever or OOM.
 */
export class CommandExecutor {
  private debug: Debugger

  constructor () {
    this.debug = new Debugger('command-executor')
  }

  execute (command: string, args: string[], options: CommandOptions = {}): Promise<string> {
    const {
      stdin,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxBuffer = DEFAULT_MAX_BUFFER,
      killGraceMs = DEFAULT_KILL_GRACE_MS
    } = options

    return new Promise((resolve, reject) => {
      // Redact secrets before this string ever reaches a log or an Error.
      const fullCommand = redactSecrets(`${command} ${args.join(' ')}`)
      this.debug.log(`Executing: ${fullCommand}`)

      // Force the C locale so tool diagnostics come back in English; several
      // call sites still match stderr substrings for known conditions.
      const child = spawn(command, args, {
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
      })

      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let timedOut = false
      let overflowed = false
      let hardTimer: NodeJS.Timeout | null = null
      let killTimer: NodeJS.Timeout | null = null

      const clearTimers = (): void => {
        if (hardTimer) { clearTimeout(hardTimer); hardTimer = null }
        if (killTimer) { clearTimeout(killTimer); killTimer = null }
      }

      // SIGTERM, then SIGKILL after a grace period if the child ignores it.
      const killChild = (): void => {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        if (!killTimer) {
          killTimer = setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* already gone */ }
          }, killGraceMs)
          // Do not let the kill timer keep the event loop alive on its own.
          killTimer.unref?.()
        }
      }

      if (timeoutMs > 0) {
        hardTimer = setTimeout(() => {
          timedOut = true
          this.debug.log('warn', `Command timed out after ${timeoutMs}ms, killing: ${fullCommand}`)
          killChild()
        }, timeoutMs)
        hardTimer.unref?.()
      }

      child.stdout.on('data', (data: Buffer) => {
        stdoutBytes += data.length
        if (stdoutBytes <= maxBuffer) {
          stdout += data
        } else if (!overflowed) {
          overflowed = true
          this.debug.log('warn', `Command stdout exceeded ${maxBuffer} bytes, killing: ${fullCommand}`)
          killChild()
        }
      })

      child.stderr.on('data', (data: Buffer) => {
        stderrBytes += data.length
        if (stderrBytes <= maxBuffer) {
          stderr += data
        } else if (!overflowed) {
          overflowed = true
          this.debug.log('warn', `Command stderr exceeded ${maxBuffer} bytes, killing: ${fullCommand}`)
          killChild()
        }
      })

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimers()
        fn()
      }

      child.on('close', (code, signal) => {
        settle(() => {
          if (timedOut) {
            reject(new CommandExecutionError(
              `Command timed out after ${timeoutMs}ms: ${fullCommand}\nstderr: ${tail(redactSecrets(stderr))}`,
              code, signal, stdout, stderr, true))
          } else if (overflowed) {
            reject(new CommandExecutionError(
              `Command output exceeded ${maxBuffer} bytes (killed): ${fullCommand}`,
              code, signal, stdout, stderr, false))
          } else if (code === 0) {
            this.debug.log(`Command completed successfully: ${fullCommand}`)
            resolve(stdout)
          } else {
            const errorMsg = `Command failed with exit code ${code}: ${fullCommand}\nstdout: ${tail(stdout)}\nstderr: ${tail(redactSecrets(stderr))}`
            this.debug.log('error', errorMsg)
            reject(new CommandExecutionError(errorMsg, code, signal, stdout, stderr, false))
          }
        })
      })

      child.on('error', (error) => {
        settle(() => {
          const errorMsg = `Error occurred while executing command: ${fullCommand}: ${error.message}`
          this.debug.log('error', errorMsg)
          reject(new CommandExecutionError(errorMsg, null, null, stdout, stderr, false))
        })
      })

      // Feed stdin when provided (e.g. a ruleset for `nft -f -`). Guard against
      // EPIPE if the child closes its stdin early.
      if (stdin !== undefined) {
        child.stdin.on('error', () => { /* ignore broken pipe; close handler reports the real failure */ })
        child.stdin.write(stdin)
        child.stdin.end()
      }
    })
  }
}
