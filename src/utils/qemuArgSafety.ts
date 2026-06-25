/**
 * QEMU argument-safety helpers.
 *
 * QEMU parses most `-device`/`-drive`/`-spice`/`-name`/`-cpu` arguments as a
 * comma-delimited list of `key=value` sub-options. A value that contains a comma
 * or an equals sign therefore SPLICES new sub-options into the option string —
 * e.g. a per-disk cache of `none,readonly=on`, a SPICE password of
 * `secret,disable-ticketing=on`, or an ISO path of `/x.iso,readonly=off`. This is
 * not shell injection (no shell is involved), but it is a real argument-confusion
 * vector that can flip drive semantics (read-only/snapshot/unsafe-cache), make the
 * OVMF firmware writable, or disable console authentication.
 *
 * These helpers reject such values at the boundary (fail-closed) instead of
 * silently interpolating them. QEMU does support escaping a literal comma by
 * doubling it, but that is fragile across option types, so we reject outright.
 */

/** Thrown when a value cannot be safely placed into a QEMU option string. */
export class QemuArgValidationError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'QemuArgValidationError'
  }
}

// Comma and equals are QEMU sub-option separators. NUL and newlines are control
// characters that must never reach an argv element.
const OPTION_SEPARATORS = /[,=]/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

/**
 * Rejects any value that could splice extra QEMU sub-options (contains `,` or `=`)
 * or any control character. Use for names, models, passwords, enum-ish values, and
 * any free-form string interpolated into a comma-delimited option list.
 */
export function assertSafeOptionValue (value: string, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new QemuArgValidationError(`${fieldName} must be a string`)
  }
  if (OPTION_SEPARATORS.test(value)) {
    throw new QemuArgValidationError(`${fieldName} contains a QEMU option separator (',' or '='); refusing to interpolate '${value}'`)
  }
  if (CONTROL_CHARS.test(value)) {
    throw new QemuArgValidationError(`${fieldName} contains a control character; refusing to interpolate`)
  }
  return value
}

/**
 * Rejects a path that could splice extra sub-options into a comma-delimited option
 * (e.g. `file=<path>` in -drive). A comma is the dangerous separator; `=` is legal
 * in POSIX filenames so it is allowed, but control chars and commas are rejected.
 */
export function assertSafePath (value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new QemuArgValidationError(`${fieldName} must be a non-empty path`)
  }
  if (value.includes(',')) {
    throw new QemuArgValidationError(`${fieldName} contains a comma, which QEMU treats as an option separator; refusing to interpolate '${value}'`)
  }
  if (CONTROL_CHARS.test(value)) {
    throw new QemuArgValidationError(`${fieldName} contains a control character; refusing to interpolate`)
  }
  return value
}

/**
 * Asserts that `value` is a member of `allowed`. Use to whitelist per-disk
 * bus/cache/format and similar enum-like fields that must never be free-form.
 */
export function assertInEnum<T extends string> (value: T, allowed: readonly T[], fieldName: string): T {
  if (!allowed.includes(value)) {
    throw new QemuArgValidationError(`${fieldName} must be one of [${allowed.join(', ')}], got '${value}'`)
  }
  return value
}

/** Non-throwing variant of {@link assertSafeOptionValue}. */
export function isSafeOptionValue (value: string): boolean {
  return typeof value === 'string' && !OPTION_SEPARATORS.test(value) && !CONTROL_CHARS.test(value)
}

/** Redacts `password=...`/`passwd=...` sub-options from a string for logging. */
export function redactSecrets (text: string): string {
  return text.replace(/((?:^|[,\s])(?:password|passwd|secret)=)[^,\s]*/gi, '$1***')
}
