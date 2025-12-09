import { Debugger } from './debug'

/**
 * Options for retry operations
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Initial delay in milliseconds (default: 100) */
  initialDelayMs?: number
  /** Backoff factor for exponential delay (default: 2) */
  backoffFactor?: number
  /** Maximum delay in milliseconds (default: 5000) */
  maxDelayMs?: number
  /** Debug namespace for logging (optional) */
  debugNamespace?: string
}

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  success: boolean
  result?: T
  error?: Error
  attempts: number
}

/**
 * Executes an async function with exponential backoff retries.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function if successful
 * @throws The last error if all retries fail
 *
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   async () => await executeCommand(),
 *   { maxRetries: 3, initialDelayMs: 100 }
 * )
 * ```
 */
export async function retryWithBackoff<T> (
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    backoffFactor = 2,
    maxDelayMs = 5000,
    debugNamespace
  } = options

  const debug = debugNamespace ? new Debugger(debugNamespace) : null
  let lastError: Error | undefined
  let delay = initialDelayMs

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn()
      if (attempt > 1 && debug) {
        debug.log(`Operation succeeded on attempt ${attempt}`)
      }
      return result
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < maxRetries) {
        if (debug) {
          debug.log(`Attempt ${attempt}/${maxRetries} failed: ${lastError.message}. Retrying in ${delay}ms...`)
        }
        await sleep(delay)
        delay = Math.min(delay * backoffFactor, maxDelayMs)
      } else if (debug) {
        debug.log('error', `All ${maxRetries} attempts failed. Last error: ${lastError.message}`)
      }
    }
  }

  throw lastError
}

/**
 * Executes an async function with retries specifically for "Device or resource busy" errors.
 * Uses longer initial delays appropriate for kernel resource release.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options (defaults optimized for busy resources)
 * @returns The result of the function if successful
 * @throws The last error if all retries fail, or immediately if error is not a busy error
 *
 * @example
 * ```typescript
 * await retryOnBusy(
 *   async () => await tapManager.destroy(tapName),
 *   { debugNamespace: 'tap-device' }
 * )
 * ```
 */
export async function retryOnBusy<T> (
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 500, // Longer initial delay for busy resources
    backoffFactor = 2,
    maxDelayMs = 5000,
    debugNamespace
  } = options

  const debug = debugNamespace ? new Debugger(debugNamespace) : null
  let lastError: Error | undefined
  let delay = initialDelayMs

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn()
      if (attempt > 1 && debug) {
        debug.log(`Operation succeeded on attempt ${attempt} after resource became available`)
      }
      return result
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const errorMessage = lastError.message.toLowerCase()

      // Only retry on "busy" type errors
      const isBusyError = errorMessage.includes('device or resource busy') ||
                          errorMessage.includes('resource temporarily unavailable') ||
                          errorMessage.includes('resource busy')

      if (!isBusyError) {
        // Not a busy error, throw immediately
        throw lastError
      }

      if (attempt < maxRetries) {
        if (debug) {
          debug.log(`Resource busy on attempt ${attempt}/${maxRetries}. Waiting ${delay}ms for resource release...`)
        }
        await sleep(delay)
        delay = Math.min(delay * backoffFactor, maxDelayMs)
      } else if (debug) {
        debug.log('error', `Resource remained busy after ${maxRetries} attempts. Last error: ${lastError.message}`)
      }
    }
  }

  throw lastError
}

/**
 * Sleep utility function
 */
function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Exported sleep for use in other modules
 */
export { sleep }
