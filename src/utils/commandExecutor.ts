import { spawn } from 'child_process'
import { Debugger } from './debug'

/**
 * CommandExecutor provides safe command execution using spawn.
 * It never uses shell concatenation and properly handles stdout/stderr.
 */
export class CommandExecutor {
  private debug: Debugger

  constructor () {
    this.debug = new Debugger('command-executor')
  }

  /**
   * Executes a command using spawn.
   * @param command - The command to execute
   * @param args - The arguments to pass to the command
   * @param options - Optional execution options.
   *   `stdin`: a string to write to the child's stdin (used for `nft -f -` to apply
   *   a whole ruleset atomically in a single transaction).
   * @returns A Promise that resolves with stdout on success or rejects with an error on failure
   */
  execute (command: string, args: string[], options: { stdin?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const fullCommand = `${command} ${args.join(' ')}`
      this.debug.log(`Executing: ${fullCommand}`)

      // Force the C locale so tool diagnostics (ip, nft, ethtool, ...) come back in
      // English. Several callers detect conditions like "Cannot find device" / "File
      // exists" by substring-matching stderr; under a translated locale those checks
      // would silently fail. LC_ALL=C makes that matching locale-independent.
      const childProcess = spawn(command, args, {
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
      })
      let stdout = ''
      let stderr = ''

      childProcess.stdout.on('data', (data) => {
        stdout += data
      })

      childProcess.stderr.on('data', (data) => {
        stderr += data
      })

      childProcess.on('close', (code) => {
        if (code === 0) {
          this.debug.log(`Command completed successfully: ${fullCommand}`)
          resolve(stdout)
        } else {
          const errorMsg = `Command failed with exit code ${code}: ${fullCommand}\nstdout: ${stdout}\nstderr: ${stderr}`
          this.debug.log('error', errorMsg)
          reject(new Error(errorMsg))
        }
      })

      childProcess.on('error', (error) => {
        const errorMsg = `Error occurred while executing command: ${fullCommand}: ${error.message}`
        this.debug.log('error', errorMsg)
        reject(new Error(errorMsg))
      })

      // Feed stdin when provided (e.g. a ruleset for `nft -f -`). Guard against
      // EPIPE if the child closes its stdin early.
      if (options.stdin !== undefined) {
        childProcess.stdin.on('error', () => { /* ignore broken pipe; close handler reports the real failure */ })
        childProcess.stdin.write(options.stdin)
        childProcess.stdin.end()
      }
    })
  }
}
