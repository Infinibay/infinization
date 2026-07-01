import {
  DEFAULT_SPICE_ADDR,
  DEFAULT_VNC_ADDR,
  isLoopbackAddr,
  resolveBindAddress,
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

  describe('resolveBindAddress (self-heal stale/unbindable display bind)', () => {
    // Simulates the host currently owning 10.89.2.130 (the container's IP after a
    // restart). 10.89.2.129 — what a cron previously froze into graphicHost — is
    // NOT local anymore, so QEMU can no longer bind it.
    const localAddrs = new Set(['127.0.0.1', '::1', '10.89.2.130', 'fe80::1'])

    it('heals a stale concrete IP that is no longer a local interface -> 0.0.0.0', () => {
      // This is the exact production failure: bind to 10.89.2.129 => QEMU dies
      // with "failed to initialize spice server" and the VM is stuck forever.
      expect(resolveBindAddress('10.89.2.129', localAddrs)).toBe('0.0.0.0')
    })

    it('keeps a concrete IP that IS still a current local interface', () => {
      expect(resolveBindAddress('10.89.2.130', localAddrs)).toBe('10.89.2.130')
    })

    it('passes wildcard binds through unchanged (always bindable)', () => {
      expect(resolveBindAddress('0.0.0.0', localAddrs)).toBe('0.0.0.0')
      expect(resolveBindAddress('::', localAddrs)).toBe('::')
    })

    it('passes loopback through unchanged (always bindable, secure)', () => {
      expect(resolveBindAddress('127.0.0.1', localAddrs)).toBe('127.0.0.1')
      expect(resolveBindAddress('::1', localAddrs)).toBe('::1')
      expect(resolveBindAddress('LOCALHOST', localAddrs)).toBe('LOCALHOST')
    })

    it('falls back to the secure default when nothing is configured', () => {
      expect(resolveBindAddress(null, localAddrs)).toBe(DEFAULT_SPICE_ADDR)
      expect(resolveBindAddress(undefined, localAddrs)).toBe(DEFAULT_SPICE_ADDR)
      expect(resolveBindAddress('   ', localAddrs)).toBe(DEFAULT_SPICE_ADDR)
    })

    it('respects an explicit fallback override', () => {
      expect(resolveBindAddress('', localAddrs, '0.0.0.0')).toBe('0.0.0.0')
    })
  })
})
