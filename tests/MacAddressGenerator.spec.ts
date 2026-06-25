/**
 * MacAddressGenerator — deterministic, collision-resistant, QEMU-family MACs
 * (audit I19/I20/M18).
 */
import { MacAddressGenerator } from '../src/network/MacAddressGenerator'

describe('MacAddressGenerator', () => {
  describe('generateFromVmId', () => {
    it('is deterministic and well-formed', () => {
      const id = '5f9b1c2d-0000-4aaa-8bbb-1234567890ab'
      const mac = MacAddressGenerator.generateFromVmId(id)
      expect(MacAddressGenerator.generateFromVmId(id)).toBe(mac)
      expect(MacAddressGenerator.validate(mac)).toBe(true)
    })

    it('uses the locally-administered QEMU family prefix 52:54', () => {
      const mac = MacAddressGenerator.generateFromVmId('vm-x')
      expect(mac.startsWith('52:54:')).toBe(true)
      expect(MacAddressGenerator.isQemuMac(mac)).toBe(true)
    })

    it('does NOT collide for two UUIDs sharing the first 6 hex characters', () => {
      const a = 'abcdef00-1111-4111-8111-111111111111'
      const b = 'abcdef00-2222-4222-8222-222222222222'
      expect(MacAddressGenerator.generateFromVmId(a)).not.toBe(MacAddressGenerator.generateFromVmId(b))
    })
  })

  describe('generate (random)', () => {
    it('produces a valid QEMU-family MAC', () => {
      const mac = MacAddressGenerator.generate()
      expect(MacAddressGenerator.validate(mac)).toBe(true)
      expect(MacAddressGenerator.isQemuMac(mac)).toBe(true)
    })
  })

  describe('validate / isQemuMac', () => {
    it('rejects malformed MACs', () => {
      expect(MacAddressGenerator.validate('not-a-mac')).toBe(false)
      expect(MacAddressGenerator.validate('52:54:00:zz:zz:zz')).toBe(false)
    })

    it('isQemuMac is false for a non-locally-administered OUI', () => {
      expect(MacAddressGenerator.isQemuMac('00:11:22:33:44:55')).toBe(false)
    })
  })
})
