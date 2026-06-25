/**
 * FirewallRuleTranslator — pure DB-rule → nft-token translation.
 * Locks in the exact token output and the IPv4-only / supported-protocol contract
 * (the audit's T1). The translator is pure/static, so no mocking is needed.
 */
import { FirewallRuleTranslator } from '../src/network/FirewallRuleTranslator'
import { FirewallRuleInput } from '../src/types/firewall.types'

const TAP = 'vnet-abc'

function rule (over: Partial<FirewallRuleInput>): FirewallRuleInput {
  return {
    id: 'r1',
    name: 'rule',
    action: 'ACCEPT',
    direction: 'IN',
    protocol: 'tcp',
    priority: 100,
    ...over
  }
}

describe('FirewallRuleTranslator.translateToTokens', () => {
  it('maps IN to oifname and OUT to iifname (bridge-family direction)', () => {
    expect(FirewallRuleTranslator.translateToTokens(rule({ direction: 'IN', protocol: 'all', name: 'x' }), TAP))
      .toEqual(['oifname', TAP, 'accept', 'comment', '"x"'])
    expect(FirewallRuleTranslator.translateToTokens(rule({ direction: 'OUT', protocol: 'all', name: 'x' }), TAP))
      .toEqual(['iifname', TAP, 'accept', 'comment', '"x"'])
  })

  it('emits protocol + single dport + action + comment for a tcp rule', () => {
    const tokens = FirewallRuleTranslator.translateToTokens(
      rule({ direction: 'IN', protocol: 'tcp', dstPortStart: 443, dstPortEnd: 443, action: 'ACCEPT', name: 'HTTPS' }),
      TAP
    )
    expect(tokens).toEqual(['oifname', TAP, 'ip', 'protocol', 'tcp', 'tcp', 'dport', '443', 'accept', 'comment', '"HTTPS"'])
  })

  it('emits a port RANGE when start != end', () => {
    const tokens = FirewallRuleTranslator.translateToTokens(
      rule({ protocol: 'tcp', dstPortStart: 137, dstPortEnd: 139, name: 'nb' }), TAP
    )
    expect(tokens).toContain('137-139')
  })

  it('emits ip saddr with CIDR from a dotted-decimal mask', () => {
    const tokens = FirewallRuleTranslator.translateToTokens(
      rule({ protocol: 'all', srcIpAddr: '10.0.0.0', srcIpMask: '255.255.255.0', name: 'net' }), TAP
    )
    expect(tokens).toEqual(expect.arrayContaining(['ip', 'saddr', '10.0.0.0/24']))
  })

  it('renders a MULTI connection-state set as a single brace token', () => {
    const inTokens = FirewallRuleTranslator.translateToTokens(
      rule({ direction: 'IN', protocol: 'all', name: 'est', connectionState: { established: true, related: true } }),
      TAP
    )
    expect(inTokens).toEqual(expect.arrayContaining(['ct', 'state', '{ established, related }']))
  })

  it('renders a SINGLE connection-state without braces', () => {
    const tokens = FirewallRuleTranslator.translateToTokens(
      rule({ direction: 'IN', protocol: 'all', name: 'est', connectionState: { established: true } }), TAP
    )
    expect(tokens).toEqual(expect.arrayContaining(['ct', 'state', 'established']))
  })

  it('lowercases the action verb', () => {
    expect(FirewallRuleTranslator.translateToTokens(rule({ protocol: 'all', action: 'DROP', name: 'd' }), TAP)).toContain('drop')
    expect(FirewallRuleTranslator.translateToTokens(rule({ protocol: 'all', action: 'REJECT', name: 'r' }), TAP)).toContain('reject')
  })

  it('REJECTS an unsupported protocol (enforcement layer cannot express it)', () => {
    expect(() => FirewallRuleTranslator.translateToTokens(rule({ protocol: 'igmp', name: 'bad' }), TAP)).toThrow()
  })

  it('REJECTS an IPv6 source address (translator is IPv4-only)', () => {
    expect(() => FirewallRuleTranslator.translateToTokens(rule({ protocol: 'all', srcIpAddr: '2001:db8::1', name: 'v6' }), TAP)).toThrow()
  })

  it('REJECTS INOUT directly — the caller must expand it to IN/OUT', () => {
    expect(() => FirewallRuleTranslator.translateToTokens(rule({ direction: 'INOUT', protocol: 'all', name: 'io' }), TAP)).toThrow()
  })
})
