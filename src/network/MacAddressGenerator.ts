import { createHash, randomBytes } from 'crypto'
import { MacAddress } from '../types/network.types'

/**
 * Locally-administered, unicast 2-octet prefix for generated MACs.
 *
 * `52` = 0101_0010b: the locally-administered bit (bit 1) is set and the multicast
 * bit (bit 0) is clear (unicast) — the well-known KVM/QEMU family. We keep only the
 * first TWO octets fixed (not three) so generated MACs carry 32 bits of entropy
 * instead of 24. At 24 bits a birthday collision is ~50% near ~4,800 VMs on a
 * segment; 32 bits pushes that to ~77,000 while staying recognizably QEMU-family.
 *
 * Note: MACs are derived deterministically from the vmId and are NOT persisted. For
 * guaranteed uniqueness at very large scale, persist the MAC with a DB unique
 * constraint (a documented follow-up); per-department bridges keep real per-segment
 * VM counts well below the collision threshold.
 */
const LOCALLY_ADMINISTERED_PREFIX = '52:54'

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
   * Generates a random MAC address in the locally-administered QEMU family
   * (52:54:xx:xx:xx:xx) using a CSPRNG.
   * @returns A random QEMU-compatible MAC address
   */
  static generate (): MacAddress {
    return `${LOCALLY_ADMINISTERED_PREFIX}:${MacAddressGenerator.octetsFromHex(randomBytes(4).toString('hex'))}`
  }

  /**
   * Generates a deterministic MAC address from a VM ID.
   * Same VM ID always produces the same MAC address.
   *
   * Derived from SHA-256 of the FULL vmId (32 bits of suffix entropy), not a 24-bit
   * MD5 prefix, to make cross-VM MAC collisions far less likely (see
   * LOCALLY_ADMINISTERED_PREFIX).
   *
   * @param vmId - The VM identifier
   * @returns A deterministic QEMU-compatible MAC address
   */
  static generateFromVmId (vmId: string): MacAddress {
    const hexString = createHash('sha256').update(vmId).digest('hex')
    return `${LOCALLY_ADMINISTERED_PREFIX}:${MacAddressGenerator.octetsFromHex(hexString)}`
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
   * Checks if a MAC address is a QEMU-family MAC (locally-administered 52:54 prefix).
   * Accepts both the legacy 52:54:00 form and the wider 52:54:xx form.
   * @param mac - The MAC address to check
   * @returns true if it's a QEMU-family MAC, false otherwise
   */
  static isQemuMac (mac: string): boolean {
    if (!MacAddressGenerator.validate(mac)) {
      return false
    }
    return mac.toLowerCase().startsWith(`${LOCALLY_ADMINISTERED_PREFIX.toLowerCase()}:`)
  }

  /**
   * Formats the first 4 bytes of a hex string as 4 colon-separated MAC octets.
   * @param hex - A hex string with at least 8 characters
   * @returns "xx:xx:xx:xx"
   */
  private static octetsFromHex (hex: string): string {
    return [
      hex.substring(0, 2),
      hex.substring(2, 4),
      hex.substring(4, 6),
      hex.substring(6, 8)
    ].join(':')
  }
}
