/**
 * Driver Presets Configuration Module
 *
 * This module defines OS-specific QEMU driver configurations that optimize
 * VM performance based on the target operating system. These presets are
 * automatically applied during VM creation when the `os` field is provided.
 *
 * **Fallback Chain**: explicit config → OS preset → hardcoded defaults
 *
 * ## Preset Rationale
 *
 * ### Windows Preset
 * - **diskCacheMode: 'none'**: NTFS uses its own caching layer; disabling QEMU's
 *   cache prevents double-caching and ensures data integrity on power loss
 * - **networkQueues: 4**: Windows virtio drivers benefit from parallel packet
 *   processing on multi-core systems
 * - **displayProtocol: 'spice'**: Better clipboard, audio, and USB redirection
 *
 * ### Linux Preset
 * - **diskCacheMode: 'writeback'**: Safe with ext4/XFS journaling; provides
 *   performance benefit without significant crash risk
 * - **networkQueues: 2**: Balanced performance; Linux handles multi-queue well
 * - **displayProtocol: 'spice'**: Full feature support with spice-vdagent
 *
 * ### Legacy Preset
 * - **diskBus: 'ide'**: Maximum compatibility for DOS, older Windows, and BSDs
 * - **networkModel: 'e1000'**: Intel gigabit emulation works without guest drivers
 * - **displayProtocol: 'vnc'**: Simpler protocol without agent requirements
 *
 * ## Usage
 *
 * ```typescript
 * import { detectOSType, getDriverPreset } from './config/DriverPresets'
 *
 * const osType = detectOSType(config.os)  // e.g., 'ubuntu' -> 'linux'
 * const preset = getDriverPreset(osType)
 *
 * // Apply with fallback chain
 * const diskCacheMode = config.diskCacheMode ?? preset.diskCacheMode ?? DEFAULT_DISK_CACHE
 * ```
 *
 * ## Overriding Presets
 *
 * Explicit values in `VMCreateConfig` always take precedence:
 * ```typescript
 * {
 *   os: 'windows10',           // Triggers Windows preset
 *   diskCacheMode: 'writeback' // Overrides preset's 'none'
 * }
 * ```
 */

import {
  DEFAULT_DISK_BUS,
  DEFAULT_DISK_CACHE,
  DEFAULT_NETWORK_MODEL,
  DisplayProtocol
} from '../types/lifecycle.types'

// =============================================================================
// Types
// =============================================================================

/**
 * OS category types for driver preset selection.
 *
 * - 'windows': Modern Windows (7, 8, 10, 11, Server) with virtio driver support
 * - 'linux': Linux distributions with native virtio support
 * - 'legacy': Older OSes without virtio drivers (DOS, older Windows, BSDs)
 * - 'default': Fallback when OS cannot be detected
 */
export type OSType = 'windows' | 'linux' | 'legacy' | 'default'

/**
 * VM driver preset configuration.
 *
 * These values are applied when the corresponding `VMCreateConfig` field is undefined.
 * All fields are required - each preset must provide complete driver configuration.
 *
 * **Note on networkQueues**: This field is NOT used to override `VMCreateConfig.networkQueues`.
 * Network queue count is always auto-calculated as `min(cpuCores, 4)` unless explicitly
 * specified in `VMCreateConfig`. This field exists only for documentation and potential
 * future use cases where OS-specific queue recommendations may be surfaced to users.
 *
 * **Note on displayProtocol**: This field is advisory only. It indicates the recommended
 * display protocol for the OS but does NOT override `VMCreateConfig.displayType`, which
 * is a required field. Consumers may use this value for UI suggestions or documentation.
 */
export interface VMDriverPreset {
  /** Disk bus type: virtio (fast), scsi, ide, sata (compatible) */
  diskBus: 'virtio' | 'scsi' | 'ide' | 'sata'
  /**
   * Disk cache mode:
   * - 'none': Direct I/O, safest for crash recovery (Windows recommended)
   * - 'writeback': Performance with journaling FS (Linux recommended)
   * - 'writethrough': Conservative, slower
   * - 'unsafe': Maximum speed, data loss risk
   */
  diskCacheMode: 'writeback' | 'writethrough' | 'none' | 'unsafe'
  /** Network device model: virtio-net-pci (fast) or e1000 (compatible) */
  networkModel: 'virtio-net-pci' | 'e1000'
  /**
   * Recommended number of network queues for this OS type.
   *
   * **Advisory only**: This value is NOT automatically applied. Network queue count
   * is always auto-calculated as `min(cpuCores, 4)` unless explicitly overridden
   * in `VMCreateConfig.networkQueues`. This field exists for documentation and
   * to inform users of OS-specific recommendations.
   */
  networkQueues: number
  /**
   * Recommended display protocol for this OS type.
   *
   * **Advisory only**: This value does NOT override `VMCreateConfig.displayType`,
   * which remains a required field. This field exists for documentation and to
   * inform UI/tooling of OS-specific recommendations (e.g., suggesting SPICE for
   * Windows/Linux, VNC for legacy systems).
   */
  displayProtocol: DisplayProtocol
}

