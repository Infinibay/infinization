/**
 * Configuration Type Definitions (Consolidated)
 *
 * This file provides a consolidated hub for all configuration-related types.
 * It re-exports types from specialized modules and defines new unified types
 * for comprehensive VM configuration management.
 *
 * @module types/config
 *
 * @example
 * ```typescript
 * // Import consolidated configuration types
 * import {
 *   DisplayConfig,
 *   NetworkConfig,
 *   StorageConfig,
 *   QemuConfig,
 *   VMCompleteConfig
 * } from '@infinibay/infinivirt'
 *
 * // Create a complete VM configuration
 * const config: VMCompleteConfig = {
 *   vm: { id: 'vm-123', name: 'my-vm', internalName: 'vm-abc' },
 *   display: { type: 'spice', port: 5901 },
 *   network: { bridge: 'virbr0' },
 *   storage: { path: '/var/lib/infinivirt/disks/vm-abc.qcow2', sizeGB: 50 }
 * }
 * ```
 */

// =============================================================================
// Imports for type references (to avoid circular imports, import types only)
// =============================================================================

import path from 'path'
import type {
  MachineType,
  DiskBus,
  CacheMode,
  DisplayType,
  BootDevice
} from './qemu.types'

import type { NetworkOptions as QemuNetworkOptions } from './qemu.types'
import { validatePciAddress } from './qemu.types'

/** Allowed directory for GPU ROM files */
const ALLOWED_ROM_DIR = '/var/lib/infinivirt/roms/'

// Import VM resource constants from vm.types to centralize limits
import {
  DEFAULT_VM_CPU_CORES,
  DEFAULT_VM_RAM_GB,
  DEFAULT_VM_DISK_SIZE_GB,
  MIN_VM_CPU_CORES,
  MAX_VM_CPU_CORES,
  MIN_VM_RAM_GB,
  MAX_VM_RAM_GB,
  MIN_VM_DISK_SIZE_GB,
  MAX_VM_DISK_SIZE_GB
} from './vm.types'

// =============================================================================
// Re-exports from QEMU Types
// =============================================================================

export {
  /** Machine type union for QEMU -machine option */
  MachineType,
  /** Disk bus type for QEMU -drive if= option */
  DiskBus,
  /** Cache mode for QEMU -drive cache= option */
  CacheMode,
  /** Display type for graphics output */
  DisplayType,
  /** VGA type for QEMU -vga option */
  VgaType,
  /** Boot device for QEMU -boot order= option */
  BootDevice,
  /** Options for QEMU -machine option */
  MachineOptions,
  /** Options for disk configuration */
  DiskOptions,
  /** Options for network configuration */
  NetworkOptions,
  /** Options for SPICE display */
  SpiceOptions,
  /** Options for VNC display */
  VncOptions,
  /** Options for QEMU process management */
  QemuProcessOptions
} from './qemu.types'

// =============================================================================
// Helper Types (derived from existing types to avoid duplication)
// =============================================================================

/**
 * Display type for VM configuration (excludes 'none' from DisplayType).
 * Use this for VM display configurations where a display is required.
 */
export type VMDisplayType = Exclude<DisplayType, 'none'>

/**
 * Network model type extracted from NetworkOptions.
 * Ensures consistency with QEMU network configuration.
 */
export type NetworkModel = QemuNetworkOptions['model']

/**
 * Storage format type for disk images.
 * Subset of formats supported for VM disk creation.
 */
export type StorageFormat = 'qcow2' | 'raw'

// =============================================================================
// Re-exports from Display Types
// =============================================================================

export {
  /** Configuration options for SPICE display */
  SpiceConfigOptions,
  /** Configuration options for VNC display */
  VncConfigOptions,
  /** Structured validation error with code and message */
  ValidationError,
  /** Result of display configuration validation */
  DisplayValidationResult,
  /** Generated QEMU command arguments for display configuration */
  DisplayCommandArgs,
  /** Error codes for display configuration validation */
  DisplayErrorCode,
  /** Error class for display configuration errors */
  DisplayError
} from './display.types'

// =============================================================================
// Re-exports from Network Types
// =============================================================================

