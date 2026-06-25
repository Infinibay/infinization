/**
 * BridgeManager — input validation at the trust boundary (audit I21).
 */
const execMock = jest.fn()
jest.mock('@utils/commandExecutor', () => ({
  CommandExecutor: jest.fn().mockImplementation(() => ({ execute: execMock }))
}))

import { BridgeManager } from '../src/network/BridgeManager'

describe('BridgeManager input validation', () => {
  let bridge: BridgeManager

  beforeEach(() => {
    execMock.mockReset()
    execMock.mockResolvedValue('')
    bridge = new BridgeManager()
  })

  it('rejects a bridge name with unsafe characters before issuing any command', async () => {
    await expect(bridge.create('bad name!')).rejects.toThrow(/Invalid bridge name/)
    expect(execMock).not.toHaveBeenCalled()
  })

  it('rejects a bridge name longer than the 15-char interface limit', async () => {
    await expect(bridge.create('infinibr-toolongxx')).rejects.toThrow(/Invalid bridge name/)
  })

  it('rejects a malformed CIDR in assignIP', async () => {
    await expect(bridge.assignIP('infinibr-x', 'not-cidr')).rejects.toThrow(/Invalid IPv4/)
    await expect(bridge.assignIP('infinibr-x', '999.1.1.1/24')).rejects.toThrow(/Invalid IPv4/)
    await expect(bridge.assignIP('infinibr-x', '10.0.0.1/40')).rejects.toThrow(/Invalid IPv4/)
  })

  it('accepts a valid bridge name + CIDR', async () => {
    await expect(bridge.assignIP('infinibr-abc', '10.10.100.1/24')).resolves.toBeUndefined()
  })
})
