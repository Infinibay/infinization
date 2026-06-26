/**
 * NftablesService hardening regression tests (audit L86 / L90 / L98).
 *
 * The CommandExecutor is mocked with a small STATEFUL fake "kernel" so we can assert
 * real behavior: which chains exist, what the forward chain contains, and what each
 * `nft -f -` transaction wrote. Covers:
 *   - L90: jump-rule idempotency — attaching twice yields exactly ONE to-VM and ONE
 *          from-VM jump in the shared forward chain.
 *   - L86: empty-chain cache invalidation — a cache hit is NOT honored when the kernel
 *          chain has vanished; applyRulesIfChanged re-applies the terminal drop.
 *   - L98: DHCP allow rules carry the managed-interface (vnet-*) + DHCP-flow qualifier
 *          rather than a bare `udp dport 67/68 accept` over the whole forward hook.
 */
const execMock = jest.fn()
jest.mock('@utils/commandExecutor', () => ({
  CommandExecutor: jest.fn().mockImplementation(() => ({ execute: execMock }))
}))

import { NftablesService } from '../src/network/NftablesService'
import { generateVMChainName } from '../src/types/firewall.types'

/**
 * A minimal stateful nft fake. Tracks which chains "exist" and the line-oriented text
 * of the forward chain (so list-then-add idempotency and handle deletion behave like
 * the real kernel). Only models the subcommands NftablesService uses.
 */
class FakeNft {
  /** chains that exist (besides the implicit table) */
  chains = new Set<string>()
  /** ordered rule lines living in the base `forward` chain, with synthetic handles */
  forwardRules: Array<{ text: string; handle: number }> = []
  private nextHandle = 1
  /** captured stdin of every `nft -f -` transaction */
  appliedRulesets: string[] = []

  constructor () {
    this.chains.add('forward')
  }

  /** Render the forward chain the way `nft -a list chain ... forward` would. */
  renderForward (): string {
    const body = this.forwardRules
      .map(r => `\t\t${r.text} # handle ${r.handle}`)
      .join('\n')
    return `table bridge infinization {\n\tchain forward {\n${body}\n\t}\n}\n`
  }

  handle (cmd: string, args: string[], opts?: { stdin?: string }): string {
    // Atomic ruleset application (also used by the L94 conntrack probe + applyRules).
    if (cmd === 'nft' && args[0] === '-f' && args[1] === '-') {
      const ruleset = opts?.stdin ?? ''
      this.appliedRulesets.push(ruleset)
      // Reflect chain create/delete from the transaction so chainExists() tracks it.
      for (const line of ruleset.split('\n')) {
        const add = line.match(/^add chain bridge infinization (\S+)/)
        if (add) this.chains.add(add[1])
        const del = line.match(/^delete chain bridge infinization (\S+)/)
        if (del) this.chains.delete(del[1])
      }
      return ''
    }

    if (cmd !== 'nft') return ''
    const sub = args[0]

    // `list chain bridge infinization <name>` — used by chainExists() and the
    // forward-chain pre-existence check. `-a list chain ...` (with handles) is used
    // by removeJumpRules.
    if (sub === 'list' && args[1] === 'chain') {
      const chainName = args[4]
      if (chainName === 'forward') return this.renderForward()
      if (this.chains.has(chainName)) return `table bridge infinization {\n\tchain ${chainName} {\n\t}\n}\n`
      throw new Error(`Error: No such file or directory; chain ${chainName} does not exist`)
    }
    if (sub === '-a' && args[1] === 'list' && args[2] === 'chain') {
      // args: ['-a','list','chain',family,table,chainName]
      return this.renderForward()
    }

    // `add chain bridge infinization <name>`
    if (sub === 'add' && args[1] === 'chain') {
      this.chains.add(args[4])
      return ''
    }

    // `add rule bridge infinization <chain> <tokens...>` and `insert rule ...`
    if ((sub === 'add' || sub === 'insert') && args[1] === 'rule') {
      const chain = args[4]
      const tokens = args.slice(5).join(' ')
      if (chain === 'forward') {
        const entry = { text: tokens, handle: this.nextHandle++ }
        if (sub === 'insert') this.forwardRules.unshift(entry)
        else this.forwardRules.push(entry)
      }
      return ''
    }

    // `delete rule bridge infinization forward handle <n>`
    if (sub === 'delete' && args[1] === 'rule') {
      const hIdx = args.indexOf('handle')
      const h = Number(args[hIdx + 1])
      this.forwardRules = this.forwardRules.filter(r => r.handle !== h)
      return ''
    }

    // `delete chain bridge infinization <name>`
    if (sub === 'delete' && args[1] === 'chain') {
      this.chains.delete(args[4])
      return ''
    }

    // `flush chain ...`
    if (sub === 'flush' && args[1] === 'chain') return ''

    return ''
  }
}

