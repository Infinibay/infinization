/**
 * generateVMChainName — collision-resistant, deterministic chain naming (audit B4/T2).
 */
import { generateVMChainName, VM_CHAIN_PREFIX, MAX_CHAIN_NAME_LENGTH } from '../src/types/firewall.types'

describe('generateVMChainName', () => {
  it('is deterministic for the same vmId', () => {
    const id = '5f9b1c2d-0000-4aaa-8bbb-1234567890ab'
    expect(generateVMChainName(id)).toBe(generateVMChainName(id))
  })

  it('starts with the VM chain prefix and stays within the nft name limit', () => {
    const name = generateVMChainName('any-vm-id-here')
    expect(name.startsWith(VM_CHAIN_PREFIX)).toBe(true)
    expect(name.length).toBeLessThanOrEqual(MAX_CHAIN_NAME_LENGTH)
  })

  it('does NOT collide for two UUIDs sharing the first 8 characters', () => {
    // The old substring(0,8) scheme produced the SAME chain for both of these,
    // letting one VM overwrite/delete the other's firewall. The hash must not.
    const a = 'aaaaaaaa-1111-4111-8111-111111111111'
    const b = 'aaaaaaaa-2222-4222-8222-222222222222'
    expect(generateVMChainName(a)).not.toBe(generateVMChainName(b))
  })

  it('produces only nft-safe characters (vm_ + lowercase hex)', () => {
    expect(generateVMChainName('Some-Mixed-CASE-id')).toMatch(/^vm_[0-9a-f]+$/)
  })
})
