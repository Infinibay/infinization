import * as fs from 'fs'
import { Debugger } from './debug'

const log = new Debugger('process-identity')

/**
 * Process-identity and lifecycle helpers shared by VMLifecycle, HealthMonitor
 * and EventHandler so that "is this PID really our VM?" and "is this PID alive?"
 * have ONE implementation with identical, fail-closed semantics everywhere.
 *
 * Why this matters: the backend runs as root and QEMU is `-daemonize`d (re-parented
 * to init). A PID read from a stale pidfile or DB row may have been recycled by the
 * kernel and now belong to an unrelated host process (a database, an SSH session).
 * Sending it SIGKILL would be catastrophic. Every destructive signal MUST be gated
 * by {@link pidBelongsToVM}.
 */

/**
 * Verifies that the live process at `pid` is actually a VM's QEMU process before
 * any destructive signal. Identification: the QEMU cmdline always contains
 * `qemu-system` plus a token unique to the VM (its internalName, embedded in the
 * -qmp socket path and -pidfile path).
 *
 * Linux-only (reads /proc). On other platforms /proc is unavailable, so we cannot
 * verify and conservatively return true to preserve behavior on dev machines.
 * Returns false (fail-closed) if the process is gone or could not be positively
 * identified — callers MUST treat false as "do not signal".
 */
export function pidBelongsToVM (pid: number, token: string): boolean {
  if (process.platform !== 'linux') {
    return true
  }
  if (!token) {
    log.warn(`pidBelongsToVM: empty identifying token for PID ${pid}, cannot verify ownership`)
    return false
  }
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`)
    // /proc/<pid>/cmdline is NUL-delimited; normalize to spaces for matching.
    const cmdline = raw.toString('utf8').replace(/\0/g, ' ')
    const looksLikeQemu = cmdline.includes('qemu-system')
    const matchesVM = cmdline.includes(token)
    if (!looksLikeQemu || !matchesVM) {
      log.warn(`pidBelongsToVM: PID ${pid} does not match this VM (qemu=${looksLikeQemu}, token='${token}' matched=${matchesVM}) - refusing to signal it`)
      return false
    }
    return true
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err && err.code === 'ENOENT') {
      log.info(`pidBelongsToVM: PID ${pid} has no /proc entry (already exited)`)
      return false
    }
    log.warn(`pidBelongsToVM: failed to read /proc/${pid}/cmdline: ${err?.message ?? String(error)} - refusing to signal PID ${pid}`)
    return false
  }
}

/**
 * Checks whether a process exists and is not a zombie.
 *
 * Uses kill(pid, 0) for existence, then reads /proc/<pid>/stat to reject zombies
 * (state 'Z' — exited but not yet reaped). EPERM means the process exists but we
 * cannot signal it, so it is alive. Any other unexpected error assumes alive to
 * avoid false-positive crash detection.
 */
export function isProcessAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)

    const statPath = `/proc/${pid}/stat`
    if (fs.existsSync(statPath)) {
      try {
        const stat = fs.readFileSync(statPath, 'utf8')
        // Format: "pid (comm) state ..." — comm may contain spaces/parens, so
        // locate the state char two positions after the last ')'.
        const closeParen = stat.lastIndexOf(')')
        if (closeParen > 0 && stat.length > closeParen + 2) {
          const state = stat.charAt(closeParen + 2)
          if (state === 'Z') {
            log.warn(`PID ${pid} is a zombie process - treating as dead`)
            return false
          }
        }
      } catch {
        log.warn(`Could not read /proc/${pid}/stat for zombie check on PID ${pid}`)
      }
    }
    return true
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    log.error(`Unexpected error checking PID ${pid}: ${error.code} - ${error.message}`)
    return true
  }
}

/**
 * Polls until the process exits or the timeout elapses.
 * @returns true if the process is confirmed gone, false if it is still alive.
 */
export async function waitForProcessExit (pid: number, timeoutMs: number, pollIntervalMs = 100): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    if (!isProcessAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return !isProcessAlive(pid)
}

export interface ForceKillResult {
  /** A signal was actually sent (identity verified). */
  signalled: boolean
  /** The process is confirmed gone after the escalation. */
  confirmedGone: boolean
  /** The kill was skipped because identity could not be verified (fail-closed). */
  skipped: boolean
}

/**
 * Identity-checked SIGTERM → SIGKILL escalation. Refuses to signal a PID that
 * cannot be positively identified as the VM's QEMU (PID-reuse guard). Returns a
 * structured result so callers can distinguish "killed", "skipped (not ours)"
 * and "still alive after SIGKILL" rather than assuming success.
 */
export async function forceKillProcess (
  pid: number,
  token: string,
  options: { gracePeriodMs?: number, killTimeoutMs?: number } = {}
): Promise<ForceKillResult> {
  const { gracePeriodMs = 5000, killTimeoutMs = 5000 } = options

  if (!pidBelongsToVM(pid, token)) {
    log.warn(`Skipping kill of PID ${pid}: not confirmed to be this VM's QEMU (token='${token}')`)
    return { signalled: false, confirmedGone: !isProcessAlive(pid), skipped: true }
  }

  // SIGTERM first, give it a grace period to flush and exit cleanly.
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { signalled: true, confirmedGone: true, skipped: false }
    log.error(`Failed to SIGTERM PID ${pid}: ${String(err)}`)
  }

  if (await waitForProcessExit(pid, gracePeriodMs)) {
    return { signalled: true, confirmedGone: true, skipped: false }
  }

  // Still alive — escalate to SIGKILL. Re-verify identity in case the original
  // process exited and the PID was recycled during the grace window.
  if (!pidBelongsToVM(pid, token)) {
    log.warn(`PID ${pid} no longer matches this VM after grace window — not escalating to SIGKILL`)
    return { signalled: true, confirmedGone: !isProcessAlive(pid), skipped: false }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { signalled: true, confirmedGone: true, skipped: false }
    log.error(`Failed to SIGKILL PID ${pid}: ${String(err)}`)
  }

  const confirmedGone = await waitForProcessExit(pid, killTimeoutMs)
  if (!confirmedGone) {
    log.error(`PID ${pid} (${token}) is STILL ALIVE after SIGKILL+${killTimeoutMs}ms — manual intervention required`)
  }
  return { signalled: true, confirmedGone, skipped: false }
}
