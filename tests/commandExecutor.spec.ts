import { CommandExecutor, CommandExecutionError } from '../src/utils/commandExecutor'

describe('CommandExecutor (hardened)', () => {
  const exec = new CommandExecutor()

  it('resolves stdout on success', async () => {
    const out = await exec.execute('printf', ['hello'])
    expect(out).toBe('hello')
  })

  it('rejects with a structured CommandExecutionError carrying code/stderr on failure', async () => {
    expect.assertions(3)
    try {
      // `false` exits non-zero with no output
      await exec.execute('sh', ['-c', 'echo oops 1>&2; exit 3'])
    } catch (err) {
      expect(err).toBeInstanceOf(CommandExecutionError)
      expect((err as CommandExecutionError).code).toBe(3)
      expect((err as CommandExecutionError).stderr).toContain('oops')
    }
  })

  it('TIMES OUT a hung child (SIGTERM->SIGKILL) instead of hanging forever', async () => {
    expect.assertions(2)
    const start = Date.now()
    try {
      // sleep far longer than the timeout; the executor must kill it
      await exec.execute('sleep', ['30'], { timeoutMs: 300, killGraceMs: 100 })
    } catch (err) {
      expect((err as CommandExecutionError).timedOut).toBe(true)
      // Should have returned well before the 30s sleep would have finished
      expect(Date.now() - start).toBeLessThan(5000)
    }
  })

  it('feeds stdin to the child', async () => {
    const out = await exec.execute('cat', [], { stdin: 'piped-input' })
    expect(out).toBe('piped-input')
  })

  it('kills a child that floods stdout past maxBuffer', async () => {
    expect.assertions(1)
    try {
      await exec.execute('sh', ['-c', 'yes AAAAAAAA'], { maxBuffer: 1024, timeoutMs: 5000 })
    } catch (err) {
      expect(err).toBeInstanceOf(CommandExecutionError)
    }
  })
})
