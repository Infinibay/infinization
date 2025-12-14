// Core classes
export { QemuCommandBuilder, QemuCommand, QemuCommandWithPinning } from './core/QemuCommandBuilder'
export { QemuProcess } from './core/QemuProcess'
export { QMPClient } from './core/QMPClient'
export { VMLifecycle } from './core/VMLifecycle'
export { Infinivirt } from './core/Infinivirt'

// CPU classes
export {
  CpuPinningAdapter,
  CpuPinningResult,
  NumaTopology,
  PinningStrategy
} from './cpu/CpuPinningAdapter'

// Network classes
export { TapDeviceManager } from './network/TapDeviceManager'
export { BridgeManager } from './network/BridgeManager'
export { MacAddressGenerator } from './network/MacAddressGenerator'
export { NftablesService } from './network/NftablesService'
export { FirewallRuleTranslator } from './network/FirewallRuleTranslator'
export { DepartmentNatService } from './network/DepartmentNatService'

// Storage classes
export { QemuImgService } from './storage/QemuImgService'
export { SnapshotManager } from './storage/SnapshotManager'

// Display classes
export { SpiceConfig } from './display/SpiceConfig'
export { VncConfig } from './display/VncConfig'

// Sync classes
export { StateSync } from './sync/StateSync'
export { EventHandler } from './sync/EventHandler'
export { HealthMonitor } from './sync/HealthMonitor'

// Database classes
export { PrismaAdapter } from './db/PrismaAdapter'

// Types - QEMU
export {
  MachineType,
  DiskBus,
  CacheMode,
  DisplayType,
  VgaType,
  BootDevice,
  MachineOptions,
  DiskOptions,
  NetworkOptions,
  SpiceOptions,
  VncOptions,
  QemuProcessOptions,
  // GPU Passthrough Types
  GpuPassthroughOptions,
  PciAddressValidationResult,
  PCI_ADDRESS_REGEX,
  validatePciAddress,
  normalizePciAddress
} from './types/qemu.types'

// Types - QMP
export {
  QMPGreeting,
  QMPVersion,
  QMPMessage,
  QMPResponse,
  QMPError,
  QMPEvent,
  QMPTimestamp,
  QMPEventType,
  QMPShutdownEventData,
  QMPDeviceDeletedEventData,
  QMPBlockJobCompletedEventData,
  QMPVMStatus,
  QMPStatusInfo,
  QMPCpuInfo,
  QMPBlockInfo,
  QMPBlockImageInfo,
  QMPBlockInsertedInfo,
  QMPVncInfo,
  QMPVncClientInfo,
  QMPSpiceInfo,
  QMPSpiceChannel,
  QMPMemorySizeInfo,
  QMPClientOptions,
  QMPSocketOptions
} from './types/qmp.types'

// Types - Network
export {
  TapDeviceConfig,
  TapDeviceInfo,
  BridgeConfig,
  BridgeInfo,
  NetworkDeviceError,
  MacAddress,
  NetworkDeviceState,
  NetworkErrorCode,
  QEMU_MAC_PREFIX,
  MAX_TAP_NAME_LENGTH,
  TAP_NAME_PREFIX
} from './types/network.types'

// Types - Firewall
export {
  NftablesFamily,
  NftablesHookType,
  NftablesChainPolicy,
  NftablesErrorCode,
  NftablesTableConfig,
  NftablesChainConfig,
  NftablesRuleConfig,
  NftablesRuleTokens,
  FirewallRuleTranslation,
  VMFirewallConfig,
  FirewallRuleInput,
  ConnectionStateConfig,
  NftablesError,
  ChainListResult,
  FirewallApplyResult,
  INFINIVIRT_TABLE_NAME,
  INFINIVIRT_TABLE_FAMILY,
  DEFAULT_CHAIN_PRIORITY,
  NFTABLES_COMMENT_PREFIX,
  SUPPORTED_PROTOCOLS,
  CONNECTION_STATES,
  MAX_CHAIN_NAME_LENGTH,
  VM_CHAIN_PREFIX,
  generateVMChainName
} from './types/firewall.types'

// Types - Storage
export {
  ImageFormat,
  StorageErrorCode,
  ImageInfo,
  SnapshotInfo,
  ImageCheckResult,
  CreateImageOptions,
  ConvertImageOptions,
  SnapshotCreateOptions,
  StorageError,
  StorageErrorInfo,
  isValidImageFormat,
  SUPPORTED_IMAGE_FORMATS,
  DEFAULT_CLUSTER_SIZE,
  MAX_SNAPSHOT_NAME_LENGTH
} from './types/storage.types'

