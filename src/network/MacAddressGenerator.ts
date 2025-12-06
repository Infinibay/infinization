import { createHash } from 'crypto'
import { QEMU_MAC_PREFIX, MacAddress } from '../types/network.types'

/**
 * MacAddressGenerator generates QEMU-compatible MAC addresses.
 * All methods are static - no instance needed.
 *
 * @example
 * // Random MAC
 * const mac = MacAddressGenerator.generate()
 * // => "52:54:00:a3:b2:c1"
 *
 * // Deterministic MAC from VM ID
 * const mac = MacAddressGenerator.generateFromVmId('abc123')
 * // => "52:54:00:ab:c1:23"
 *
 * // Validate MAC
 * MacAddressGenerator.validate('52:54:00:a3:b2:c1') // => true
 * MacAddressGenerator.validate('invalid') // => false
 *
 * // Check if QEMU MAC
 * MacAddressGenerator.isQemuMac('52:54:00:a3:b2:c1') // => true
 * MacAddressGenerator.isQemuMac('00:11:22:33:44:55') // => false
 */
export class MacAddressGenerator {
  /** MAC address validation regex */
  private static readonly MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/

  /**
   * Generates a random MAC address with QEMU prefix (52:54:00:xx:xx:xx)
   * @returns A random QEMU-compatible MAC address
   */
  static generate (): MacAddress {
    const octets = [
      MacAddressGenerator.randomByte(),
      MacAddressGenerator.randomByte(),
      MacAddressGenerator.randomByte()
    ]
    return `${QEMU_MAC_PREFIX}:${octets.join(':')}`
  }

  /**
   * Generates a deterministic MAC address from a VM ID.
   * Same VM ID always produces the same MAC address.
   * @param vmId - The VM identifier
   * @returns A deterministic QEMU-compatible MAC address
   */
  static generateFromVmId (vmId: string): MacAddress {
    const hexString = MacAddressGenerator.hashVmId(vmId)
    const octets = [
      hexString.substring(0, 2),
      hexString.substring(2, 4),
      hexString.substring(4, 6)
    ]
    return `${QEMU_MAC_PREFIX}:${octets.join(':')}`
  }

  /**
   * Validates a MAC address format
   * @param mac - The MAC address to validate
   * @returns true if valid format, false otherwise
   */
  static validate (mac: string): boolean {
    return MacAddressGenerator.MAC_REGEX.test(mac)
  }

  /**
   * Checks if a MAC address is a QEMU MAC (starts with 52:54:00)
   * @param mac - The MAC address to check
   * @returns true if it's a QEMU MAC, false otherwise
   */
  static isQemuMac (mac: string): boolean {
    if (!MacAddressGenerator.validate(mac)) {
      return false
    }
    return mac.toLowerCase().startsWith(QEMU_MAC_PREFIX.toLowerCase())
  }

  /**
   * Generates a random byte as a 2-digit hex string
   * @returns A 2-character hex string (e.g., "0a", "ff")
   */
  private static randomByte (): string {
    const byte = Math.floor(Math.random() * 256)
    return byte.toString(16).padStart(2, '0')
  }

  /**
   * Creates a hash of the VM ID and returns the first 6 hex characters.
   * If vmId is already valid hex (12+ chars), uses it directly.
   * @param vmId - The VM identifier
   * @returns First 6 hex characters of the hash or vmId
   */
  private static hashVmId (vmId: string): string {
    // Check if vmId is already valid hex with at least 6 characters
    const hexRegex = /^[0-9a-fA-F]+$/
    if (hexRegex.test(vmId) && vmId.length >= 6) {
      return vmId.substring(0, 6).toLowerCase()
    }

    // Otherwise, hash the vmId
    const hash = createHash('md5').update(vmId).digest('hex')
    return hash.substring(0, 6)
  }
}