export {
  /** Configuration for creating a TAP device */
  TapDeviceConfig,
  /** Information about an existing TAP device */
  TapDeviceInfo,
  /** Configuration for creating a network bridge */
  BridgeConfig,
  /** Information about an existing network bridge */
  BridgeInfo,
  /** Network device state enumeration */
  NetworkDeviceState,
  /** Network error codes for structured error handling */
  NetworkErrorCode,
  /** Structured error for network device operations */
  NetworkDeviceError,
  /** Type alias for MAC address strings */
  MacAddress
} from './network.types'

// =============================================================================
// Re-exports from Storage Types
// =============================================================================

export {
  /** Image format type alias */
  ImageFormat,
  /** Storage error codes for structured error handling */
  StorageErrorCode,
  /** Information about a disk image */
  ImageInfo,
  /** Information about a snapshot */
  SnapshotInfo,
  /** Result of image integrity check */
  ImageCheckResult,
  /** Configuration for creating a disk image */
  CreateImageOptions,
  /** Configuration for converting a disk image */
  ConvertImageOptions,
  /** Configuration for creating a snapshot */
  SnapshotCreateOptions,
  /** Error class for storage operations */
  StorageError,
  /** Structured error for storage operations */
  StorageErrorInfo,
  /** Type guard to check if a format string is a valid ImageFormat */
  isValidImageFormat
} from './storage.types'

// =============================================================================
// Re-exports from Firewall Types
// =============================================================================

export {
  /** Configuration for applying firewall rules to a VM */
  VMFirewallConfig,
  /** Input interface for firewall rules (matches Prisma FirewallRule model) */
  FirewallRuleInput,
  /** Connection state configuration for stateful firewall rules */
  ConnectionStateConfig,
  /** Statistics for applied firewall rules */
  FirewallApplyResult,
  /** Result of translating a Prisma FirewallRule to nftables syntax */
  FirewallRuleTranslation
} from './firewall.types'

// =============================================================================
// Re-exports from Lifecycle Types
// =============================================================================

export {
  /** Configuration for Infinivirt main class */
  InfinivirtConfig,
  /** Minimal interface for backend EventManager integration */
  EventManagerLike,
  /** Resources tracked by the active VMs map */
  ActiveVMResources
} from './lifecycle.types'

// =============================================================================
// Re-exports from Sync Types
// =============================================================================

export {
  /** Configuration options for HealthMonitor */
  HealthMonitorConfig,
  /** Configuration options for EventHandler */
  EventHandlerConfig
} from './sync.types'

// =============================================================================
// Unified Configuration Interfaces
// =============================================================================

/**
 * Unified display configuration combining SPICE and VNC options.
 *
 * @example
 * ```typescript
 * // SPICE configuration
 * const spiceDisplay: DisplayConfig = {
 *   type: 'spice',
 *   port: 5901,
 *   address: '0.0.0.0',
 *   password: 'secure123'
 * }
 *
 * // VNC configuration
 * const vncDisplay: DisplayConfig = {
 *   type: 'vnc',
 *   port: 5901,  // or display number 1
 *   address: '0.0.0.0',
 *   passwordEnabled: true
 * }
 * ```
 */
export interface DisplayConfig {
  /** Display protocol type (references VMDisplayType which excludes 'none' from DisplayType) */
  type: VMDisplayType
  /** Port number (SPICE: direct port, VNC: 5900 + display number) */
  port: number
  /** Listen address (default: '0.0.0.0') */
  address?: string
  /** Authentication password (SPICE only) */
  password?: string
  /** Enable password authentication (VNC only) */
  passwordEnabled?: boolean
  /** Disable ticket-based authentication (SPICE only) */
  disableTicketing?: boolean
  /** Enable SPICE guest agent for copy/paste (default: true, SPICE only) */
  enableAgent?: boolean
}

/**
 * Complete network configuration for a VM.
 *
 * @example
 * ```typescript
 * const network: NetworkConfig = {
 *   bridge: 'virbr0',
 *   macAddress: '52:54:00:12:34:56',
 *   tapDevice: 'vnet-abc123',
 *   model: 'virtio-net-pci',
 *   firewall: {
 *     enabled: true,
 *     departmentRules: [...],
 *     vmRules: [...]
 *   }
 * }
 * ```
 */
