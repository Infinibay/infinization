/**
 * SPICE configuration tests
 *
 * Tests for SpiceConfig class and QemuCommandBuilder.addSpice() method
 * covering default options, WAN/LAN optimizations, GL acceleration,
 * QXL memory override behavior, and all validation branches.
 */

import * as fs from 'fs'
import { SpiceConfig } from '../src/display/SpiceConfig'
import { QemuCommandBuilder } from '../src/core/QemuCommandBuilder'
import {
  DisplayError,
  DisplayErrorCode,
  SpiceImageCompression,
  SpiceWanCompression,
  SpiceStreamingMode,
  SpicePlaybackCompression
} from '../src/types/display.types'

// Mock fs.existsSync for GL rendernode tests
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn()
}))

const mockedFs = fs as jest.Mocked<typeof fs>

describe('SpiceConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Default configuration', () => {
    it('generates args with all default optimization values', () => {
      const config = new SpiceConfig({
        port: 5901,
        addr: '0.0.0.0'
      })

      const { args, vgaType } = config.generateArgs()

      // Should contain -spice argument
      const spiceIndex = args.indexOf('-spice')
      expect(spiceIndex).toBeGreaterThanOrEqual(0)

      const spiceArg = args[spiceIndex + 1]

      // Verify default compression settings
      expect(spiceArg).toContain('image-compression=auto_glz')
      expect(spiceArg).toContain('jpeg-wan-compression=auto')
      expect(spiceArg).toContain('zlib-glz-wan-compression=auto')

      // Verify default streaming setting
      expect(spiceArg).toContain('streaming-video=filter')

      // Verify default playback compression
      expect(spiceArg).toContain('playback-compression=on')

      // Verify VGA type is QXL
      expect(vgaType).toBe('qxl')

      // Should contain -vga qxl
      const vgaIndex = args.indexOf('-vga')
      expect(vgaIndex).toBeGreaterThanOrEqual(0)
      expect(args[vgaIndex + 1]).toBe('qxl')
    })

    it('includes port and address in generated args', () => {
      const config = new SpiceConfig({
        port: 5902,
        addr: '127.0.0.1'
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('port=5902')
      expect(spiceArg).toContain('addr=127.0.0.1')
    })

    it('enables agent by default', () => {
      const config = new SpiceConfig({
        port: 5901
      })

      expect(config.isAgentEnabled()).toBe(true)
    })
  })

  describe('WAN-optimized configuration', () => {
    it('generates args with maximum compression for WAN', () => {
      const config = new SpiceConfig({
        port: 5901,
        imageCompression: 'glz',
        jpegWanCompression: 'always',
        zlibGlzWanCompression: 'always',
        streamingVideo: 'all'
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('image-compression=glz')
      expect(spiceArg).toContain('jpeg-wan-compression=always')
      expect(spiceArg).toContain('zlib-glz-wan-compression=always')
      expect(spiceArg).toContain('streaming-video=all')
    })
  })

  describe('LAN-optimized configuration', () => {
    it('generates args with minimal compression for LAN', () => {
      const config = new SpiceConfig({
        port: 5901,
        imageCompression: 'off',
        jpegWanCompression: 'never',
        zlibGlzWanCompression: 'never',
        streamingVideo: 'off'
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('image-compression=off')
      expect(spiceArg).toContain('jpeg-wan-compression=never')
      expect(spiceArg).toContain('zlib-glz-wan-compression=never')
      expect(spiceArg).toContain('streaming-video=off')
    })
  })

  describe('GL acceleration', () => {
    it('adds gl=on and rendernode when GL is enabled with valid rendernode', () => {
      mockedFs.existsSync.mockReturnValue(true)

      const config = new SpiceConfig({
        port: 5901,
        gl: true,
        rendernode: '/dev/dri/renderD128'
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('gl=on')
      expect(spiceArg).toContain('rendernode=/dev/dri/renderD128')
    })

    it('adds gl=on without rendernode when not specified', () => {
      const config = new SpiceConfig({
        port: 5901,
        gl: true
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('gl=on')
      expect(spiceArg).not.toContain('rendernode=')
    })

    it('throws RENDERNODE_NOT_FOUND when rendernode path does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      expect(() => {
        new SpiceConfig({
          port: 5901,
          gl: true,
          rendernode: '/dev/dri/renderD999'
        })
      }).toThrow(DisplayError)

      try {
        new SpiceConfig({
          port: 5901,
          gl: true,
          rendernode: '/dev/dri/renderD999'
        })
      } catch (error) {
        expect(error).toBeInstanceOf(DisplayError)
        expect((error as DisplayError).code).toBe(DisplayErrorCode.RENDERNODE_NOT_FOUND)
      }
    })
  })

  describe('Authentication options', () => {
    it('includes password when provided', () => {
      const config = new SpiceConfig({
        port: 5901,
        password: 'secret123'
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('password=secret123')
    })

    it('includes disable-ticketing when set', () => {
      const config = new SpiceConfig({
        port: 5901,
        disableTicketing: true
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('disable-ticketing=on')
    })

    it('throws error when both password and disableTicketing are set', () => {
      expect(() => {
        new SpiceConfig({
          port: 5901,
          password: 'secret',
          disableTicketing: true
        })
      }).toThrow(DisplayError)
    })
  })

  describe('Agent options', () => {
    it('can disable agent', () => {
      const config = new SpiceConfig({
        port: 5901,
        enableAgent: false
      })

      expect(config.isAgentEnabled()).toBe(false)
    })

    it('includes disable-copy-paste when set', () => {
      const config = new SpiceConfig({
        port: 5901,
        disableCopyPaste: true
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('disable-copy-paste=on')
    })

    it('includes disable-agent-file-xfer when set', () => {
      const config = new SpiceConfig({
        port: 5901,
        disableAgentFileXfer: true
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('disable-agent-file-xfer=on')
    })
  })

  describe('Validation', () => {
    it('rejects invalid port', () => {
      expect(() => {
        new SpiceConfig({
          port: 1000 // Below SPICE_MIN_PORT (5900)
        })
      }).toThrow(DisplayError)
    })

    it('rejects port above max', () => {
      expect(() => {
        new SpiceConfig({
          port: 70000 // Above SPICE_MAX_PORT (65535)
        })
      }).toThrow(DisplayError)
    })

    it('rejects invalid address', () => {
      expect(() => {
        new SpiceConfig({
          port: 5901,
          addr: 'not-a-valid-address!'
        })
      }).toThrow(DisplayError)
    })

    it('rejects empty password string', () => {
      expect(() => {
        new SpiceConfig({
          port: 5901,
          password: ''
        })
      }).toThrow(DisplayError)
    })

    it('throws PORT_OUT_OF_RANGE with correct error code for port below minimum', () => {
      try {
        new SpiceConfig({ port: 1000 })
        fail('Expected DisplayError to be thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(DisplayError)
        expect((error as DisplayError).code).toBe(DisplayErrorCode.PORT_OUT_OF_RANGE)
      }
    })

    it('throws PORT_OUT_OF_RANGE with correct error code for port above maximum', () => {
      try {
        new SpiceConfig({ port: 70000 })
        fail('Expected DisplayError to be thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(DisplayError)
        expect((error as DisplayError).code).toBe(DisplayErrorCode.PORT_OUT_OF_RANGE)
      }
    })

    it('throws INVALID_PORT for non-integer port', () => {
      try {
        new SpiceConfig({ port: 5900.5 })
        fail('Expected DisplayError to be thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(DisplayError)
        expect((error as DisplayError).code).toBe(DisplayErrorCode.INVALID_PORT)
      }
    })

    it('throws INVALID_ADDRESS with correct error code', () => {
      try {
        new SpiceConfig({ port: 5901, addr: 'invalid!address' })
        fail('Expected DisplayError to be thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(DisplayError)
        expect((error as DisplayError).code).toBe(DisplayErrorCode.INVALID_ADDRESS)
      }
    })

    it('throws INVALID_PASSWORD for empty password string', () => {
      try {
        new SpiceConfig({ port: 5901, password: '' })
        fail('Expected DisplayError to be thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(DisplayError)
        expect((error as DisplayError).code).toBe(DisplayErrorCode.INVALID_PASSWORD)
      }
    })

    it('throws CONFLICTING_OPTIONS when both password and disableTicketing are set', () => {
      try {
        new SpiceConfig({ port: 5901, password: 'secret', disableTicketing: true })
        fail('Expected DisplayError to be thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(DisplayError)
        expect((error as DisplayError).code).toBe(DisplayErrorCode.CONFLICTING_OPTIONS)
      }
    })
  })

  describe('All valid image compression modes', () => {
    const validModes: SpiceImageCompression[] = ['auto_glz', 'auto_lz', 'quic', 'glz', 'lz', 'off']

    validModes.forEach(mode => {
      it(`accepts valid image compression mode: ${mode}`, () => {
        const config = new SpiceConfig({
          port: 5901,
          imageCompression: mode
        })

        const { args } = config.generateArgs()
        const spiceIndex = args.indexOf('-spice')
        const spiceArg = args[spiceIndex + 1]

        expect(spiceArg).toContain(`image-compression=${mode}`)
      })
    })
  })

  describe('All valid WAN compression modes', () => {
    const validModes: SpiceWanCompression[] = ['auto', 'never', 'always']

    validModes.forEach(mode => {
      it(`accepts valid JPEG WAN compression mode: ${mode}`, () => {
        const config = new SpiceConfig({
          port: 5901,
          jpegWanCompression: mode
        })

        const { args } = config.generateArgs()
        const spiceIndex = args.indexOf('-spice')
        const spiceArg = args[spiceIndex + 1]

        expect(spiceArg).toContain(`jpeg-wan-compression=${mode}`)
      })

      it(`accepts valid zlib-glz WAN compression mode: ${mode}`, () => {
        const config = new SpiceConfig({
          port: 5901,
          zlibGlzWanCompression: mode
        })

        const { args } = config.generateArgs()
        const spiceIndex = args.indexOf('-spice')
        const spiceArg = args[spiceIndex + 1]

        expect(spiceArg).toContain(`zlib-glz-wan-compression=${mode}`)
      })
    })
  })

  describe('All valid streaming video modes', () => {
    const validModes: SpiceStreamingMode[] = ['off', 'all', 'filter']

    validModes.forEach(mode => {
      it(`accepts valid streaming video mode: ${mode}`, () => {
        const config = new SpiceConfig({
          port: 5901,
          streamingVideo: mode
        })

        const { args } = config.generateArgs()
        const spiceIndex = args.indexOf('-spice')
        const spiceArg = args[spiceIndex + 1]

        expect(spiceArg).toContain(`streaming-video=${mode}`)
      })
    })
  })

  describe('All valid playback compression modes', () => {
    const validModes: SpicePlaybackCompression[] = ['on', 'off']

    validModes.forEach(mode => {
      it(`accepts valid playback compression mode: ${mode}`, () => {
        const config = new SpiceConfig({
          port: 5901,
          playbackCompression: mode
        })

        const { args } = config.generateArgs()
        const spiceIndex = args.indexOf('-spice')
        const spiceArg = args[spiceIndex + 1]

        expect(spiceArg).toContain(`playback-compression=${mode}`)
      })
    })
  })

  describe('Seamless migration option', () => {
    it('includes seamless-migration=on when enabled', () => {
      const config = new SpiceConfig({
        port: 5901,
        seamlessMigration: true
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('seamless-migration=on')
    })

    it('does not include seamless-migration when disabled (default)', () => {
      const config = new SpiceConfig({
        port: 5901
      })

      const { args } = config.generateArgs()
      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).not.toContain('seamless-migration')
    })
  })

  describe('Getter methods', () => {
    it('getPort() returns configured port', () => {
      const config = new SpiceConfig({ port: 5905 })
      expect(config.getPort()).toBe(5905)
    })

    it('getAddr() returns configured address', () => {
      const config = new SpiceConfig({ port: 5901, addr: '192.168.1.100' })
      expect(config.getAddr()).toBe('192.168.1.100')
    })

    it('getAddr() returns default address when not specified', () => {
      const config = new SpiceConfig({ port: 5901 })
      expect(config.getAddr()).toBe('0.0.0.0')
    })

    it('hasPassword() returns true when password is set', () => {
      const config = new SpiceConfig({ port: 5901, password: 'secret' })
      expect(config.hasPassword()).toBe(true)
    })

    it('hasPassword() returns false when password is not set', () => {
      const config = new SpiceConfig({ port: 5901 })
      expect(config.hasPassword()).toBe(false)
    })

    it('isAgentEnabled() returns true by default', () => {
      const config = new SpiceConfig({ port: 5901 })
      expect(config.isAgentEnabled()).toBe(true)
    })

    it('isAgentEnabled() returns false when disabled', () => {
      const config = new SpiceConfig({ port: 5901, enableAgent: false })
      expect(config.isAgentEnabled()).toBe(false)
    })
  })

  describe('Address validation variations', () => {
    it('accepts IPv4 address', () => {
      const config = new SpiceConfig({ port: 5901, addr: '192.168.1.1' })
      expect(config.getAddr()).toBe('192.168.1.1')
    })

    it('accepts localhost', () => {
      const config = new SpiceConfig({ port: 5901, addr: 'localhost' })
      expect(config.getAddr()).toBe('localhost')
    })

    it('accepts 0.0.0.0 (any address)', () => {
      const config = new SpiceConfig({ port: 5901, addr: '0.0.0.0' })
      expect(config.getAddr()).toBe('0.0.0.0')
    })

    it('accepts :: (IPv6 any)', () => {
      const config = new SpiceConfig({ port: 5901, addr: '::' })
      expect(config.getAddr()).toBe('::')
    })

    it('accepts ::1 (IPv6 localhost)', () => {
      const config = new SpiceConfig({ port: 5901, addr: '::1' })
      expect(config.getAddr()).toBe('::1')
    })

    it('accepts valid hostname', () => {
      const config = new SpiceConfig({ port: 5901, addr: 'my-server.local' })
      expect(config.getAddr()).toBe('my-server.local')
    })

    it('rejects empty address', () => {
      expect(() => {
        new SpiceConfig({ port: 5901, addr: '' })
      }).toThrow(DisplayError)
    })
  })

  describe('validate() method', () => {
    it('returns valid=true for valid configuration', () => {
      const config = new SpiceConfig({ port: 5901 })
      const result = config.validate()

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.validationErrors).toHaveLength(0)
    })

    it('returns structured validation errors with codes', () => {
      // We can't test invalid config directly since constructor throws
      // But we can verify that validate() returns proper structure for valid configs
      const config = new SpiceConfig({ port: 5901 })
      const result = config.validate()

      expect(result).toHaveProperty('valid')
      expect(result).toHaveProperty('errors')
      expect(result).toHaveProperty('validationErrors')
      expect(Array.isArray(result.errors)).toBe(true)
      expect(Array.isArray(result.validationErrors)).toBe(true)
    })
  })
})

describe('QemuCommandBuilder.addSpice()', () => {
  describe('with SpiceConfig', () => {
    it('adds SPICE args with default QXL (16MB)', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        addr: '0.0.0.0'
      })

      builder.addSpice(config)
      const args = builder.build()

      // Should have -spice argument
      expect(args).toContain('-spice')

      // Should have -vga qxl (default 16MB uses simple config)
      const vgaIndex = args.indexOf('-vga')
      expect(vgaIndex).toBeGreaterThanOrEqual(0)
      expect(args[vgaIndex + 1]).toBe('qxl')

      // Should NOT have -device qxl-vga for default memory
      const hasQxlDevice = args.some(arg => arg.includes('qxl-vga,vgamem_mb='))
      expect(hasQxlDevice).toBe(false)
    })

    it('replaces -vga qxl with -vga none and qxl-vga device for non-default QXL memory', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        addr: '0.0.0.0'
      })

      builder.addSpice(config, 64) // Non-default QXL memory
      const args = builder.build()

      // Should have -vga none to disable default VGA
      const vgaNoneIndex = args.indexOf('-vga')
      expect(vgaNoneIndex).toBeGreaterThanOrEqual(0)
      expect(args[vgaNoneIndex + 1]).toBe('none')

      // Should have -device qxl-vga with custom memory
      const qxlDeviceIndex = args.findIndex(arg => arg.includes('qxl-vga,vgamem_mb=64'))
      expect(qxlDeviceIndex).toBeGreaterThanOrEqual(0)

      // Should NOT have a second -vga qxl (the original should be removed)
      const vgaOccurrences = args.filter((arg, i) =>
        arg === '-vga' && args[i + 1] === 'qxl'
      ).length
      expect(vgaOccurrences).toBe(0)
    })

    it('adds virtio-serial and vdagent channel when agent is enabled', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        enableAgent: true
      })

      builder.addSpice(config)
      const args = builder.build()

      // Should have virtio-serial controller
      const hasVirtioSerial = args.some(arg => arg.includes('virtio-serial-pci'))
      expect(hasVirtioSerial).toBe(true)

      // Should have spice vdagent channel
      const hasVdagentPort = args.some(arg => arg.includes('com.redhat.spice.0'))
      expect(hasVdagentPort).toBe(true)

      // Should have chardev for spicevmc
      const hasSpiceVmc = args.some(arg => arg.includes('spicevmc'))
      expect(hasSpiceVmc).toBe(true)
    })

    it('does not add agent devices when agent is disabled', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        enableAgent: false
      })

      builder.addSpice(config)
      const args = builder.build()

      // Should NOT have spice vdagent channel (from addSpice)
      // Note: virtio-serial might be added by other methods
      const hasVdagentPort = args.some(arg => arg.includes('com.redhat.spice.0'))
      expect(hasVdagentPort).toBe(false)
    })

    it('handles 4K resolution with 64MB QXL memory', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901
      })

      builder.addSpice(config, 64)
      const args = builder.build()

      // Should have -vga none
      expect(args[args.indexOf('-vga') + 1]).toBe('none')

      // Should have device with 64MB
      const qxlArg = args.find(arg => arg.includes('qxl-vga,vgamem_mb=64'))
      expect(qxlArg).toBeDefined()
    })

    it('handles multiple 4K displays with 128MB QXL memory', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901
      })

      builder.addSpice(config, 128)
      const args = builder.build()

      // Should have device with 128MB
      const qxlArg = args.find(arg => arg.includes('qxl-vga,vgamem_mb=128'))
      expect(qxlArg).toBeDefined()
    })
  })

  describe('with legacy SpiceOptions', () => {
    it('adds SPICE args with default QXL', () => {
      const builder = new QemuCommandBuilder()

      builder.addSpice({
        port: 5901,
        addr: '0.0.0.0'
      })
      const args = builder.build()

      // Should have -spice argument
      const spiceIndex = args.indexOf('-spice')
      expect(spiceIndex).toBeGreaterThanOrEqual(0)
      expect(args[spiceIndex + 1]).toContain('port=5901')

      // Should have -vga qxl for default 16MB
      const vgaIndex = args.indexOf('-vga')
      expect(vgaIndex).toBeGreaterThanOrEqual(0)
      expect(args[vgaIndex + 1]).toBe('qxl')
    })

    it('adds qxl-vga device for non-default QXL memory in legacy mode', () => {
      const builder = new QemuCommandBuilder()

      builder.addSpice({
        port: 5901,
        addr: '0.0.0.0'
      }, 64)
      const args = builder.build()

      // Should have -device qxl-vga with custom memory (legacy mode doesn't add -vga none)
      const qxlDeviceIndex = args.findIndex(arg => arg.includes('qxl-vga,vgamem_mb=64'))
      expect(qxlDeviceIndex).toBeGreaterThanOrEqual(0)

      // Should NOT have -vga qxl (legacy non-default path doesn't add it)
      const vgaQxlIndex = args.findIndex((arg, i) =>
        arg === '-vga' && args[i + 1] === 'qxl'
      )
      expect(vgaQxlIndex).toBe(-1)
    })

    it('includes password in legacy mode', () => {
      const builder = new QemuCommandBuilder()

      builder.addSpice({
        port: 5901,
        addr: '0.0.0.0',
        password: 'test123'
      })
      const args = builder.build()

      const spiceIndex = args.indexOf('-spice')
      expect(args[spiceIndex + 1]).toContain('password=test123')
    })

    it('includes disable-ticketing in legacy mode', () => {
      const builder = new QemuCommandBuilder()

      builder.addSpice({
        port: 5901,
        addr: '0.0.0.0',
        disableTicketing: true
      })
      const args = builder.build()

      const spiceIndex = args.indexOf('-spice')
      expect(args[spiceIndex + 1]).toContain('disable-ticketing=on')
    })

    it('adds virtio-serial for guest agent by default in legacy mode', () => {
      const builder = new QemuCommandBuilder()

      builder.addSpice({
        port: 5901,
        addr: '0.0.0.0'
      })
      const args = builder.build()

      // Should have virtio-serial controller
      const hasVirtioSerial = args.some(arg => arg.includes('virtio-serial-pci'))
      expect(hasVirtioSerial).toBe(true)

      // Should have spice vdagent channel
      const hasVdagentPort = args.some(arg => arg.includes('com.redhat.spice.0'))
      expect(hasVdagentPort).toBe(true)
    })

    it('can disable agent in legacy mode', () => {
      const builder = new QemuCommandBuilder()

      builder.addSpice({
        port: 5901,
        addr: '0.0.0.0',
        enableAgent: false
      })
      const args = builder.build()

      // Should NOT have spice vdagent channel
      const hasVdagentPort = args.some(arg => arg.includes('com.redhat.spice.0'))
      expect(hasVdagentPort).toBe(false)
    })
  })

  describe('VGA device configuration', () => {
    it('ensures only one VGA device exists when using non-default QXL memory', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901
      })

      builder.addSpice(config, 64)
      const args = builder.build()

      // Count all VGA-related entries
      let vgaCount = 0
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-vga') {
          vgaCount++
        }
      }

      // Should have exactly one -vga argument (set to 'none')
      expect(vgaCount).toBe(1)

      // The -vga should be 'none'
      const vgaIndex = args.indexOf('-vga')
      expect(args[vgaIndex + 1]).toBe('none')

      // Should have exactly one qxl-vga device
      const qxlDevices = args.filter(arg => arg.includes('qxl-vga'))
      expect(qxlDevices.length).toBe(1)
    })

    it('uses simple -vga qxl for default 16MB configuration', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901
      })

      builder.addSpice(config) // default 16MB
      const args = builder.build()

      // Should have -vga qxl
      const vgaIndex = args.indexOf('-vga')
      expect(args[vgaIndex + 1]).toBe('qxl')

      // Should NOT have -device qxl-vga
      const hasQxlDevice = args.some(arg => arg.includes('qxl-vga,vgamem_mb='))
      expect(hasQxlDevice).toBe(false)
    })
  })

  describe('SPICE optimization args integration', () => {
    it('includes all compression options in SPICE arg string', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        imageCompression: 'glz',
        jpegWanCompression: 'always',
        zlibGlzWanCompression: 'always',
        streamingVideo: 'all',
        playbackCompression: 'off'
      })

      builder.addSpice(config)
      const args = builder.build()

      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      // Verify all options are in single SPICE arg string
      expect(spiceArg).toContain('image-compression=glz')
      expect(spiceArg).toContain('jpeg-wan-compression=always')
      expect(spiceArg).toContain('zlib-glz-wan-compression=always')
      expect(spiceArg).toContain('streaming-video=all')
      expect(spiceArg).toContain('playback-compression=off')
    })

    it('includes GL options in SPICE arg string when enabled', () => {
      mockedFs.existsSync.mockReturnValue(true)

      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        gl: true,
        rendernode: '/dev/dri/renderD128'
      })

      builder.addSpice(config)
      const args = builder.build()

      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('gl=on')
      expect(spiceArg).toContain('rendernode=/dev/dri/renderD128')
    })

    it('includes agent options in SPICE arg string', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        disableCopyPaste: true,
        disableAgentFileXfer: true,
        seamlessMigration: true
      })

      builder.addSpice(config)
      const args = builder.build()

      const spiceIndex = args.indexOf('-spice')
      const spiceArg = args[spiceIndex + 1]

      expect(spiceArg).toContain('disable-copy-paste=on')
      expect(spiceArg).toContain('disable-agent-file-xfer=on')
      expect(spiceArg).toContain('seamless-migration=on')
    })
  })

  describe('QXL memory override ordering', () => {
    it('places -vga none before qxl-vga device when using custom memory', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({ port: 5901 })

      builder.addSpice(config, 64)
      const args = builder.build()

      const vgaNoneIndex = args.indexOf('-vga')
      const qxlDeviceIndex = args.findIndex(arg => arg.includes('qxl-vga,vgamem_mb='))

      // -vga none should appear before the qxl-vga device
      expect(vgaNoneIndex).toBeLessThan(qxlDeviceIndex)
      expect(args[vgaNoneIndex + 1]).toBe('none')
    })

    it('supports various QXL memory sizes: 32MB', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({ port: 5901 })

      builder.addSpice(config, 32)
      const args = builder.build()

      const qxlArg = args.find(arg => arg.includes('qxl-vga,vgamem_mb=32'))
      expect(qxlArg).toBeDefined()
    })

    it('supports various QXL memory sizes: 256MB', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({ port: 5901 })

      builder.addSpice(config, 256)
      const args = builder.build()

      const qxlArg = args.find(arg => arg.includes('qxl-vga,vgamem_mb=256'))
      expect(qxlArg).toBeDefined()
    })
  })

  describe('Builder chaining', () => {
    it('allows chaining addSpice with other methods', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({ port: 5901 })

      const result = builder
        .enableKvm()
        .setMachine('q35')
        .setCpu('host', 4)
        .setMemory(8)
        .addSpice(config)
        .addQmp('/var/run/qemu/test.sock')

      expect(result).toBe(builder) // Returns this for chaining

      const args = builder.build()

      // Verify all options are present
      expect(args).toContain('-enable-kvm')
      expect(args).toContain('-machine')
      expect(args).toContain('-spice')
      expect(args).toContain('-qmp')
    })

    it('correctly handles SPICE with all other common options', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        password: 'test123',
        enableAgent: true
      })

      builder
        .enableKvm()
        .setMachine('q35')
        .setCpu('host', 4)
        .setMemory(8)
        .addSpice(config, 64)
        .addUsbTablet()
        .addAudioDevice()

      const args = builder.build()

      // Verify SPICE configuration
      expect(args).toContain('-spice')
      expect(args[args.indexOf('-vga') + 1]).toBe('none')

      // Verify other devices
      expect(args.some(arg => arg.includes('usb-tablet'))).toBe(true)
      expect(args.some(arg => arg.includes('intel-hda'))).toBe(true)

      // Verify agent channel is present
      expect(args.some(arg => arg.includes('com.redhat.spice.0'))).toBe(true)
    })
  })

  describe('Shared virtio-serial controller', () => {
    it('adds only one virtio-serial controller when agent is enabled', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        enableAgent: true
      })

      builder.addSpice(config)
      const args = builder.build()

      // Count virtio-serial-pci occurrences
      const virtioSerialCount = args.filter(arg => arg.includes('virtio-serial-pci')).length
      expect(virtioSerialCount).toBe(1)
    })

    it('shares virtio-serial controller with guest agent channel', () => {
      const builder = new QemuCommandBuilder()
      const config = new SpiceConfig({
        port: 5901,
        enableAgent: true
      })

      builder
        .addSpice(config)
        .addGuestAgentChannel('/var/run/qemu/ga.sock')

      const args = builder.build()

      // Should still have only one virtio-serial controller
      const virtioSerialCount = args.filter(arg => arg.includes('virtio-serial-pci')).length
      expect(virtioSerialCount).toBe(1)

      // Should have both SPICE vdagent and guest agent channels
      expect(args.some(arg => arg.includes('com.redhat.spice.0'))).toBe(true)
      expect(args.some(arg => arg.includes('org.qemu.guest_agent.0'))).toBe(true)
    })
  })
})