// Types - Display
export {
  DisplayErrorCode,
  SpiceConfigOptions,
  VncConfigOptions,
  ValidationError,
  DisplayValidationResult,
  DisplayCommandArgs,
  DisplayError,
  VNC_BASE_PORT,
  VNC_MAX_PASSWORD_LENGTH,
  SPICE_MIN_PORT,
  SPICE_MAX_PORT,
  DEFAULT_SPICE_ADDR,
  DEFAULT_VNC_ADDR
} from './types/display.types'

// Types - Sync
export {
  // Database adapter interface
  DatabaseAdapter,
  MachineRecord,
  MachineConfigurationRecord,
  RunningVMRecord,
  // Status types
  DBVMStatus,
  StatusMapping,
  SyncResult,
  SyncError,
  SyncErrorCode,
  // Health monitor types
  HealthMonitorConfig,
  HealthCheckResult,
  HealthCheckSummary,
  CrashEvent,
  // Event handler types
  EventHandlerConfig,
  VMEventData,
  // Constants
  DEFAULT_HEALTH_CHECK_INTERVAL,
  DEFAULT_SYNC_TIMEOUT,
  MAX_SYNC_RETRIES,
  // Type guards
  isValidDBStatus,
  isValidQMPStatus
} from './types/sync.types'

// Types - Database
export {
  // Error types
  PrismaAdapterErrorCode,
  PrismaAdapterError,
  // Configuration types
  MachineConfigUpdate,
  // Record types
  VMConfigRecord,
  DepartmentRecord,
  FirewallRuleSetRecord,
  FirewallRuleRecord,
  ExtendedMachineConfigurationRecord,
  // Type guards
  isPrismaAdapterError,
  // Constants
  DEFAULT_DISK_PATH_PREFIX,
  DEFAULT_QMP_SOCKET_PATH_PREFIX,
  DEFAULT_DISK_FORMAT,
  DEFAULT_DISK_EXTENSION
} from './types/db.types'

// Types - Lifecycle
export {
  // Configuration types
  DisplayProtocol,
  DiskConfig,
  VMCreateConfig,
  VMCreateResult,
  VMStartConfig,
  VMStopConfig,
  // Result types
  VMOperationResult,
  VMStatusResult,
  // Error types
  LifecycleErrorCode,
  LifecycleError,
  // Constants
  DEFAULT_STOP_TIMEOUT,
  DEFAULT_BOOT_TIMEOUT,
  DEFAULT_QMP_CONNECT_TIMEOUT,
  DEFAULT_QMP_SOCKET_DIR,
  DEFAULT_DISK_DIR,
  DEFAULT_PIDFILE_DIR,
  DEFAULT_NETWORK_MODEL,
  DEFAULT_DISK_BUS,
  DEFAULT_DISK_CACHE,
  RESTART_DELAY_MS,
  PROCESS_EXIT_POLL_INTERVAL,
  RUNTIME_DISK_SIZE_PLACEHOLDER_GB,
  // Infinivirt config
  InfinivirtConfig,
  EventManagerLike,
  ActiveVMResources,
  // Helper functions
  isLifecycleError,
  createLifecycleError
} from './types/lifecycle.types'

// Types - VM (Consolidated)
// Provides a centralized hub for all VM-related types
export {
  // Re-exported from lifecycle.types for convenience
  DisplayProtocol as VMDisplayProtocol,
  VMCreateConfig as VMCreateConfigFromHub,
  VMCreateResult as VMCreateResultFromHub,
  VMStartConfig as VMStartConfigFromHub,
  VMStopConfig as VMStopConfigFromHub,
  VMOperationResult as VMOperationResultFromHub,
  VMStatusResult as VMStatusResultFromHub,
  // Re-exported from sync.types for convenience
  VMStatus,
  // Re-exported from qemu.types
  MachineOptions as VMMachineOptions,
  // New consolidated types
  VMInfo,
  VMResourceConfig,
  VMNetworkInfo,
  VMDisplayInfo,
  VMHardwareConfig,
  VMOperation,
  VMOperationStatus,
  VMOperationHistory,
  // Type guards
  isValidVMStatus,
  isValidVMOperation,
  isValidVMInfo,
  // Constants
  DEFAULT_VM_CPU_CORES,
  DEFAULT_VM_RAM_GB,
  DEFAULT_VM_DISK_SIZE_GB,
  MIN_VM_CPU_CORES,
  MAX_VM_CPU_CORES,
  MIN_VM_RAM_GB,
  MAX_VM_RAM_GB,
  MIN_VM_DISK_SIZE_GB,
  MAX_VM_DISK_SIZE_GB
} from './types/vm.types'