export interface NetworkConfig {
  /** Network bridge name (e.g., 'virbr0') */
  bridge: string
  /** MAC address (auto-generated if not provided) */
  macAddress?: string
  /** TAP device name (auto-generated if not provided) */
  tapDevice?: string
  /** Network model (default: 'virtio-net-pci', references NetworkModel from qemu.types) */
  model?: NetworkModel
  /** Number of network queues for multi-queue virtio */
  queues?: number
  /** Firewall configuration */
  firewall?: FirewallConfig
}

/**
 * Firewall configuration for network rules.
 */
export interface FirewallConfig {
  /** Whether firewall is enabled */
  enabled: boolean
  /** Rules inherited from department */
  departmentRules?: FirewallRuleInput[]
  /** Rules specific to this VM */
  vmRules?: FirewallRuleInput[]
}

// Re-export FirewallRuleInput for use in FirewallConfig
import { FirewallRuleInput } from './firewall.types'

/**
 * Storage configuration for VM disk.
 *
 * @example
 * ```typescript
 * const storage: StorageConfig = {
 *   path: '/var/lib/infinivirt/disks/vm-abc.qcow2',
 *   format: 'qcow2',
 *   sizeGB: 50,
 *   bus: 'virtio',
 *   cache: 'writeback'
 * }
 * ```
 */
export interface StorageConfig {
  /** Disk image file path */
  path: string
  /** Image format (default: 'qcow2', references StorageFormat) */
  format?: StorageFormat
  /** Disk size in gigabytes */
  sizeGB: number
  /** Disk bus type (default: 'virtio', references DiskBus from qemu.types) */
  bus?: DiskBus
  /** Cache mode (default: 'writeback', references CacheMode from qemu.types) */
  cache?: CacheMode
  /** Enable discard/trim support */
  discard?: boolean
  /** Preallocation mode for new images */
  preallocation?: 'off' | 'metadata' | 'falloc' | 'full'
  /** Backing file for copy-on-write */
  backingFile?: string
}

/**
 * Complete QEMU configuration combining all options.
 *
 * @example
 * ```typescript
 * const qemu: QemuConfig = {
 *   machine: { accel: 'kvm' },
 *   cpu: {
 *     model: 'host',
 *     cores: 4
 *   },
 *   memory: {
 *     sizeGB: 8
 *   },
 *   boot: {
 *     order: 'c',
 *     menu: false
 *   }
 * }
 * ```
 */
export interface QemuConfig {
  /** Machine type and options */
  machine?: QemuMachineConfig
  /** CPU configuration */
  cpu?: QemuCpuConfig
  /** Memory configuration */
  memory?: QemuMemoryConfig
  /** Boot configuration */
  boot?: QemuBootConfig
  /** Process options */
  process?: QemuProcessConfig
}

/**
 * QEMU machine configuration.
 */
export interface QemuMachineConfig {
  /** Machine type (default: 'q35', references MachineType from qemu.types) */
  type?: MachineType
  /** Acceleration method */
  accel?: string
  /** Kernel IRQ chip setting */
  kernelIrqchip?: string
}

/**
 * QEMU CPU configuration.
 */
export interface QemuCpuConfig {
  /** CPU model (default: 'host') */
  model?: string
  /** Number of CPU cores */
  cores: number
  /** Number of sockets */
  sockets?: number
  /** Number of threads per core */
  threads?: number
}

/**
 * QEMU memory configuration.
 */
export interface QemuMemoryConfig {
  /** Memory size in gigabytes */
  sizeGB: number
}

/**
 * QEMU boot configuration.
 */
export interface QemuBootConfig {
  /** Boot order (c=disk, d=cdrom, n=network, references BootDevice from qemu.types) */
  order?: BootDevice
  /** Show boot menu */
  menu?: boolean
  /** ISO file path for CD-ROM boot */
  isoPath?: string
}

/**
 * QEMU process configuration.
 */
export interface QemuProcessConfig {
  /** Run as daemon */
  daemonize?: boolean
  /** PID file path */
  pidfile?: string
  /** QMP socket path */
  qmpSocket?: string
  /** VM UUID */
  uuid?: string
}

