/**
 * DepartmentNatService — idempotent masquerade + exact comment matching (audit I16/I17/M4).
 */
const execMock = jest.fn()
jest.mock('@utils/commandExecutor', () => ({
  CommandExecutor: jest.fn().mockImplementation(() => ({ execute: execMock }))
}))

import { DepartmentNatService } from '../src/network/DepartmentNatService'

describe('DepartmentNatService.addMasquerade', () => {
  let svc: DepartmentNatService

  beforeEach(() => {
    execMock.mockReset()
    execMock.mockResolvedValue('')
    svc = new DepartmentNatService()
  })

  const addRuleCalls = () =>
    execMock.mock.calls.filter((c) => c[1]?.[0] === 'add' && c[1]?.[1] === 'rule')

  it('does NOT add a second masquerade rule when one already exists (idempotent)', async () => {
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('list') && args.includes('chain')) {
        return Promise.resolve('chain postrouting { ip saddr 10.0.0.0/24 masquerade comment "dept-infinibr-abc" }')
      }
      return Promise.resolve('')
    })

    await svc.addMasquerade('10.0.0.0/24', 'infinibr-abc')
    expect(addRuleCalls().length).toBe(0)
  })

  it('adds the masquerade rule exactly once when none exists', async () => {
    execMock.mockResolvedValue('') // list chain empty => hasMasquerade false
    await svc.addMasquerade('10.0.0.0/24', 'infinibr-xyz')
    expect(addRuleCalls().length).toBe(1)
  })

  it('does NOT treat a prefix-sharing bridge as already present (exact comment match)', async () => {
    // Existing rule is for "infinibr-abc123"; adding "infinibr-abc" must NOT be
    // considered a duplicate (the old substring check would have collided).
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('list') && args.includes('chain')) {
        return Promise.resolve('chain postrouting { masquerade comment "dept-infinibr-abc123" }')
      }
      return Promise.resolve('')
    })
    await svc.addMasquerade('10.0.0.0/24', 'infinibr-abc')
    expect(addRuleCalls().length).toBe(1)
  })

  it('rejects an invalid subnet before issuing any nft command', async () => {
    await expect(svc.addMasquerade('not-a-subnet', 'infinibr-x')).rejects.toThrow()
    expect(execMock).not.toHaveBeenCalled()
  })
})
