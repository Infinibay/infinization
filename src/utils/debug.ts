import debug from 'debug'

/**
 * Severity levels, ordered most-severe first.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** Arbitrary structured context attached to a log entry (vmId, pid, ...). */
export interface LogContext { [key: string]: unknown }

/** A fully-structured log entry handed to an injected {@link LogSink}. */
export interface LogEntry {
  time: string
  level: LogLevel
  module: string
  message: string
  context?: LogContext
}

/** Sink the host application can install to capture every structured entry. */
export type LogSink = (entry: LogEntry) => void

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace']
const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 }

function isLevel (v: unknown): v is LogLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
}

function nowIso (): string {
  return new Date().toISOString()
}

function safeJson (value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

// ---------------------------------------------------------------------------
// Global, injectable logging policy.
//
// A privileged root-level VM manager must NEVER be silent on its failure paths.
// Historically the only diagnostic surface was the `debug` npm module, which is
// off unless DEBUG=infinization:* is set — so in production the library said
// nothing on a crash. We fix that here without touching the ~780 call sites:
//   * error/warn are always written to the console (regardless of DEBUG), and
//   * an injectable structured sink lets the host backend capture every entry
//     (level, module, message, context) and route it into its own logger.
// ---------------------------------------------------------------------------

let globalSink: LogSink | null = null
// Entries at or above this severity are written to the console unconditionally.
// Default = warn, so error+warn always surface even with DEBUG unset.
let consoleThreshold: number = RANK.warn

/** Install (or clear, with null) a structured sink that receives every entry. */
export function setLogSink (sink: LogSink | null): void {
  globalSink = sink
}

/** The currently-installed sink, if any. */
export function getLogSink (): LogSink | null {
  return globalSink
}

/**
 * Raise/lower the console threshold. e.g. setConsoleLogLevel('error') to quiet
 * warnings, or 'info' to surface info to the console too. error is always shown.
 */
export function setConsoleLogLevel (level: LogLevel): void {
  consoleThreshold = Math.max(RANK[level], RANK.error)
}

/**
 * Debugger is the module-scoped logger used throughout infinization.
 *
 * Backwards-compatible call shapes (all existing call sites keep working):
 *   debug.log('plain message')                 // debug level, default namespace
 *   debug.log('error', 'something failed')      // error level (now unconditional)
 *   debug.log('warn', 'careful', { vmId })      // optional structured context
 *
 * Plus typed convenience methods: debug.error/warn/info/debug(msg, context?).
 */
export class Debugger {
  private debuggers: { [key: string]: debug.Debugger } = {}

  constructor (private module: string) {
    this.debuggers.default = debug('infinization:' + module)
  }

  private ns (sub: string): debug.Debugger {
    if (!this.debuggers[sub]) {
      this.debuggers[sub] = debug(`infinization:${this.module}:${sub}`)
    }
    return this.debuggers[sub]
  }

  /**
   * Variadic logger. The first string argument, if it is a known level, sets the
   * severity; the remaining strings form the message; a single non-string
   * argument (if present) is captured as structured context. This preserves the
   * historical `log('error', msg)` / `log(msg)` shapes while no longer dropping a
   * trailing context object.
   */
  public log (...args: Array<string | LogContext | undefined>): void {
    const context = args.find(a => a !== undefined && typeof a !== 'string') as LogContext | undefined
    const strs = args.filter((a): a is string => typeof a === 'string')

    let level: LogLevel = 'debug'
    let parts = strs
    if (strs.length >= 1 && isLevel(strs[0]) && (strs.length >= 2 || context !== undefined)) {
      level = strs[0]
      parts = strs.slice(1)
    }
    this.emit(level, parts.join(' '), context)
  }

  public error (message: string, context?: LogContext): void { this.emit('error', message, context) }
  public warn (message: string, context?: LogContext): void { this.emit('warn', message, context) }
  public info (message: string, context?: LogContext): void { this.emit('info', message, context) }
  public debug (message: string, context?: LogContext): void { this.emit('debug', message, context) }

  private emit (level: LogLevel, message: string, context?: LogContext): void {
    // 1) Feed the `debug` namespace so DEBUG=infinization:* still works as before.
    const sub = level === 'debug' ? 'default' : level
    const dbg = sub === 'default' ? this.debuggers.default : this.ns(sub)
    dbg(context ? `${message} ${safeJson(context)}` : message)

    // 2) Hand the full structured entry to an injected sink, if any.
    if (globalSink) {
      try {
        globalSink({ time: nowIso(), level, module: this.module, message, context })
      } catch {
        /* a logging sink must never break the caller */
      }
    }

    // 3) Unconditionally surface severe entries to the console (DEBUG-independent).
    if (RANK[level] <= consoleThreshold) {
      const ctx = context ? ' ' + safeJson(context) : ''
      const line = `[${nowIso()}] ${level.toUpperCase()} infinization:${this.module} ${message}${ctx}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }
  }
}