/**
 * Complete VM configuration combining all aspects.
 * This is the all-in-one configuration for creating or configuring a VM.
 *
 * @example
 * ```typescript
 * const completeConfig: VMCompleteConfig = {
 *   vm: {
 *     id: 'vm-uuid',
 *     name: 'my-vm',
 *     internalName: 'vm-abc123',
 *     os: 'ubuntu'
 *   },
 *   resources: {
 *     cpuCores: 4,
 *     ramGB: 8,
 *     diskSizeGB: 50
 *   },
 *   display: {
 *     type: 'spice',
 *     port: 5901
 *   },
 *   network: {
 *     bridge: 'virbr0'
 *   },
 *   storage: {
 *     path: '/var/lib/infinivirt/disks/vm-abc.qcow2',
 *     sizeGB: 50
 *   }
 * }
 * ```
 */
export interface VMCompleteConfig {
  /** VM identity configuration */
  vm: VMIdentityConfig
  /** Resource allocation */
  resources?: VMResourcesConfig
  /** Display configuration */
  display?: DisplayConfig
  /** Network configuration */
  network?: NetworkConfig
  /** Storage configuration */
  storage?: StorageConfig
  /** QEMU-specific options */
  qemu?: QemuConfig
  /** Hardware passthrough options */
  hardware?: VMHardwarePassthroughConfig
}

/**
 * VM identity configuration.
 */
export interface VMIdentityConfig {
  /** Database machine ID (UUID) */
  id: string
  /** VM display name */
  name: string
  /** VM internal name (used for TAP device, disk, socket naming) */
  internalName: string
  /** Operating system type */
  os?: string
}

/**
 * VM resource allocation configuration.
 */
export interface VMResourcesConfig {
  /** Number of CPU cores */
  cpuCores: number
  /** RAM size in gigabytes */
  ramGB: number
  /** Disk size in gigabytes */
  diskSizeGB: number
}

/**
 * Hardware passthrough configuration.
 *
 * @example
 * ```typescript
 * const hardware: VMHardwarePassthroughConfig = {
 *   gpuPciAddress: '0000:01:00.0',
 *   gpuAudioPciAddress: '0000:01:00.1',  // GPU's HDMI/DP audio function
 *   gpuRomfile: '/var/lib/infinivirt/roms/gpu.rom'
 * }
 * ```
 */
export interface VMHardwarePassthroughConfig {
  /** GPU PCI address for passthrough (e.g., '01:00.0' or '0000:01:00.0') */
  gpuPciAddress?: string
  /** GPU audio PCI address for HDMI/DisplayPort audio (e.g., '01:00.1') */
  gpuAudioPciAddress?: string
  /** GPU ROM file path (some GPUs require custom ROM for passthrough) */
  gpuRomfile?: string
  /** USB device passthrough */
  usbDevices?: USBDeviceConfig[]
  /** PCI device passthrough */
  pciDevices?: PCIDeviceConfig[]
}

/**
 * USB device passthrough configuration.
 */
export interface USBDeviceConfig {
  /** USB vendor ID */
  vendorId: string
  /** USB product ID */
  productId: string
}

/**
 * PCI device passthrough configuration.
 */
export interface PCIDeviceConfig {
  /** PCI address (e.g., '0000:01:00.0') */
  address: string
  /** Optional ROM file */
  romfile?: string
}

// =============================================================================
// Configuration Validation Types
// =============================================================================

/**
 * Result of configuration validation.
 *
 * @example
 * ```typescript
 * const result: ConfigValidationResult = {
 *   valid: false,
 *   errors: [
 *     { field: 'display.port', code: 'PORT_OUT_OF_RANGE', message: 'Port must be between 5900 and 65535' }
 *   ],
 *   warnings: [
 *     { field: 'storage.cache', code: 'UNSAFE_CACHE', message: 'Unsafe cache mode may cause data loss' }
 *   ]
 * }
 * ```
 */
export interface ConfigValidationResult {
  /** Whether the configuration is valid */
  valid: boolean
  /** Array of validation errors (if any) */
  errors: ConfigValidationError[]
  /** Array of validation warnings (if any) */
  warnings: ConfigValidationWarning[]
}

/**
 * Structured validation error.
 */
export interface ConfigValidationError {
  /** Field path that failed validation (e.g., 'display.port') */
  field: string
  /** Error code for programmatic handling */
  code: string
  /** Human-readable error message */
  message: string
}

/**
 * Structured validation warning.
 */
