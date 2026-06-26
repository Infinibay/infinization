/**
 * nft existence-probe LOG HYGIENE regression (boot-noise fix).
 *
 * On a cold start NftablesService.initialize() probes for its table/chain BEFORE
 * creating them (createTableIfNotExists / chainExists / addDHCPAllowRules). nft exits
 * non-zero with "No such file or directory" — a benign EXPECTED absence that used to be
 * logged at ERROR twice (CommandExecutor's own log + NftablesService.exec's wrapper),
 * spamming every cold boot. The fix routes these through a quiet, CLASSIFYING probe
 * (execProbe + isMissingObjectError):
 *   - an ENOENT absence is logged at DEBUG and reported as "absent" (control flow
 *     unchanged: create / skip / '' exactly as before), while
 *   - any REAL fault (permission denied, syntax error, ...) is STILL logged at ERROR.
 *
 * These tests assert the SECOND emitter (NftablesService-level) via a mocked executor.
 * The FIRST emitter (CommandExecutor's own non-zero-exit log demotion via the new
 * `expectNonZeroExit` flag) is proven against a real spawn in commandExecutor.spec.ts.
 */
import { setLogSink, LogEntry } from '../src/utils/debug'

const execMock = jest.fn()
jest.mock('@utils/commandExecutor', () => {
  const actual = jest.requireActual('@utils/commandExecutor')
  // Preserve CommandExecutionError (used to build realistic rejections) while replacing
  // only the CommandExecutor class with one whose execute() is our mock.
  return { ...actual, CommandExecutor: jest.fn().mockImplementation(() => ({ execute: execMock })) }
})

import { CommandExecutionError } from '../src/utils/commandExecutor'
import { NftablesService } from '../src/network/NftablesService'

// nft's "object does not exist" negative: non-zero exit, "No such file or directory" on
// stderr (English guaranteed — the executor forces LC_ALL=C).
const enoent = (): CommandExecutionError =>
  new CommandExecutionError(
    'Command failed with exit code 1: nft list chain bridge infinization forward\nstderr: Error: No such file or directory',
    1, null, '', 'Error: No such file or directory', false
  )
// A genuinely REAL fault that must stay loud (privilege drop, wrong netns, ...).
const denied = (): CommandExecutionError =>
  new CommandExecutionError(
    'Command failed with exit code 1: nft list chain bridge infinization forward\nstderr: Error: Operation not permitted',
    1, null, '', 'Error: Operation not permitted', false
  )

describe('nft existence-probe log hygiene', () => {
  let entries: LogEntry[]
  beforeEach(() => {
    entries = []
    setLogSink(e => entries.push(e))
    execMock.mockReset()
  })
  afterEach(() => setLogSink(null))

  const errorEntries = (): LogEntry[] => entries.filter(e => e.level === 'error')

  it('EXPECTED absence (ENOENT) is QUIET: chainExists → false, zero ERROR, debug "object absent"', async () => {
    execMock.mockRejectedValue(enoent())
    const svc = new NftablesService({ enablePersistence: false })

    expect(await svc.chainExists('forward')).toBe(false)
    expect(errorEntries()).toHaveLength(0)
    expect(entries.some(e => e.level === 'debug' && /object absent/.test(e.message))).toBe(true)
  })

  it('REAL fault (permission denied) STILL logs ERROR — and control flow is unchanged', async () => {
    execMock.mockRejectedValue(denied())
    const svc = new NftablesService({ enablePersistence: false })

    // Behavior preserved: a real fault still surfaces as "chain does not exist" (false),
    // exactly like the old try/catch — the authoritative failure is the follow-on add.
    expect(await svc.chainExists('forward')).toBe(false)
    expect(entries.some(e => e.level === 'error' && /existence probe failed/.test(e.message))).toBe(true)
  })

  it('present chain → chainExists returns true and stays quiet', async () => {
    execMock.mockResolvedValue('table bridge infinization {\n\tchain forward {\n\t}\n}')
    const svc = new NftablesService({ enablePersistence: false })

    expect(await svc.chainExists('forward')).toBe(true)
    expect(errorEntries()).toHaveLength(0)
  })

  it('addDHCPAllowRules with the chain ABSENT inserts the rules with NO ERROR noise', async () => {
    const calls: string[][] = []
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'list') throw enoent() // forward chain not created yet on cold boot
      return '' // insert rule succeeds
    })
    const svc = new NftablesService({ enablePersistence: false })

    await (svc as unknown as { addDHCPAllowRules: () => Promise<void> }).addDHCPAllowRules()

    expect(errorEntries()).toHaveLength(0)
    // Both directional DHCP rules were inserted (runtime behavior intact).
    expect(calls.filter(a => a[0] === 'insert' && a[1] === 'rule')).toHaveLength(2)
  })

  it('addDHCPAllowRules with rules already PRESENT skips — no ERROR, no insert', async () => {
    const calls: string[][] = []
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'list') {
        return 'chain forward {\n"infinization-dhcp-client-to-server"\n"infinization-dhcp-server-to-client"\n}'
      }
      return ''
    })
    const svc = new NftablesService({ enablePersistence: false })

    await (svc as unknown as { addDHCPAllowRules: () => Promise<void> }).addDHCPAllowRules()

    expect(errorEntries()).toHaveLength(0)
    expect(entries.some(e => /already exist, skipping/.test(e.message))).toBe(true)
    expect(calls.filter(a => a[0] === 'insert')).toHaveLength(0)
  })
})
