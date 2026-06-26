/**
 * NftablesService.applyRules — atomic, fail-closed rule application (audit B1/B2/B9/T3).
 * The CommandExecutor is mocked so we can inspect the exact `nft -f -` transaction.
 */
const execMock = jest.fn()
jest.mock('@utils/commandExecutor', () => ({
  CommandExecutor: jest.fn().mockImplementation(() => ({ execute: execMock }))
}))

import { NftablesService } from '../src/network/NftablesService'

/**
 * The bridge-conntrack probe (audit MF-5) is memoized on PROCESS-WIDE statics and now
 * runs once on the first apply of any instance. Reset that shared state before each test
 * so every test's first applyRules() re-runs the probe deterministically (it succeeds
 * here because the default mock resolves every nft call). Reaches the private statics via
 * an indexed cast (test-only).
 */
function resetConntrackStatics (): void {
  const s = NftablesService as unknown as {
    conntrackProbe?: Promise<void>
    bridgeConntrackSupported: boolean | null
    bridgeConntrackMode: 'fail' | 'degrade'
  }
  s.conntrackProbe = undefined
  s.bridgeConntrackSupported = null
  s.bridgeConntrackMode = 'fail'
}

/** True for the one-time MF-5 conntrack PROBE transaction (throwaway infz_ctprobe chain). */
function isProbeRuleset (stdin?: string): boolean {
  return (stdin ?? '').includes('infz_ctprobe')
}

describe('NftablesService.applyRules', () => {
  let svc: NftablesService

  beforeEach(() => {
    execMock.mockReset()
    // Default: chainExists (`nft list chain`) succeeds and `nft -f -` succeeds.
    execMock.mockResolvedValue('')
    resetConntrackStatics()
    svc = new NftablesService({ enablePersistence: false })
  })

  /**
   * Finds the atomic VM-apply `nft -f -` invocation and returns its stdin ruleset,
   * skipping the one-time conntrack PROBE transaction (MF-5) so assertions target the
   * real per-VM apply rather than the throwaway probe.
   */
  function appliedRuleset (): string | undefined {
    const call = execMock.mock.calls.find(
      (c) => c[1] && c[1][0] === '-f' && c[1][1] === '-' && !isProbeRuleset(c[2]?.stdin))
    return call?.[2]?.stdin
  }

  it('applies the whole ruleset in ONE `nft -f -` transaction (flush + terminal drop)', async () => {
    await svc.applyRules('vm-1', 'vnet-1', [], [], 'drop')
    const ruleset = appliedRuleset()
    expect(ruleset).toBeDefined()
    expect(ruleset).toContain('flush chain')
    expect(ruleset).toMatch(/add rule .* drop comment "infinization-default-drop"/)
    // And the VM apply itself really was a single transaction (one -f - call), excluding
    // the one-time MF-5 conntrack probe transaction.
    const applyTransactions = execMock.mock.calls.filter(
      (c) => c[1]?.[0] === '-f' && !isProbeRuleset(c[2]?.stdin))
    expect(applyTransactions.length).toBe(1)
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
    execMock.mockImplementation((_cmd: string, args: string[], opts?: { stdin?: string }) => {
      // Let the one-time MF-5 conntrack probe SUCCEED so this test exercises the actual
      // per-VM apply-transaction rollback (not a probe failure).
      if (args[0] === '-f' && isProbeRuleset(opts?.stdin)) return Promise.resolve('')
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
