import {
  DEFAULT_SPICE_ADDR,
  DEFAULT_VNC_ADDR,
  isLoopbackAddr,
  VNC_BASE_PORT
} from '../src/types/display.types'
import { VncConfig } from '../src/display/VncConfig'

describe('secure-by-default display', () => {
  it('defaults SPICE/VNC bind to loopback (not 0.0.0.0)', () => {
    expect(DEFAULT_SPICE_ADDR).toBe('127.0.0.1')
    expect(DEFAULT_VNC_ADDR).toBe('127.0.0.1')
  })

  it('isLoopbackAddr recognizes loopback and rejects routable addresses', () => {
    expect(isLoopbackAddr('127.0.0.1')).toBe(true)
    expect(isLoopbackAddr('::1')).toBe(true)
    expect(isLoopbackAddr('localhost')).toBe(true)
    expect(isLoopbackAddr('0.0.0.0')).toBe(false)
    expect(isLoopbackAddr('192.168.1.10')).toBe(false)
  })

  it('VncConfig accepts a valid display number (port->display conversion target)', () => {
    // 5900 -> display 0 is the conversion VMLifecycle now performs.
    const display = 5901 - VNC_BASE_PORT
    expect(() => new VncConfig({ display, addr: '127.0.0.1' })).not.toThrow()
  })

  it('VncConfig rejects a raw TCP port passed as a display number (the old dead path)', () => {
    // Passing the port (5901) straight through is > 99 and must be rejected —
    // VMLifecycle now converts port->display so this never happens at runtime.
    expect(() => new VncConfig({ display: 5901, addr: '127.0.0.1' })).toThrow()
  })
})