/**
 * The bridge-conntrack mode / support flag / one-shot probe are now PROCESS-WIDE statics
 * (audit MF-5) so the probe result reaches every instance's apply path, not only the one
 * that called initialize(). That shared state would otherwise leak across tests, so reset
 * it before each test: clear the memoized probe + support flag and restore the default
 * 'fail' mode. Reaches the private statics via an indexed cast (test-only).
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

describe('NftablesService hardening (L86 / L90 / L98 / MF-5)', () => {
  let fake: FakeNft

  beforeEach(() => {
    fake = new FakeNft()
    execMock.mockReset()
    execMock.mockImplementation((cmd: string, args: string[], opts?: { stdin?: string }) =>
      Promise.resolve(fake.handle(cmd, args, opts)))
    resetConntrackStatics()
  })

  // --------------------------------------------------------------------------
  // L90 — jump-rule idempotency in the shared forward chain
  // --------------------------------------------------------------------------
  describe('L90: jump-rule idempotency', () => {
    function countJumps (chain: string, dir: 'oifname' | 'iifname'): number {
      return fake.forwardRules.filter(r =>
        r.text.includes(`${dir} `) && r.text.includes(`jump ${chain}`)).length
    }

    it('attaching twice yields exactly ONE to-VM and ONE from-VM jump', async () => {
      const svc = new NftablesService({ enablePersistence: false })
      const chain = generateVMChainName('vm-1')
      await svc.ensureVMChain('vm-1')

      await svc.attachJumpRules('vm-1', 'vnet-abc12345')
      await svc.attachJumpRules('vm-1', 'vnet-abc12345')

      expect(countJumps(chain, 'oifname')).toBe(1)
      expect(countJumps(chain, 'iifname')).toBe(1)
    })

    it('createVMChain followed by attachJumpRules does NOT duplicate the jumps', async () => {
      const svc = new NftablesService({ enablePersistence: false })
      const chain = generateVMChainName('vm-2')

      await svc.createVMChain('vm-2', 'vnet-def67890')
      await svc.attachJumpRules('vm-2', 'vnet-def67890')

      expect(countJumps(chain, 'oifname')).toBe(1)
      expect(countJumps(chain, 'iifname')).toBe(1)
    })

    it('a prefix-colliding TAP name does NOT suppress a distinct VM jump', async () => {
      const svc = new NftablesService({ enablePersistence: false })
      // vnet-abc is a prefix of vnet-abc1 — both must get their own jumps.
      await svc.attachJumpRules('vm-a', 'vnet-abc')
      await svc.attachJumpRules('vm-b', 'vnet-abc1')

      expect(countJumps(generateVMChainName('vm-a'), 'oifname')).toBe(1)
      expect(countJumps(generateVMChainName('vm-b'), 'oifname')).toBe(1)
    })
  })

  // --------------------------------------------------------------------------
  // L86 — empty-chain cache invalidation forces a re-apply (fail-closed)
  // --------------------------------------------------------------------------
  describe('L86: empty-chain cache invalidation', () => {
    function rulesetsWithTerminalDrop (): string[] {
      return fake.appliedRulesets.filter(r => /drop comment "infinization-default-drop"/.test(r))
    }

    it('applyRulesIfChanged re-applies the terminal drop after the chain vanishes (cache hit not honored)', async () => {
      const svc = new NftablesService({ enablePersistence: false })

      // First apply: writes the terminal drop and caches the hash.
      const first = await svc.applyRulesIfChanged('vm-1', 'vnet-1', [], [], 'drop')
      expect(first.changed).toBe(true)
      expect(rulesetsWithTerminalDrop().length).toBe(1)

      // Same inputs again — cache hit, chain still present → no re-apply.
      const second = await svc.applyRulesIfChanged('vm-1', 'vnet-1', [], [], 'drop')
      expect(second.changed).toBe(false)
      expect(rulesetsWithTerminalDrop().length).toBe(1)

      // Now the kernel chain vanishes out from under us (deleted externally / restart).
      fake.chains.delete(generateVMChainName('vm-1'))

      // Cache still holds the hash, but the chain is GONE. Honoring the cache here would
      // boot the VM with no terminal drop. The fix forces a re-apply.
      const third = await svc.applyRulesIfChanged('vm-1', 'vnet-1', [], [], 'drop')
      expect(third.changed).toBe(true)
      expect(rulesetsWithTerminalDrop().length).toBe(2)
    })

    it('ensureVMChain recreating an empty chain invalidates the cache, forcing the next apply', async () => {
      const svc = new NftablesService({ enablePersistence: false })

      // Apply once to seed the hash cache for vm-1.
      await svc.applyRulesIfChanged('vm-1', 'vnet-1', [], [], 'drop')
      const baseline = fake.appliedRulesets.length

      // Simulate a restart: the chain was deleted, then ensureVMChain recreates it EMPTY.
      fake.chains.delete(generateVMChainName('vm-1'))
      await svc.ensureVMChain('vm-1')
      expect(fake.chains.has(generateVMChainName('vm-1'))).toBe(true)

      // With the cache invalidated by ensureVMChain, the same inputs must now re-apply
      // (write the terminal drop into the freshly-recreated empty chain).
      const res = await svc.applyRulesIfChanged('vm-1', 'vnet-1', [], [], 'drop')
      expect(res.changed).toBe(true)
      expect(fake.appliedRulesets.length).toBeGreaterThan(baseline)
    })
  })

  // --------------------------------------------------------------------------
  // L98 — DHCP allow rules carry the bridge/flow qualifier
  // --------------------------------------------------------------------------
  describe('L98: scoped DHCP allow rules', () => {
    function dhcpRuleLines (): string[] {
      return fake.forwardRules
        .map(r => r.text)
        .filter(t => t.includes('infinization-dhcp'))
    }

    it('initialize() installs DHCP rules scoped to managed TAP interfaces + DHCP flow', async () => {
      // 'degrade' so the conntrack preflight cannot throw under the fake (which would
      // happen if the probe ruleset were treated as unsupported); the fake accepts it,
      // but degrade keeps the test robust regardless.
      const svc = new NftablesService({ enablePersistence: false, bridgeConntrackMode: 'degrade' })
      await svc.initialize()

      const lines = dhcpRuleLines()
      // client->server: iifname vnet-* , udp sport 68 dport 67
      const clientToServer = lines.find(l => l.includes('iifname'))
      expect(clientToServer).toBeDefined()
      expect(clientToServer).toContain('iifname vnet-*')
      expect(clientToServer).toContain('sport 68')
      expect(clientToServer).toContain('dport 67')

      // server->client: oifname vnet-* , udp sport 67 dport 68
      const serverToClient = lines.find(l => l.includes('oifname'))
      expect(serverToClient).toBeDefined()
      expect(serverToClient).toContain('oifname vnet-*')
      expect(serverToClient).toContain('sport 67')
      expect(serverToClient).toContain('dport 68')
    })

    it('does NOT install a bare interface-unqualified `udp dport 67 accept` over the whole forward hook', async () => {
      const svc = new NftablesService({ enablePersistence: false, bridgeConntrackMode: 'degrade' })
      await svc.initialize()

      // Every DHCP accept must be qualified by a managed interface. There must be no
      // forward-chain accept that matches a bare udp dport 67/68 with no iifname/oifname.
      const bareDhcp = fake.forwardRules
        .map(r => r.text)
        .filter(t => /udp dport 6[78]/.test(t) && t.includes('accept'))
        .filter(t => !t.includes('iifname') && !t.includes('oifname'))
      expect(bareDhcp).toEqual([])
    })
  })

  // --------------------------------------------------------------------------
  // L94 — bridge-conntrack preflight (init-time diagnosis instead of per-VM failure)
  // --------------------------------------------------------------------------
  describe('L94: bridge-conntrack preflight', () => {
    it("mode='fail' (default) throws ONE actionable init error naming the modules when the ct-state probe is rejected", async () => {
      const svc = new NftablesService({ enablePersistence: false })
      execMock.mockImplementation((cmd: string, args: string[]) => {
        // The probe applies a `ct state established` rule via `nft -f -`. Reject it.
        if (cmd === 'nft' && args[0] === '-f' && args[1] === '-') {
          return Promise.reject(new Error('Error: conntrack not supported in bridge family'))
        }
        if (cmd === 'modprobe') return Promise.reject(new Error('modprobe: not found'))
        return Promise.resolve('')
      })
      await expect(svc.initialize()).rejects.toThrow(/br_netfilter|nf_conntrack_bridge/)
    })

    it("mode='degrade' starts stateless (no established/related rule) instead of throwing", async () => {
      const svc = new NftablesService({ enablePersistence: false, bridgeConntrackMode: 'degrade' })
      let probeRejected = false
      execMock.mockImplementation((cmd: string, args: string[], opts?: { stdin?: string }) => {
        if (cmd === 'modprobe') return Promise.reject(new Error('modprobe: not found'))
        // Reject ONLY the ct-state probe ruleset; let the real applyRules transaction
        // (which omits ct-state in degraded mode) succeed.
        if (cmd === 'nft' && args[0] === '-f' && args[1] === '-' &&
            (opts?.stdin ?? '').includes('ct state established') && !probeRejected) {
          probeRejected = true
          return Promise.reject(new Error('Error: conntrack not supported in bridge family'))
        }
        return Promise.resolve(fake.handle(cmd, args, opts))
      })

      await expect(svc.initialize()).resolves.toBeUndefined()

      // In degraded mode the applied ruleset must NOT carry a ct-state line.
      await svc.applyRules('vm-1', 'vnet-1', [], [], 'drop')
      const lastRuleset = fake.appliedRulesets[fake.appliedRulesets.length - 1]
      expect(lastRuleset).toBeDefined()
      expect(lastRuleset).not.toContain('ct state')
      // ...but the terminal drop is still present (fail-closed posture preserved).
      expect(lastRuleset).toMatch(/drop comment "infinization-default-drop"/)
    })
  })

  // --------------------------------------------------------------------------
  // MF-5 — conntrack probe result + degrade mode reach the VM-START apply path
  //        on instances that NEVER call initialize() (shared static state).
  // --------------------------------------------------------------------------
  describe('MF-5: conntrack state reaches the VM-start path (no initialize)', () => {
    /**
     * Installs an exec mock that rejects ONLY the ct-state probe ruleset (the throwaway
     * `nft -f -` carrying `ct state established`), simulating a host without
     * nf_conntrack_bridge. The real per-VM apply transactions go to the stateful fake.
     * Returns a counter of how many times the ct-state PROBE ruleset was issued, so a
     * test can assert the probe runs at most once.
     */
    function mockHostWithoutBridgeConntrack (): { probeCount: () => number } {
      let probes = 0
      execMock.mockImplementation((cmd: string, args: string[], opts?: { stdin?: string }) => {
        if (cmd === 'modprobe') return Promise.reject(new Error('modprobe: not found'))
        const stdin = opts?.stdin ?? ''
        // The probe ruleset is the only one that creates the throwaway infz_ctprobe chain.
        if (cmd === 'nft' && args[0] === '-f' && args[1] === '-' && stdin.includes('infz_ctprobe')) {
          probes++
          return Promise.reject(new Error('Error: conntrack not supported in bridge family'))
        }
        return Promise.resolve(fake.handle(cmd, args, opts))
      })
      return { probeCount: () => probes }
    }

    it("(a) degrade mode: an instance that NEVER called initialize() OMITS the established rule on apply", async () => {
      // Mode is process-wide; one construction with the option flips the shared static.
      // eslint-disable-next-line no-new
      new NftablesService({ enablePersistence: false, bridgeConntrackMode: 'degrade' })
      mockHostWithoutBridgeConntrack()

      // A SEPARATE instance — exactly like VMLifecycle's `new NftablesService()` — that
      // never calls initialize(). Its first applyRules must run the shared probe, see
      // degrade + unsupported, and omit the ct-state rule so the apply does NOT throw.
      const vmStartSvc = new NftablesService({ enablePersistence: false })
      await expect(vmStartSvc.applyRules('vm-1', 'vnet-1', [], [], 'drop')).resolves.toBeDefined()

      const lastRuleset = fake.appliedRulesets[fake.appliedRulesets.length - 1]
      expect(lastRuleset).toBeDefined()
      expect(lastRuleset).not.toContain('ct state')
      // Terminal drop still written — fail-closed posture preserved in degraded mode.
      expect(lastRuleset).toMatch(/drop comment "infinization-default-drop"/)
    })

    it("(b) fail mode (default): an instance that NEVER called initialize() THROWS the actionable conntrack error on its first apply", async () => {
      mockHostWithoutBridgeConntrack()

      // Default mode is 'fail'. The VM-start instance never calls initialize(); the probe
      // must fire on its FIRST apply and reject with the actionable, module-naming error.
      const vmStartSvc = new NftablesService({ enablePersistence: false })
      await expect(vmStartSvc.applyRules('vm-1', 'vnet-1', [], [], 'drop'))
        .rejects.toThrow(/br_netfilter|nf_conntrack_bridge/)
    })

    it('the probe runs only ONCE across multiple instances and multiple applies', async () => {
      // eslint-disable-next-line no-new
      new NftablesService({ enablePersistence: false, bridgeConntrackMode: 'degrade' })
      const { probeCount } = mockHostWithoutBridgeConntrack()

      const a = new NftablesService({ enablePersistence: false })
      const b = new NftablesService({ enablePersistence: false })

      await a.applyRules('vm-1', 'vnet-1', [], [], 'drop')
      await a.applyRules('vm-1', 'vnet-1', [], [], 'drop')
      await b.applyRules('vm-2', 'vnet-2', [], [], 'drop')
      // initialize() must reuse the same memoized probe, not re-run it.
      await b.initialize()

      expect(probeCount()).toBe(1)
    })

    it('degrade-mode support flag set by one instance is honored by another instance via applyRulesIfChanged (shared static)', async () => {
      // eslint-disable-next-line no-new
      new NftablesService({ enablePersistence: false, bridgeConntrackMode: 'degrade' })
      mockHostWithoutBridgeConntrack()

      const svc = new NftablesService({ enablePersistence: false })
      const res = await svc.applyRulesIfChanged('vm-1', 'vnet-1', [], [], 'drop')
      expect(res.changed).toBe(true)

      const lastRuleset = fake.appliedRulesets[fake.appliedRulesets.length - 1]
      expect(lastRuleset).not.toContain('ct state')

      // Re-applying identical inputs must be a cache HIT (no second transaction): the hash
      // was computed against the degraded (ct-state-omitted) ruleset, matching what was
      // applied — proving applyRulesIfChanged also resolved the shared support flag.
      const before = fake.appliedRulesets.length
      const second = await svc.applyRulesIfChanged('vm-1', 'vnet-1', [], [], 'drop')
      expect(second.changed).toBe(false)
      expect(fake.appliedRulesets.length).toBe(before)
    })
  })
})