// Types - Configuration (Consolidated)
// Provides a centralized hub for all configuration-related types
export {
  // Re-exported from qemu.types
  MachineType as ConfigMachineType,
  DiskBus as ConfigDiskBus,
  CacheMode as ConfigCacheMode,
  DisplayType as ConfigDisplayType,
  VgaType as ConfigVgaType,
  BootDevice as ConfigBootDevice,
  MachineOptions as ConfigMachineOptions,
  DiskOptions as ConfigDiskOptions,
  NetworkOptions as ConfigNetworkOptions,
  SpiceOptions as ConfigSpiceOptions,
  VncOptions as ConfigVncOptions,
  QemuProcessOptions as ConfigQemuProcessOptions,
  // Re-exported from display.types
  SpiceConfigOptions as ConfigSpiceConfigOptions,
  VncConfigOptions as ConfigVncConfigOptions,
  // Re-exported from network.types
  TapDeviceConfig as ConfigTapDeviceConfig,
  BridgeConfig as ConfigBridgeConfig,
  // Re-exported from storage.types
  CreateImageOptions as ConfigCreateImageOptions,
  ConvertImageOptions as ConfigConvertImageOptions,
  SnapshotCreateOptions as ConfigSnapshotCreateOptions,
  // Re-exported from firewall.types
  VMFirewallConfig as ConfigVMFirewallConfig,
  FirewallRuleInput as ConfigFirewallRuleInput,
  // Re-exported from lifecycle.types
  InfinivirtConfig as ConfigInfinivirtConfig,
  // Re-exported from sync.types
  HealthMonitorConfig as ConfigHealthMonitorConfig,
  EventHandlerConfig as ConfigEventHandlerConfig,
  // Helper types derived from existing types
  VMDisplayType,
  NetworkModel,
  StorageFormat,
  // New unified configuration types
  DisplayConfig,
  NetworkConfig,
  FirewallConfig,
  StorageConfig,
  QemuConfig,
  QemuMachineConfig,
  QemuCpuConfig,
  QemuMemoryConfig,
  QemuBootConfig,
  QemuProcessConfig,
  VMCompleteConfig,
  VMIdentityConfig,
  VMResourcesConfig,
  VMHardwarePassthroughConfig,
  USBDeviceConfig,
  PCIDeviceConfig,
  // Validation types
  ConfigValidationResult,
  ConfigValidationError,
  ConfigValidationWarning,
  // Defaults
  ConfigDefaults,
  // Type guards
  isValidDisplayConfig,
  isValidNetworkConfig,
  isValidStorageConfig,
  isValidVMCompleteConfig,
  isValidGpuPassthroughConfig
} from './types/config.types'

// =============================================================================
// Unattended Installation
// =============================================================================
export { UnattendedInstaller, UnattendedInstallerOptions } from './unattended/UnattendedInstaller'
export { InstallationMonitor } from './unattended/InstallationMonitor'

// Types - Unattended
export {
  // OS and phase types
  OSType,
  InstallationPhase,
  // Application types
  InstallCommandType,
  UnattendedApplication,
  ScriptShell,
  UnattendedScript,
  ScriptExecutionConfig,
  // Configuration types
  UnattendedInstallConfig,
  MonitorConfig,
  // Progress and result types
  InstallationProgress,
  InstallationResult,
  // Error types
  UnattendedErrorCode,
  UnattendedError,
  // Constants
  DEFAULT_INSTALLATION_TIMEOUT,
  CDROM_DEVICE_NAME,
  ISO_BOOT_ORDER,
  DEFAULT_MAX_RESETS,
  DEFAULT_CHECK_INTERVAL,
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  // Type guards
  isValidOSType,
  isValidInstallationPhase,
  isValidInstallConfig,
  isUnattendedError,
  createUnattendedError
} from './types/unattended.types'

// System classes
export { CgroupsManager } from './system/CgroupsManager'

// Utilities
export { Debugger } from './utils/debug'
export { CommandExecutor } from './utils/commandExecutor'