// =============================================================================
// Preset Definitions
// =============================================================================

/**
 * Driver presets indexed by OS type.
 *
 * Each preset is optimized for the target OS's typical usage patterns
 * and driver support level.
 */
export const DRIVER_PRESETS: Record<OSType, VMDriverPreset> = {
  /**
   * Windows preset: Optimized for Windows 7 and later with virtio drivers.
   *
   * - cache=none: Prevents data corruption with NTFS. Windows handles its own
   *   caching, and QEMU's writeback cache can cause filesystem corruption on
   *   unexpected power loss since NTFS doesn't journal data blocks.
   * - queues=4: Windows virtio drivers support multi-queue well; 4 queues
   *   provides optimal balance for most multi-core configurations.
   * - spice: Better integration with Windows (clipboard, audio, USB redirection).
   */
  windows: {
    diskBus: 'virtio',
    diskCacheMode: 'none',
    networkModel: 'virtio-net-pci',
    networkQueues: 4,
    displayProtocol: 'spice'
  },

  /**
   * Linux preset: Optimized for modern Linux distributions.
   *
   * - cache=writeback: Safe with ext4/XFS journaling. These filesystems protect
   *   metadata and can recover from crashes. Writeback provides ~30% I/O boost.
   * - queues=2: Linux handles multi-queue efficiently, but 2 queues provides
   *   good performance without excessive overhead for typical workloads.
   * - spice: Full support via spice-vdagent for clipboard, resize, etc.
   */
  linux: {
    diskBus: 'virtio',
    diskCacheMode: 'writeback',
    networkModel: 'virtio-net-pci',
    networkQueues: 2,
    displayProtocol: 'spice'
  },

  /**
   * Legacy preset: Maximum compatibility for older operating systems.
   *
   * - diskBus=ide: Works without any guest drivers. Required for DOS, Win9x,
   *   and some BSDs that don't have virtio support.
   * - cache=writethrough: Conservative choice for filesystems without journaling.
   * - e1000: Intel gigabit emulation works out-of-box on most OSes.
   * - queues=1: Legacy OSes don't support multi-queue.
   * - vnc: Simpler protocol that works without guest agents.
   */
  legacy: {
    diskBus: 'ide',
    diskCacheMode: 'writethrough',
    networkModel: 'e1000',
    networkQueues: 1,
    displayProtocol: 'vnc'
  },

  /**
   * Default preset: Used when OS cannot be detected.
   *
   * Uses safe defaults that work with most modern operating systems.
   * Mirrors the Linux preset as virtio has the widest modern support.
   */
  default: {
    diskBus: DEFAULT_DISK_BUS as 'virtio',
    diskCacheMode: DEFAULT_DISK_CACHE as 'writeback',
    networkModel: DEFAULT_NETWORK_MODEL as 'virtio-net-pci',
    networkQueues: 2,
    displayProtocol: 'spice'
  }
}

// =============================================================================
// OS Detection Patterns
// =============================================================================

/**
 * Pattern matchers for OS type detection.
 *
 * Order matters: more specific patterns should come before general ones.
 * All matching is case-insensitive.
 */