export interface ConfigValidationWarning {
  /** Field path with warning (e.g., 'storage.cache') */
  field: string
  /** Warning code for programmatic handling */
  code: string
  /** Human-readable warning message */
  message: string
}

// =============================================================================
// Configuration Defaults
// =============================================================================

/**
 * Default values for configuration options.
 *
 * @example
 * ```typescript
 * import { ConfigDefaults } from '@infinibay/infinivirt'
 *
 * const port = userPort ?? ConfigDefaults.display.spicePort
 * ```
 */
export const ConfigDefaults = {
  /** Display defaults */
  display: {
    /** Default SPICE port */
    spicePort: 5900,
    /** Default VNC display number */
    vncDisplay: 0,
    /** Default listen address */
    address: '0.0.0.0',
    /** Default SPICE agent setting */
    enableAgent: true
  },
  /** Network defaults */
  network: {
    /** Default bridge name */
    bridge: 'virbr0',
    /** Default network model */
    model: 'virtio-net-pci' as const
  },
  /** Storage defaults */
  storage: {
    /** Default disk format */
    format: 'qcow2' as const,
    /** Default disk bus */
    bus: 'virtio' as const,
    /** Default cache mode */
    cache: 'writeback' as const,
    /** Default disk size in GB (references DEFAULT_VM_DISK_SIZE_GB from vm.types) */
    sizeGB: DEFAULT_VM_DISK_SIZE_GB
  },
  /** QEMU defaults */
  qemu: {
    /** Default machine type */
    machineType: 'q35' as const,
    /** Default CPU model */
    cpuModel: 'host',
    /** Default CPU cores (references DEFAULT_VM_CPU_CORES from vm.types) */
    cpuCores: DEFAULT_VM_CPU_CORES,
    /** Default RAM in GB (references DEFAULT_VM_RAM_GB from vm.types) */
    ramGB: DEFAULT_VM_RAM_GB
  },
  /**
   * Resource limits - references constants from vm.types for centralization.
   * For VM resource validation, you can also import constants directly:
   * - MIN_VM_CPU_CORES, MAX_VM_CPU_CORES
   * - MIN_VM_RAM_GB, MAX_VM_RAM_GB
   * - MIN_VM_DISK_SIZE_GB, MAX_VM_DISK_SIZE_GB
   */
  limits: {
    /** Minimum CPU cores (references MIN_VM_CPU_CORES from vm.types) */
    minCpuCores: MIN_VM_CPU_CORES,
    /** Maximum CPU cores (references MAX_VM_CPU_CORES from vm.types) */
    maxCpuCores: MAX_VM_CPU_CORES,
    /** Minimum RAM in GB (references MIN_VM_RAM_GB from vm.types) */
    minRamGB: MIN_VM_RAM_GB,
    /** Maximum RAM in GB (references MAX_VM_RAM_GB from vm.types) */
    maxRamGB: MAX_VM_RAM_GB,
    /** Minimum disk size in GB (references MIN_VM_DISK_SIZE_GB from vm.types) */
    minDiskSizeGB: MIN_VM_DISK_SIZE_GB,
    /** Maximum disk size in GB (references MAX_VM_DISK_SIZE_GB from vm.types) */
    maxDiskSizeGB: MAX_VM_DISK_SIZE_GB,
    /** Minimum SPICE port */
    minSpicePort: 5900,
    /** Maximum SPICE port */
    maxSpicePort: 65535,
    /** Maximum VNC display number */
    maxVncDisplay: 99
  }
} as const

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if an object is a valid DisplayConfig.
 *
 * @param obj - The object to check
 * @returns True if the object is a valid DisplayConfig
 *
 * @example
 * ```typescript
 * const config = await fetchConfig()
 * if (isValidDisplayConfig(config)) {
 *   console.log(config.type) // TypeScript knows this is DisplayConfig
 * }
 * ```
 */
export function isValidDisplayConfig (obj: unknown): obj is DisplayConfig {
  if (typeof obj !== 'object' || obj === null) return false
  const candidate = obj as Record<string, unknown>
  return (
    (candidate.type === 'spice' || candidate.type === 'vnc') &&
    typeof candidate.port === 'number' &&
    candidate.port > 0
  )
}

