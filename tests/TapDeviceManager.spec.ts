/**
 * TapDeviceManager — JSON carrier/listing parsing (I22) + cleanup grace window (B7).
 */
const execMock = jest.fn()
jest.mock('@utils/commandExecutor', () => ({
  CommandExecutor: jest.fn().mockImplementation(() => ({ execute: execMock }))
}))

import { TapDeviceManager } from '../src/network/TapDeviceManager'

describe('TapDeviceManager', () => {
  let tap: TapDeviceManager

  beforeEach(() => {
    execMock.mockReset()
    tap = new TapDeviceManager()
  })

  describe('hasCarrier (parses `ip -j` JSON, I22)', () => {
    it('returns true when UP + LOWER_UP and no NO-CARRIER', async () => {
      execMock.mockResolvedValue(JSON.stringify([{ ifname: 'vnet-1', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'], operstate: 'UP' }]))
      expect(await tap.hasCarrier('vnet-1')).toBe(true)
    })

    it('returns false when the NO-CARRIER flag is present', async () => {
      execMock.mockResolvedValue(JSON.stringify([{ ifname: 'vnet-1', flags: ['NO-CARRIER', 'BROADCAST', 'UP'], operstate: 'DOWN' }]))
      expect(await tap.hasCarrier('vnet-1')).toBe(false)
    })

    it('returns false on unparseable output', async () => {
      execMock.mockResolvedValue('not json')
      expect(await tap.hasCarrier('vnet-1')).toBe(false)
    })
  })

  describe('listAllTapDevices (parses `ip -j` JSON, I22)', () => {
    it('returns only interfaces with the TAP prefix', async () => {
      execMock.mockResolvedValue(JSON.stringify([{ ifname: 'vnet-aaa' }, { ifname: 'eth0' }, { ifname: 'vnet-bbb' }]))
      expect(await tap.listAllTapDevices()).toEqual(['vnet-aaa', 'vnet-bbb'])
    })
  })

  describe('cleanup grace window (B7)', () => {
    it('does NOT destroy a TAP that was just created (still booting)', async () => {
      // 1. create() succeeds: empty orphan list, device doesn't pre-exist, add OK.
      execMock.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('-j') && args.includes('tuntap')) return Promise.resolve('[]')
        if (args[0] === 'link' && args[1] === 'show') return Promise.reject(new Error('does not exist'))
        return Promise.resolve('')
      })
      const tapName = await tap.create('vm-grace')

      // 2. The freshly-created TAP now shows up in the system and looks orphaned,
      //    but the post-creation grace window must protect it from cleanup.
      const deleted: string[] = []
      execMock.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('-j') && args.includes('tuntap')) return Promise.resolve(JSON.stringify([{ ifname: tapName }]))
        if (args[0] === 'link' && args[1] === 'del') { deleted.push(args[2]); return Promise.resolve('') }
        return Promise.resolve('')
      })

      await tap.cleanupOrphanedTapDevices()
      expect(deleted).not.toContain(tapName)
    })
  })
})
