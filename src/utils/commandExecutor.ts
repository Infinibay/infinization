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
   * @returns A Promise that resolves with stdout on success or rejects with an error on failure
   */
  execute (command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const fullCommand = `${command} ${args.join(' ')}`
      this.debug.log(`Executing: ${fullCommand}`)

      const childProcess = spawn(command, args)
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
    })
  }
}
