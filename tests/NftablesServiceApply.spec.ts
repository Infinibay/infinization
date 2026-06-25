/**
 * NftablesService.applyRules — atomic, fail-closed rule application (audit B1/B2/B9/T3).
 * The CommandExecutor is mocked so we can inspect the exact `nft -f -` transaction.
 */
const execMock = jest.fn()
jest.mock('@utils/commandExecutor', () => ({
  CommandExecutor: jest.fn().mockImplementation(() => ({ execute: execMock }))
}))

import { NftablesService } from '../src/network/NftablesService'

describe('NftablesService.applyRules', () => {
  let svc: NftablesService

  beforeEach(() => {
    execMock.mockReset()
    // Default: chainExists (`nft list chain`) succeeds and `nft -f -` succeeds.
    execMock.mockResolvedValue('')
    svc = new NftablesService({ enablePersistence: false })
  })

  /** Finds the single atomic `nft -f -` invocation and returns its stdin ruleset. */
  function appliedRuleset (): string | undefined {
    const call = execMock.mock.calls.find((c) => c[1] && c[1][0] === '-f' && c[1][1] === '-')
    return call?.[2]?.stdin
  }

  it('applies the whole ruleset in ONE `nft -f -` transaction (flush + terminal drop)', async () => {
    await svc.applyRules('vm-1', 'vnet-1', [], [], 'drop')
    const ruleset = appliedRuleset()
    expect(ruleset).toBeDefined()
    expect(ruleset).toContain('flush chain')
    expect(ruleset).toMatch(/add rule .* drop comment "infinization-default-drop"/)
    // And it really was a single transaction (one -f - call).
    expect(execMock.mock.calls.filter((c) => c[1]?.[0] === '-f').length).toBe(1)
  })

  it('uses a terminal ACCEPT for an ALLOW_ALL (default-allow) policy', async () => {
    await svc.applyRules('vm-1', 'vnet-1', [], [], 'accept')
    expect(appliedRuleset()).toMatch(/add rule .* accept comment "infinization-default-accept"/)
  })

  it('defaults to fail-closed `drop` when no policy is given', async () => {
    await svc.applyRules('vm-1', 'vnet-1', [], [])
    expect(appliedRuleset()).toMatch(/default-drop/)
  })

  it('is FAIL-CLOSED: if nft rejects the transaction, applyRules throws (chain keeps old rules)', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '-f') return Promise.reject(new Error('nft: syntax error, rolled back'))
      return Promise.resolve('')
    })
    await expect(svc.applyRules('vm-1', 'vnet-1', [], [], 'drop')).rejects.toThrow()
  })

  it('counts an untranslatable rule as failed but still installs the terminal drop', async () => {
    const badRule = { id: 'b', name: 'bad', action: 'ACCEPT', direction: 'IN', protocol: 'igmp', priority: 100 } as any
    const result = await svc.applyRules('vm-1', 'vnet-1', [badRule], [], 'drop')
    expect(result.failedRules).toBeGreaterThan(0)
    expect(appliedRuleset()).toMatch(/drop comment "infinization-default-drop"/)
  })
})