const OS_PATTERNS: Array<{ pattern: RegExp; type: OSType }> = [
  // Windows patterns (before generic 'win' to avoid false matches)
  { pattern: /windows\s*(\d+|xp|vista|server|nt)/i, type: 'windows' },
  { pattern: /^win(\d+|xp|vista|server|nt)/i, type: 'windows' },
  { pattern: /^windows$/i, type: 'windows' },

  // Legacy Windows (DOS-era, Win9x)
  { pattern: /dos/i, type: 'legacy' },
  { pattern: /freedos/i, type: 'legacy' },
  { pattern: /win(95|98|me|3\.)/i, type: 'legacy' },
  { pattern: /windows\s*(95|98|me|3\.)/i, type: 'legacy' },

  // BSD variants (often need legacy drivers)
  { pattern: /freebsd/i, type: 'legacy' },
  { pattern: /openbsd/i, type: 'legacy' },
  { pattern: /netbsd/i, type: 'legacy' },
  { pattern: /dragonfly/i, type: 'legacy' },

  // Linux distributions
  { pattern: /ubuntu/i, type: 'linux' },
  { pattern: /debian/i, type: 'linux' },
  { pattern: /fedora/i, type: 'linux' },
  { pattern: /centos/i, type: 'linux' },
  { pattern: /rhel/i, type: 'linux' },
  { pattern: /redhat/i, type: 'linux' },
  { pattern: /rocky/i, type: 'linux' },
  { pattern: /alma/i, type: 'linux' },
  { pattern: /arch/i, type: 'linux' },
  { pattern: /manjaro/i, type: 'linux' },
  { pattern: /opensuse/i, type: 'linux' },
  { pattern: /suse/i, type: 'linux' },
  { pattern: /gentoo/i, type: 'linux' },
  { pattern: /slackware/i, type: 'linux' },
  { pattern: /mint/i, type: 'linux' },
  { pattern: /pop[_!]?os/i, type: 'linux' },
  { pattern: /elementary/i, type: 'linux' },
  { pattern: /kali/i, type: 'linux' },
  { pattern: /parrot/i, type: 'linux' },
  { pattern: /nixos/i, type: 'linux' },
  { pattern: /void/i, type: 'linux' },
  { pattern: /alpine/i, type: 'linux' },
  { pattern: /^linux$/i, type: 'linux' },
  { pattern: /linux/i, type: 'linux' },

  // macOS/Darwin (legacy drivers recommended for Hackintosh)
  { pattern: /macos/i, type: 'legacy' },
  { pattern: /darwin/i, type: 'legacy' },
  { pattern: /osx/i, type: 'legacy' }
]

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Detects the OS type category from an OS name string.
 *
 * Uses case-insensitive pattern matching to categorize the OS into
 * one of the preset groups: 'windows', 'linux', 'legacy', or 'default'.
 *
 * @param osString - The OS identifier (e.g., 'Ubuntu 22.04', 'Windows 11', 'FreeDOS')
 * @returns The detected OS type for preset selection
 *
 * @example
 * detectOSType('ubuntu')        // -> 'linux'
 * detectOSType('Ubuntu 22.04')  // -> 'linux'
 * detectOSType('Windows 11')    // -> 'windows'
 * detectOSType('windows10')     // -> 'windows'
 * detectOSType('FreeDOS')       // -> 'legacy'
 * detectOSType('FreeBSD 14')    // -> 'legacy'
 * detectOSType('unknown')       // -> 'default'
 */
export function detectOSType (osString: string | null | undefined): OSType {
  if (!osString || osString.trim().length === 0) {
    return 'default'
  }

  const normalizedOs = osString.trim()

  for (const { pattern, type } of OS_PATTERNS) {
    if (pattern.test(normalizedOs)) {
      return type
    }
  }

  return 'default'
}

/**
 * Retrieves the driver preset for a given OS type.
 *
 * @param osType - The OS type category ('windows', 'linux', 'legacy', 'default')
 * @returns The driver preset configuration for that OS type
 *
 * @example
 * const preset = getDriverPreset('windows')
 * // preset.diskCacheMode === 'none'
 * // preset.networkQueues === 4
 *
 * const preset = getDriverPreset('linux')
 * // preset.diskCacheMode === 'writeback'
 * // preset.networkQueues === 2
 */
export function getDriverPreset (osType: OSType): VMDriverPreset {
  return DRIVER_PRESETS[osType] ?? DRIVER_PRESETS.default
}

/**
 * Convenience function that combines OS detection and preset lookup.
 *
 * @param osString - The OS identifier string from VMCreateConfig.os
 * @returns The driver preset for the detected OS type
 *
 * @example
 * const preset = getDriverPresetForOS('Windows 11')
 * // Automatically detects 'windows' type and returns Windows preset
 */
export function getDriverPresetForOS (osString: string | null | undefined): VMDriverPreset {
  const osType = detectOSType(osString)
  return getDriverPreset(osType)
}