/**
 * Type guard to check if an object is a valid NetworkConfig.
 *
 * @param obj - The object to check
 * @returns True if the object is a valid NetworkConfig
 *
 * @example
 * ```typescript
 * const config = await fetchConfig()
 * if (isValidNetworkConfig(config)) {
 *   console.log(config.bridge) // TypeScript knows this is NetworkConfig
 * }
 * ```
 */
export function isValidNetworkConfig (obj: unknown): obj is NetworkConfig {
  if (typeof obj !== 'object' || obj === null) return false
  const candidate = obj as Record<string, unknown>
  return typeof candidate.bridge === 'string' && candidate.bridge.length > 0
}

/**
 * Type guard to check if an object is a valid StorageConfig.
 *
 * @param obj - The object to check
 * @returns True if the object is a valid StorageConfig
 *
 * @example
 * ```typescript
 * const config = await fetchConfig()
 * if (isValidStorageConfig(config)) {
 *   console.log(config.path) // TypeScript knows this is StorageConfig
 * }
 * ```
 */
export function isValidStorageConfig (obj: unknown): obj is StorageConfig {
  if (typeof obj !== 'object' || obj === null) return false
  const candidate = obj as Record<string, unknown>
  return (
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    typeof candidate.sizeGB === 'number' &&
    candidate.sizeGB > 0
  )
}

/**
 * Type guard to check if an object is a valid VMCompleteConfig.
 *
 * @param obj - The object to check
 * @returns True if the object is a valid VMCompleteConfig
 *
 * @example
 * ```typescript
 * const config = await fetchConfig()
 * if (isValidVMCompleteConfig(config)) {
 *   console.log(config.vm.name) // TypeScript knows this is VMCompleteConfig
 * }
 * ```
 */
export function isValidVMCompleteConfig (obj: unknown): obj is VMCompleteConfig {
  if (typeof obj !== 'object' || obj === null) return false
  const candidate = obj as Record<string, unknown>
  if (typeof candidate.vm !== 'object' || candidate.vm === null) return false
  const vm = candidate.vm as Record<string, unknown>
  return (
    typeof vm.id === 'string' &&
    typeof vm.name === 'string' &&
    typeof vm.internalName === 'string'
  )
}

/**
 * Type guard to check if an object is a valid VMHardwarePassthroughConfig.
 *
 * Validates PCI address formats and ensures audio address differs from GPU address
 * if both are provided.
 *
 * @param obj - The object to check
 * @returns True if the object is a valid VMHardwarePassthroughConfig
 *
 * @example
 * ```typescript
 * const config = {
 *   gpuPciAddress: '01:00.0',
 *   gpuAudioPciAddress: '01:00.1'
 * }
 * if (isValidGpuPassthroughConfig(config)) {
 *   // config is typed as VMHardwarePassthroughConfig
 * }
 * ```
 */
export function isValidGpuPassthroughConfig (obj: unknown): obj is VMHardwarePassthroughConfig {
  if (typeof obj !== 'object' || obj === null) return false
  const candidate = obj as Record<string, unknown>

  // Validate gpuPciAddress if present
  if (candidate.gpuPciAddress !== undefined) {
    if (typeof candidate.gpuPciAddress !== 'string') return false
    const gpuValidation = validatePciAddress(candidate.gpuPciAddress)
    if (!gpuValidation.valid) return false
  }

  // Validate gpuAudioPciAddress if present
  if (candidate.gpuAudioPciAddress !== undefined) {
    if (typeof candidate.gpuAudioPciAddress !== 'string') return false
    const audioValidation = validatePciAddress(candidate.gpuAudioPciAddress)
    if (!audioValidation.valid) return false
  }

  // If both addresses are provided, ensure they are different
  if (
    typeof candidate.gpuPciAddress === 'string' &&
    typeof candidate.gpuAudioPciAddress === 'string' &&
    candidate.gpuPciAddress === candidate.gpuAudioPciAddress
  ) {
    return false
  }

  // Validate gpuRomfile if present
  if (candidate.gpuRomfile !== undefined) {
    if (typeof candidate.gpuRomfile !== 'string') {
      return false
    }
    // Validate ROM file is in allowed directory
    const normalizedPath = path.resolve(candidate.gpuRomfile)
    if (!normalizedPath.startsWith(ALLOWED_ROM_DIR)) {
      return false
    }
  }

  return true
}
