# Infinivirt

Custom virtualization solution for managing QEMU VMs, replacing libvirt dependency.

## Overview

Infinivirt provides TypeScript classes for building QEMU commands and managing VM process lifecycle. It offers a type-safe, fluent API that integrates with the Infinibay backend.

## IMPORTANT NOTE

This project is not mean to be used outside Infinibay proyect. It's too tied to many internals of the project. It requires several abstraction layers to decouple it.

## Features

- **Fluent API for QEMU command building**: Type-safe builder pattern for constructing QEMU command arrays
- **Safe process management**: Spawn-based process execution without shell injection risks
- **QMP socket support**: Management socket integration for VM control (future phases)
- **Storage management**: qemu-img wrapper for disk operations and snapshot management
- **State synchronization**: PostgreSQL integration for VM state tracking (future phases)
- **OS-specific driver presets**: Automatic optimization for Windows, Linux, and legacy operating systems

## Driver Presets

Infinivirt automatically applies OS-optimized QEMU driver configurations based on the `os` field in `VMCreateConfig`. This eliminates manual tuning for common operating systems.

### What Presets Configure

Presets automatically apply optimal values for these fields when not explicitly set:

| Configuration | Windows | Linux | Legacy |
|--------------|---------|-------|--------|
| Disk Bus | virtio | virtio | ide |
| Disk Cache | none | writeback | writethrough |
| Network Model | virtio-net-pci | virtio-net-pci | e1000 |

**Not affected by presets:**
- `networkQueues` - Always auto-calculated as `min(cpuCores, 4)`
- `displayType` - Required field, must be set explicitly

### OS Detection

The `os` field is pattern-matched to determine the preset category:

- **Windows**: `windows`, `windows10`, `windows11`, `win10`, `win11`, `Windows Server 2022`
- **Linux**: `ubuntu`, `debian`, `fedora`, `centos`, `rhel`, `arch`, `opensuse`, etc.
- **Legacy**: `dos`, `freedos`, `freebsd`, `openbsd`, `win95`, `win98`, `macos`

### Usage

Presets are applied automatically during VM creation:

```typescript
// Windows VM - automatically uses Windows preset
await infinivirt.createVM({
  vmId: 'vm-123',
  name: 'Windows 11 Desktop',
  os: 'Windows 11',  // Triggers Windows preset
  cpuCores: 4,
  displayType: 'spice',  // Required - not affected by presets
  // ... other config
})
// Result: diskCacheMode='none', networkModel='virtio-net-pci'
// networkQueues=4 (auto-calculated from cpuCores, not preset)

// Linux VM - automatically uses Linux preset
await infinivirt.createVM({
  vmId: 'vm-456',
  name: 'Ubuntu Server',
  os: 'ubuntu',  // Triggers Linux preset
  cpuCores: 2,
  displayType: 'spice',
  // ... other config
})
// Result: diskCacheMode='writeback', networkModel='virtio-net-pci'
// networkQueues=2 (auto-calculated from cpuCores)
```

### Overriding Presets

Explicit configuration values always take precedence over presets:

```typescript
await infinivirt.createVM({
  vmId: 'vm-789',
  name: 'Custom Windows VM',
  os: 'Windows 11',           // Windows preset selected
  diskCacheMode: 'writeback', // Override: uses writeback instead of preset's 'none'
  networkQueues: 1,           // Override: uses 1 instead of auto-calculated value
  // ... other config
})
```

### Fallback Chain

The configuration fallback chain for disk/network model settings:

1. **Explicit config** - Values set in `VMCreateConfig` fields
2. **OS preset** - Values from the detected OS preset
3. **Hardcoded defaults** - System defaults (virtio, writeback, etc.)

For `networkQueues`, the chain is different:

1. **Explicit config** - If `networkQueues` is set in `VMCreateConfig`
2. **CPU-based auto-calculation** - `min(cpuCores, 4)`

### Preset Rationale

**Windows**:
- `diskCacheMode: 'none'` - NTFS uses its own caching; disabling QEMU cache prevents double-caching and ensures data integrity on power loss
- `diskBus: 'virtio'` - Best performance with Windows virtio drivers installed

**Linux**:
- `diskCacheMode: 'writeback'` - Safe with ext4/XFS journaling; provides ~30% I/O performance boost
- `diskBus: 'virtio'` - Native kernel support for optimal performance

**Legacy**:
- `diskBus: 'ide'` - Maximum compatibility for OSes without virtio drivers
- `networkModel: 'e1000'` - Intel gigabit emulation works without guest drivers

## Installation

```bash
cd infinivirt
npm install
```

## Build

```bash
npm run build
```

## Development

```bash
npm run dev
```

## Usage

```typescript
import { QemuCommandBuilder, QemuProcess } from '@infinibay/infinivirt'

// Build QEMU command
const builder = new QemuCommandBuilder()
  .enableKvm()
  .setMachine('q35')
  .setCpu('host', 4)
  .setMemory(8)
  .addDisk({
    path: '/var/lib/infinivirt/vms/vm-123/disk.qcow2',
    format: 'qcow2',
    bus: 'virtio',
    cache: 'writeback'
  })
  .addNetwork({
    tapName: 'vnet-vm123',
    mac: '52:54:00:12:34:56',
    model: 'virtio-net-pci'
  })
  .addSpice({
    port: 5901,
    addr: '0.0.0.0',
    disableTicketing: true
  })
  .addQmp('/var/run/infinivirt/vm-123.sock')
  .setProcessOptions({
    vmId: 'vm-123',
    name: 'vm-123',
    daemonize: true,
    pidfile: '/var/run/infinivirt/vm-123.pid'
  })

// Get command and arguments separately (recommended)
const { command, args } = builder.buildCommand()
// command: 'qemu-system-x86_64'
// args: ['-enable-kvm', '-machine', 'q35', ...]

// Or get just the arguments array
const argsOnly = builder.build()
// ['-enable-kvm', '-machine', 'q35', ...]

// Optionally set a custom binary
builder.setBinary('/usr/local/bin/qemu-system-x86_64')

// Manage VM process
const vmProcess = new QemuProcess('vm-123', builder)
vmProcess.setQmpSocketPath('/var/run/infinivirt/vm-123.sock')
vmProcess.setPidFilePath('/var/run/infinivirt/vm-123.pid')

// Start VM
await vmProcess.start()

// Check status
console.log('PID:', vmProcess.getPid())
console.log('Alive:', vmProcess.isAlive())

// Stop VM
await vmProcess.stop()
```

## Architecture

```
infinivirt/
├── src/
│   ├── core/
│   │   ├── QemuCommandBuilder.ts  # Fluent API for QEMU commands
│   │   ├── QemuProcess.ts         # Process lifecycle management
│   │   ├── QMPClient.ts           # QMP socket communication
│   │   ├── VMLifecycle.ts         # VM lifecycle orchestration
│   │   └── Infinivirt.ts          # Main public API
│   ├── display/
│   │   ├── SpiceConfig.ts         # SPICE configuration
│   │   └── VncConfig.ts           # VNC configuration
│   ├── network/
│   │   ├── TapDeviceManager.ts    # TAP device management
│   │   ├── BridgeManager.ts       # Network bridge management
│   │   └── NftablesService.ts     # Firewall rule management
│   ├── storage/
│   │   ├── QemuImgService.ts      # qemu-img command wrapper
│   │   └── SnapshotManager.ts     # Snapshot operations
│   ├── sync/
│   │   ├── StateSync.ts           # QMP-to-DB status mapping
│   │   ├── EventHandler.ts        # Real-time event handling
│   │   └── HealthMonitor.ts       # Crash detection and cleanup
│   ├── unattended/
│   │   ├── UnattendedInstaller.ts # Orchestrates unattended OS installation
│   │   └── InstallationMonitor.ts # Monitors installation via QMP events
│   ├── db/
│   │   └── PrismaAdapter.ts       # Implements DatabaseAdapter for Prisma ORM
│   ├── types/
│   │   ├── qemu.types.ts          # QEMU type definitions
│   │   ├── qmp.types.ts           # QMP protocol types
│   │   ├── sync.types.ts          # State sync types
│   │   ├── db.types.ts            # Database types and errors
│   │   ├── vm.types.ts            # Consolidated VM types
│   │   ├── config.types.ts        # Consolidated config types
│   │   ├── lifecycle.types.ts     # VM lifecycle types
│   │   └── unattended.types.ts    # Unattended installation types
│   ├── utils/
│   │   ├── debug.ts               # Debug logging utility
│   │   └── commandExecutor.ts     # Safe command execution
│   └── index.ts                   # Public API exports
└── .internal/                     # Internal documentation
```

## Documentation

See `.internal/` directory for detailed documentation:

- `01-qemu-options-reference.md` - QEMU command line options reference

## Firewall Management

Infinivirt uses **nftables** (the modern replacement for iptables/ebtables) to manage VM firewall rules at Layer 2 using the bridge family.

### NftablesService

Manages nftables rules for VM network filtering:

```typescript
import { NftablesService } from '@infinibay/infinivirt'

const nftables = new NftablesService()

// Initialize nftables infrastructure
await nftables.initialize()

// Create firewall chain for VM
const chainName = await nftables.createVMChain('vm-abc123', 'vnet-abc123')

// Apply firewall rules (department + VM rules)
await nftables.applyRules(
  'vm-abc123',
  'vnet-abc123',
  departmentRules,  // FirewallRuleInput[] from department
  vmRules           // FirewallRuleInput[] specific to VM
)

// Later, remove VM firewall
await nftables.removeVMChain('vm-abc123')
```

### FirewallRuleTranslator

Translates Prisma `FirewallRule` models to nftables syntax:

```typescript
import { FirewallRuleTranslator } from '@infinibay/infinivirt'

const rule = {
  id: 'rule-1',
  name: 'Allow HTTPS',
  action: 'ACCEPT',
  direction: 'IN',
  protocol: 'tcp',
  dstPortStart: 443,
  dstPortEnd: 443,
  priority: 100
}

const nftablesRule = FirewallRuleTranslator.translate(rule, 'vnet-abc123')
// Result: "oifname \"vnet-abc123\" ip protocol tcp tcp dport 443 accept"
```

### Supported Features

- **Actions**: ACCEPT, DROP, REJECT
- **Directions**: IN (to VM), OUT (from VM), INOUT (bidirectional)
- **Protocols**: tcp, udp, icmp, all
- **Port filtering**: Single ports or ranges (source and destination)
- **IP filtering**: Source/destination IP addresses with CIDR masks
- **Connection state tracking**: established, new, related, invalid
- **Rule inheritance**: Department-level rules + VM-specific rules
- **Priority-based ordering**: Lower priority number = higher precedence

### Architecture

Infinivirt creates a single nftables table `bridge infinivirt` with per-VM chains:

```
bridge infinivirt
├── chain forward (hook)
│   ├── jump to vm_abc123 (for vnet-abc123)
│   └── jump to vm_def456 (for vnet-def456)
├── chain vm_abc123
│   ├── rule 1 (priority 100)
│   ├── rule 2 (priority 200)
│   └── ...
└── chain vm_def456
    └── ...
```

This design ensures:
- **Isolation**: Each VM has its own chain
- **Performance**: Rules only evaluated for relevant traffic
- **Cleanup**: Removing a VM chain removes all its rules atomically

For detailed nftables architecture and design decisions, see `.internal/02-network-filtering-alternatives.md`.

## Unattended OS Installation

Infinivirt supports automated OS installation using unattended installation configurations. This feature generates custom ISOs with pre-configured installation settings, allowing VMs to install operating systems automatically without user interaction.

### Supported Operating Systems

- **Windows 10/11**: Uses Sysprep with `autounattend.xml`
- **Ubuntu**: Uses cloud-init with `user-data` configuration
- **Fedora/RHEL**: Uses Kickstart with `ks.cfg` configuration

### Requirements

**Required Fields:**
- `vmId`: Database machine ID (must match the VM being created)
- `os`: Target operating system (must match the VM's `config.os`)
- `username`: Initial user account name
- `password`: Initial user account password (**required for all OS types**)

> **Note:** Password is currently required for all unattended installations. SSH-key-only or passwordless installations are not supported at this time.

### Basic Usage

```typescript
import { Infinivirt, UnattendedInstallConfig } from '@infinibay/infinivirt'

const infinivirt = new Infinivirt({
  prismaClient: prisma
})

const result = await infinivirt.createVM({
  vmId: 'machine-uuid-from-db',
  name: 'Ubuntu VM',
  internalName: 'ubuntu-vm-001',
  os: 'ubuntu',
  cpuCores: 4,
  ramGB: 8,
  diskSizeGB: 50,
  bridge: 'virbr0',
  displayType: 'spice',
  displayPort: 5901,
  unattendedInstall: {  // Enable unattended installation
    vmId: 'machine-uuid-from-db',
    os: 'ubuntu',
    username: 'admin',
    password: 'secure123',
    hostname: 'my-ubuntu-vm',
    locale: 'en_US',
    timezone: 'UTC'
  }
})

console.log('VM created with unattended installation:', result.vmId)
console.log('Installing OS:', result.installingOS)
```

### Installing Applications

You can pre-install applications during OS installation:

```typescript
const result = await infinivirt.createVM({
  // ... other config ...
  unattendedInstall: {
    vmId: 'vm-123',
    os: 'ubuntu',
    username: 'admin',
    password: 'secure123',
    applications: [
      {
        id: 'app-1',
        name: 'Firefox',
        os: ['ubuntu'],
        installCommand: { ubuntu: 'apt-get install -y firefox' },
        parameters: {}
      },
      {
        id: 'app-2',
        name: 'Docker',
        os: ['ubuntu'],
        installCommand: { ubuntu: 'curl -fsSL https://get.docker.com | sh' },
        parameters: {}
      }
    ]
  }
})
```

### Running First-Boot Scripts

Execute custom scripts after OS installation:

```typescript
const result = await infinivirt.createVM({
  // ... other config ...
  unattendedInstall: {
    vmId: 'vm-123',
    os: 'ubuntu',
    username: 'admin',
    password: 'secure123',
    scripts: [
      {
        script: {
          id: 'script-1',
          name: 'Setup SSH Keys',
          fileName: 'setup-ssh.sh',
          shell: 'BASH'
        },
        inputValues: {
          publicKey: 'ssh-rsa AAAA...'
        },
        executionId: 'exec-123'
      }
    ]
  }
})
```

### Windows-Specific Configuration

For Windows installations, you can provide a product key:

```typescript
const result = await infinivirt.createVM({
  // ... other config ...
  unattendedInstall: {
    vmId: 'vm-123',
    os: 'windows10',
    username: 'Administrator',
    password: 'SecurePass123!',
    productKey: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX',  // Optional
    locale: 'en-US',
    timezone: 'Pacific Standard Time'
  }
})
```

### Monitoring Installation Progress

The installation process is monitored automatically via QMP events:

```typescript
import { InstallationMonitor, QMPClient } from '@infinibay/infinivirt'

const qmpClient = new QMPClient('/var/run/infinivirt/vm.sock')
await qmpClient.connect()

const monitor = new InstallationMonitor(qmpClient, {
  timeout: 60 * 60 * 1000,  // 60 minutes
  maxResets: 5,
  checkInterval: 5000
})

monitor.on('progress', (progress) => {
  console.log(`Installation phase: ${progress.phase} - ${progress.message}`)
})

monitor.on('complete', (result) => {
  if (result.success) {
    console.log('Installation completed successfully!')
  } else {
    console.error('Installation failed:', result.error)
  }
})

const result = await monitor.start()
```

### Installation Phases

1. **generating_iso**: Creating custom installation ISO
2. **mounting_media**: Mounting ISO as CD-ROM in VM
3. **installing**: OS installation in progress
4. **completing**: Finalizing installation
5. **cleanup**: Ejecting ISO and cleaning up temp files
6. **completed**: Installation finished successfully
7. **failed**: Installation encountered an error

### Installation Completion Detection

> **Important Limitation:** The installation monitor detects completion based on SHUTDOWN or POWERDOWN QMP events. This means:
>
> - `success: true` indicates the installer shut down gracefully (typically the final step of unattended installation)
> - It does **not** verify that the guest has successfully booted from the installed OS
> - Some installations may require multiple reboots; the monitor completes on the first graceful shutdown
>
> For critical deployments, consider implementing additional verification (e.g., waiting for InfiniService to connect from the guest) to confirm the OS is fully functional.

### Error Handling

The unattended installation system handles various error scenarios:

```typescript
import { UnattendedError, UnattendedErrorCode } from '@infinibay/infinivirt'

try {
  const isoPath = await installer.generateInstallationISO()
} catch (error) {
  if (error instanceof UnattendedError) {
    switch (error.code) {
      case UnattendedErrorCode.ISO_GENERATION_FAILED:
        console.error('Failed to generate ISO:', error.message)
        break
      case UnattendedErrorCode.UNSUPPORTED_OS:
        console.error('OS not supported:', error.message)
        break
      case UnattendedErrorCode.INSTALLATION_TIMEOUT:
        console.error('Installation timed out:', error.message)
        break
    }
  }
}
```

**Available Error Codes:**
- `INVALID_CONFIG` - Invalid configuration provided
- `ISO_GENERATION_FAILED` - Failed to generate custom ISO
- `MOUNT_FAILED` - Failed to mount ISO in VM
- `INSTALLATION_TIMEOUT` - Installation exceeded timeout
- `INSTALLATION_RESET_LIMIT_EXCEEDED` - VM exceeded maximum reset count (boot loop detected)
- `INSTALLATION_FAILED` - Generic installation failure
- `CLEANUP_FAILED` - Failed to clean up temporary files
- `UNSUPPORTED_OS` - Operating system not supported
- `MANAGER_NOT_FOUND` - Backend manager not available
- `QMP_ERROR` - QMP communication error
- `MONITORING_ERROR` - Installation monitoring error

### Best Practices

1. **Timeout Configuration**: Adjust timeout based on OS and application count (Windows typically needs longer)
2. **Resource Allocation**: Ensure sufficient CPU/RAM for installation process
3. **Network Access**: Verify VM has network access for downloading packages
4. **Script Testing**: Test custom scripts independently before using in unattended install
5. **Cleanup**: The system automatically cleans up temp ISOs, but monitor disk space

### Troubleshooting

**Installation hangs:**
- Check VM has sufficient resources (CPU/RAM)
- Verify network connectivity for package downloads
- Review installation logs in VM (varies by OS)

**ISO generation fails:**
- Ensure base ISO exists at expected path
- Check disk space in temp directory
- Verify 7z and xorriso are installed on host

**Applications not installing:**
- Verify install commands are correct for target OS
- Check application parameters are properly substituted
- Review application installation logs in VM

## Display Configuration

Infinivirt provides dedicated configuration classes for SPICE and VNC display protocols with validation and type-safe QEMU argument generation.

### SpiceConfig

Manages SPICE display configuration with QXL driver and guest agent support:

```typescript
import { SpiceConfig, QemuCommandBuilder } from '@infinibay/infinivirt'

// Create SPICE configuration with password
const spiceConfig = new SpiceConfig({
  port: 5901,
  addr: '0.0.0.0',
  password: 'secure123',
  enableAgent: true  // Enables copy/paste via virtio-serial (default: true)
})

// Or without authentication
const spiceNoAuth = new SpiceConfig({
  port: 5901,
  addr: '0.0.0.0',
  disableTicketing: true
})

// Disable guest agent (useful for guests without spice-vdagent)
const spiceNoAgent = new SpiceConfig({
  port: 5901,
  addr: '0.0.0.0',
  disableTicketing: true,
  enableAgent: false  // No virtio-serial devices added
})

// Validate configuration
const validation = spiceConfig.validate()
if (!validation.valid) {
  console.error('Validation errors:', validation.errors)
}

// Generate QEMU arguments
const { args, vgaType } = spiceConfig.generateArgs()
// args: ['-spice', 'port=5901,addr=0.0.0.0,password=secure123', '-vga', 'qxl', ...]
// vgaType: 'qxl'

// Use with QemuCommandBuilder
const builder = new QemuCommandBuilder()
  .enableKvm()
  .setMachine('q35')
  .addSpice(spiceConfig)  // Accepts SpiceConfig instance
```

### VncConfig

Manages VNC display configuration with standard VGA driver:

```typescript
import { VncConfig, QemuCommandBuilder } from '@infinibay/infinivirt'

// Create VNC configuration (display 1 = port 5901)
const vncConfig = new VncConfig({
  display: 1,
  addr: '0.0.0.0',
  password: true  // Enable password authentication
})

// Helper methods
console.log('Display:', vncConfig.getDisplay())  // 1
console.log('Port:', vncConfig.getPort())        // 5901
console.log('Has password:', vncConfig.hasPassword())  // true

// Static conversion utilities
const port = VncConfig.displayToPort(1)    // 5901
const display = VncConfig.portToDisplay(5901)  // 1

// Generate QEMU arguments
const { args, vgaType } = vncConfig.generateArgs()
// args: ['-vnc', '0.0.0.0:1,password=on', '-vga', 'std']
// vgaType: 'std'

// Use with QemuCommandBuilder
const builder = new QemuCommandBuilder()
  .enableKvm()
  .setMachine('q35')
  .addVnc(vncConfig)  // Accepts VncConfig instance
```

### Supported Features

**SpiceConfig:**
- **Port assignment**: Custom port (5900-65535)
- **Authentication**: Password or disable-ticketing mode
- **QXL driver**: Paravirtual graphics for better performance
- **Guest agent**: virtio-serial for copy/paste, resolution changes (can be disabled via `enableAgent: false`)
- **Validation**: Port ranges, address format, password constraints

> **Note**: Both `SpiceConfig` and the legacy `SpiceOptions` object support the `enableAgent` option. The guest agent is enabled by default in both APIs.

**VncConfig:**
- **Display numbers**: 0-99 (port = 5900 + display)
- **Authentication**: Optional password (8 character limit)
- **Standard VGA**: Universal compatibility
- **Validation**: Display number ranges, address format

### Important Notes

**VNC Password Limitation**: VNC passwords are limited to 8 characters by QEMU. For production use, consider SPICE with stronger authentication or use VNC over SSH tunnel.

**SPICE vs VNC**: SPICE provides better performance and features (copy/paste, USB redirection) but requires SPICE client. VNC offers universal compatibility with any VNC viewer.

**Guest Agent**: SPICE guest agent (enabled by default) requires `spice-vdagent` package installed in the guest OS for copy/paste functionality.

### Error Handling

Both classes throw `DisplayError` with structured error codes:

```typescript
import { DisplayError, DisplayErrorCode } from '@infinibay/infinivirt'

try {
  const config = new SpiceConfig({
    port: 99999,  // Invalid port (out of range 5900-65535)
    addr: '0.0.0.0'
  })
} catch (error) {
  if (error instanceof DisplayError) {
    console.log('Error code:', error.code)  // DisplayErrorCode.PORT_OUT_OF_RANGE
    console.log('Message:', error.message)
    console.log('Context:', error.context)
    // context.validationErrors contains all validation failures with codes
  }
}
```

**Available Error Codes:**
- `PORT_OUT_OF_RANGE` - SPICE port outside valid range (5900-65535)
- `INVALID_PORT` - Port is not a valid integer
- `INVALID_ADDRESS` - Address format is invalid
- `INVALID_DISPLAY_NUMBER` - VNC display number outside valid range (0-99)
- `INVALID_PASSWORD` - Password is empty string
- `CONFLICTING_OPTIONS` - Mutually exclusive options used together (e.g., password + disableTicketing)

### Display Architecture

Configuration classes generate validated QEMU arguments:

```
SpiceConfig / VncConfig
        |
   validate() -> generateArgs()
        |
  QemuCommandBuilder
        |
    QemuProcess
```

This ensures:
- **Type Safety**: Compile-time validation of configuration
- **Runtime Validation**: Port ranges, address formats, constraints
- **Reusability**: Config objects can be stored, serialized, reused
- **Separation of Concerns**: Display logic isolated from command building

## Hugepages for Memory Performance

Enable `hugepages: true` in `VMCreateConfig` for VMs >4GB RAM to reduce TLB misses and improve memory access.

### Host Requirements

1. **Kernel Boot Params** (`/etc/default/grub`):
   ```bash
   GRUB_CMDLINE_LINUX_DEFAULT="hugepagesz=2M hugepages=4096"  # 8GB (4096*2MB)
   sudo update-grub && sudo reboot
   ```
2. **Mount hugetlbfs**:
   ```bash
   sudo mount -t hugetlbfs none /dev/hugepages
   ```
3. **Persistent** (`/etc/fstab`):
   ```
   hugetlbfs /dev/hugepages hugetlbfs defaults 0 0
   ```
4. **Verify**:
   ```bash
   cat /proc/meminfo | grep Huge  # HugePages_Total/Free
   mount | grep hugepages         # Confirm mount
   ```

### Trade-offs

- **Pros**: Better perf for memory workloads (databases, caches)
- **Cons**: Pre-allocates RAM (no swap), requires kernel reboot

Infinivirt auto-validates `/dev/hugepages` (hugetlbfs mount + access); logs warnings and falls back gracefully.

## Database Integration

The `PrismaAdapter` class provides a bridge between infinivirt and the PostgreSQL database via Prisma ORM. It implements the `DatabaseAdapter` interface for compatibility with `StateSync`, `EventHandler`, and `HealthMonitor`.

**Note**: The `PrismaAdapter` requires `@prisma/client` to be installed in your project. This is typically provided by the backend application (listed as a peer dependency).

### Basic Usage

```typescript
import { PrismaClient } from '@prisma/client'
import { PrismaAdapter } from '@infinibay/infinivirt'

// Use the backend's Prisma client singleton
import prisma from '@backend/app/utils/database'

const adapter = new PrismaAdapter(prisma)

// Fetch VM configuration with all includes
const vmConfig = await adapter.findMachineWithConfig('vm-123')
console.log(vmConfig.configuration?.qmpSocketPath)

// Update VM status
await adapter.updateMachineStatus('vm-123', 'running')

// Update QEMU process information
await adapter.updateMachineConfiguration('vm-123', {
  qmpSocketPath: '/var/run/infinivirt/vm-123.sock',
  qemuPid: 12345,
  tapDeviceName: 'vnet-vm123'
})

// Fetch firewall rules (VM + inherited department rules)
const rules = await adapter.getFirewallRules('vm-123')
```

### Integration with Sync Module

The `PrismaAdapter` implements the `DatabaseAdapter` interface, making it compatible with `StateSync`, `EventHandler`, and `HealthMonitor`:

```typescript
import { StateSync, EventHandler, HealthMonitor, PrismaAdapter } from '@infinibay/infinivirt'
import prisma from '@backend/app/utils/database'

const adapter = new PrismaAdapter(prisma)

// Use with StateSync
const stateSync = new StateSync(adapter)

// Use with EventHandler
const eventHandler = new EventHandler(adapter)

// Use with HealthMonitor
const healthMonitor = new HealthMonitor(adapter)
```

### Error Handling

```typescript
import { PrismaAdapterError, PrismaAdapterErrorCode, isPrismaAdapterError } from '@infinibay/infinivirt'

try {
  await adapter.findMachine('invalid-id')
} catch (error) {
  if (isPrismaAdapterError(error)) {
    if (error.code === PrismaAdapterErrorCode.MACHINE_NOT_FOUND) {
      console.log('VM not found')
    }
  }
}
```

### Available Methods

**DatabaseAdapter Interface:**
- `findMachine(id)` - Find machine by ID
- `updateMachineStatus(id, status)` - Update machine status
- `findRunningVMs()` - Find all VMs with 'running' status
- `clearMachineConfiguration(machineId)` - Clear runtime configuration

**Extended Configuration Methods:**
- `findMachineWithConfig(id)` - Find machine with full configuration includes
- `updateMachineConfiguration(machineId, config)` - Update or create machine configuration

**Firewall Methods:**
- `getFirewallRules(vmId)` - Get all rules including inherited department rules
- `getFirewallRuleSetId(vmId)` - Get the firewall rule set ID

**Helper Methods:**
- `getMachineInternalName(id)` - Get machine's internal name
- `getMachineDiskPath(id)` - Get disk path based on internal name

## State Synchronization

The sync module ensures VM state in PostgreSQL always reflects actual QEMU process state through event-driven updates and periodic health checks.

### DatabaseAdapter Interface

All sync classes use a `DatabaseAdapter` interface for database operations:

```typescript
import { DatabaseAdapter } from '@infinibay/infinivirt'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Create a Prisma-based adapter
const adapter: DatabaseAdapter = {
  findMachine: (id) => prisma.machine.findUnique({
    where: { id },
    select: { id: true, status: true }
  }),
  updateMachineStatus: async (id, status) => {
    await prisma.machine.update({ where: { id }, data: { status } })
  },
  findRunningVMs: () => prisma.machine.findMany({
    where: { status: 'running' },
    select: {
      id: true,
      status: true,
      MachineConfiguration: {
        select: { qemuPid: true, tapDeviceName: true, qmpSocketPath: true }
      }
    }
  }),
  clearMachineConfiguration: async (machineId) => {
    await prisma.machineConfiguration.updateMany({
      where: { machineId },
      data: { qemuPid: null, tapDeviceName: null, qmpSocketPath: null }
    })
  }
}
```

### StateSync

Maps QMP status to database status and performs synchronization:

```typescript
import { StateSync, DatabaseAdapter, QMPClient } from '@infinibay/infinivirt'

const stateSync = new StateSync(adapter)
const qmpClient = new QMPClient('/var/run/qemu/vm1.sock')

await qmpClient.connect()

// Sync VM state from QMP to database
const result = await stateSync.syncState('vm-123', qmpClient)
console.log(`Status updated: ${result.previousStatus} → ${result.newStatus}`)

// Manual status mapping
const dbStatus = stateSync.mapQMPStatusToDBStatus('running')   // 'running'
const dbStatus2 = stateSync.mapQMPStatusToDBStatus('paused')   // 'suspended'
const dbStatus3 = stateSync.mapQMPStatusToDBStatus('shutdown') // 'off'
```

**Status Mapping:**
- `running` → `running`
- `paused` → `suspended`
- `shutdown` → `off`
- `guest-panicked` → `error`
- `inmigrate`, `postmigrate`, `prelaunch` → `building`

### EventHandler

Automatically updates database when QMP events occur:

```typescript
import { EventHandler, QMPClient } from '@infinibay/infinivirt'

const eventHandler = new EventHandler(adapter)
const qmpClient = new QMPClient('/var/run/qemu/vm1.sock')

await qmpClient.connect()

// Attach event handler to VM
await eventHandler.attachToVM('vm-123', qmpClient)

// Listen for custom events
eventHandler.on('vm:shutdown', (data) => {
  console.log(`VM ${data.vmId} shut down`)
})

eventHandler.on('vm:suspended', (data) => {
  console.log(`VM ${data.vmId} suspended`)
})

// Detach when done
await eventHandler.detachFromVM('vm-123')
```

**QMP Events (emitted as `vm:{event}`):**
- `vm:shutdown` → Updates status to 'off'
- `vm:powerdown` → Updates status to 'off'
- `vm:stop` → Updates status to 'suspended'
- `vm:resume` → Updates status to 'running'
- `vm:suspend` → Updates status to 'suspended'
- `vm:wakeup` → Updates status to 'running'
- `vm:reset` → Logs event, keeps status 'running'

**Status Events (higher-level):**
- `vm:off` → Emitted when status becomes 'off'
- `vm:suspended` → Emitted when status becomes 'suspended'
- `vm:running` → Emitted when status becomes 'running'
- `vm:event` → Generic event for all state changes
- `vm:disconnect` → Emitted when QMP client disconnects

### HealthMonitor

Periodically checks for crashed QEMU processes and cleans up resources:

```typescript
import { HealthMonitor } from '@infinibay/infinivirt'

const healthMonitor = new HealthMonitor(adapter, {
  checkIntervalMs: 30000, // Check every 30 seconds
  enableCleanup: true,
  onCrashDetected: async (vmId) => {
    console.log(`VM ${vmId} crashed, sending alert...`)
  }
})

// Start monitoring
await healthMonitor.start()

// Listen for crash events
healthMonitor.on('crash', (event) => {
  console.log(`Crash detected: VM ${event.vmId}, PID ${event.pid}`)
})

// Stop monitoring
await healthMonitor.stop()
```

**Crash Detection:**
1. Queries all VMs with status='running'
2. Checks if QEMU process (PID) is alive
3. If dead: updates status to 'off'
4. Cleans up TAP device, firewall rules, QMP socket
5. Emits 'crash' event for notifications

**Resource Cleanup:**
- Removes TAP network device
- Deletes nftables firewall chain
- Removes QMP socket file
- Clears qemuPid, tapDeviceName, qmpSocketPath in database

### Integration Example

Complete example showing all sync components working together:

```typescript
import {
  QemuProcess,
  QMPClient,
  StateSync,
  EventHandler,
  HealthMonitor,
  DatabaseAdapter
} from '@infinibay/infinivirt'

// Assume adapter is created as shown in DatabaseAdapter section above

// 1. Start VM
const qemuProcess = new QemuProcess('vm-123', commandBuilder)
await qemuProcess.start()

// 2. Connect QMP
const qmpClient = new QMPClient('/var/run/qemu/vm-123.sock')
await qmpClient.connect()

// 3. Attach event handler for real-time updates
const eventHandler = new EventHandler(adapter)
await eventHandler.attachToVM('vm-123', qmpClient)

// 4. Start health monitoring for crash detection
const healthMonitor = new HealthMonitor(adapter, {
  checkIntervalMs: 30000,
  enableCleanup: true
})
await healthMonitor.start()

// Now VM state is automatically synchronized:
// - QMP events → immediate DB updates
// - Process crashes → detected and cleaned up
// - Database always reflects actual state
```

**Notes:**
- StateSync requires QMPClient connection
- EventHandler automatically calls StateSync on events
- HealthMonitor runs independently, doesn't need QMP
- All classes use dependency injection via `DatabaseAdapter` interface
- Cleanup is idempotent (safe to call multiple times)

## Storage Management

Infinivirt provides classes for managing QEMU disk images and snapshots using `qemu-img` commands.

### QemuImgService

Manages disk image operations:

```typescript
import { QemuImgService, StorageError, StorageErrorCode } from '@infinibay/infinivirt'

const qemuImg = new QemuImgService()

// Create a new qcow2 image with options
await qemuImg.createImage({
  path: '/var/lib/infinivirt/vms/vm-123/disk.qcow2',
  sizeGB: 50,
  format: 'qcow2',
  preallocation: 'metadata'  // optional: 'off' | 'metadata' | 'falloc' | 'full'
})

// Get image information
const info = await qemuImg.getImageInfo('/var/lib/infinivirt/vms/vm-123/disk.qcow2')
console.log(`Format: ${info.format}, Virtual Size: ${info.virtualSize} bytes`)

// Resize image (VM must be stopped)
await qemuImg.resizeImage('/var/lib/infinivirt/vms/vm-123/disk.qcow2', 70)

// Convert image format with compression
await qemuImg.convertImage({
  sourcePath: '/path/to/source.raw',
  destPath: '/path/to/dest.qcow2',
  destFormat: 'qcow2',
  compress: true  // optional, qcow2 only
})

// Check image for errors
const checkResult = await qemuImg.checkImage('/var/lib/infinivirt/vms/vm-123/disk.qcow2')
if (checkResult.errors > 0) {
  console.log(`Found ${checkResult.errors} errors`)
}

// Error handling with structured errors
try {
  await qemuImg.getImageInfo('/nonexistent/path.qcow2')
} catch (error) {
  if (error instanceof StorageError) {
    console.log(`Error code: ${error.code}`)  // StorageErrorCode.IMAGE_NOT_FOUND
    console.log(`Path: ${error.path}`)
  }
}
```

### SnapshotManager

Manages internal qcow2 snapshots:

```typescript
import { SnapshotManager, StorageError, StorageErrorCode } from '@infinibay/infinivirt'

const snapshots = new SnapshotManager()
const imagePath = '/var/lib/infinivirt/vms/vm-123/disk.qcow2'

// Create snapshot with options (VM must be stopped)
await snapshots.createSnapshot({
  imagePath,
  name: 'before-update',
  description: 'Snapshot before system update'  // optional, for logging
})

// List all snapshots
const snapshotList = await snapshots.listSnapshots(imagePath)
for (const snap of snapshotList) {
  console.log(`${snap.name}: ${snap.date}`)
}

// Check if snapshot exists
const exists = await snapshots.snapshotExists(imagePath, 'before-update')

// Revert to snapshot (VM must be stopped)
await snapshots.revertSnapshot(imagePath, 'before-update')

// Delete snapshot
await snapshots.deleteSnapshot(imagePath, 'before-update')

// Error handling
try {
  await snapshots.revertSnapshot(imagePath, 'nonexistent-snapshot')
} catch (error) {
  if (error instanceof StorageError && error.code === StorageErrorCode.SNAPSHOT_NOT_FOUND) {
    console.log('Snapshot does not exist')
  }
}
```

### Supported Features

**QemuImgService:**
- **Image formats**: qcow2, raw, vmdk, vdi, vhdx
- **Create**: New disk images with specified size
- **Info**: Get detailed image information (format, size, snapshots)
- **Resize**: Expand disk images (offline only)
- **Convert**: Convert between different image formats
- **Check**: Verify image integrity and detect errors

**SnapshotManager:**
- **Create**: Internal qcow2 snapshots with optional descriptions
- **List**: View all snapshots with metadata
- **Revert**: Restore VM to previous snapshot state
- **Delete**: Remove snapshots to free space
- **Exists**: Check if specific snapshot exists

### Important Notes

**VM Must Be Stopped**: All snapshot operations and image resize require the VM to be powered off.

**Backup Before Operations**: Always backup important data before resizing or converting images.

**Snapshot Names**: Use alphanumeric characters, hyphens, and underscores only. Maximum 64 characters.

### Storage Architecture

Both classes use safe command execution via `CommandExecutor`:

```
QemuImgService / SnapshotManager
        ↓
  CommandExecutor (spawn-based)
        ↓
    qemu-img CLI
```

This ensures:
- **Security**: No shell injection vulnerabilities
- **Reliability**: Proper error handling and logging
- **Type Safety**: Structured data parsing from command output

## GPU Passthrough

Infinivirt supports GPU passthrough via VFIO-PCI, allowing VMs direct access to physical GPUs for high-performance graphics, gaming, or GPU compute workloads.

### Prerequisites

Before using GPU passthrough, ensure your system is properly configured:

```bash
# 1. Verify IOMMU is enabled
dmesg | grep -e IOMMU -e DMAR
# Should show "IOMMU enabled" or "DMAR" messages

# 2. Check kernel parameters (add to GRUB_CMDLINE_LINUX)
# Intel: intel_iommu=on iommu=pt
# AMD: amd_iommu=on iommu=pt

# 3. Verify vfio-pci module is loaded
lsmod | grep vfio

# 4. Find your GPU's PCI address
lspci | grep -i vga
# Example output: 01:00.0 VGA compatible controller: NVIDIA...

# 5. Bind GPU to vfio-pci (example for GPU 0000:01:00.0)
echo "0000:01:00.0" > /sys/bus/pci/devices/0000:01:00.0/driver/unbind
echo "vfio-pci" > /sys/bus/pci/devices/0000:01:00.0/driver_override
echo "0000:01:00.0" > /sys/bus/pci/drivers/vfio-pci/bind
```

### Basic GPU Passthrough

Pass through a GPU to a VM using `addGpuPassthrough()`:

```typescript
import { QemuCommandBuilder, validatePciAddress } from '@infinibay/infinivirt'

// Validate PCI address first (optional but recommended)
const validation = validatePciAddress('01:00.0')
if (!validation.valid) {
  throw new Error(validation.error)
}

// Build command with GPU passthrough
const builder = new QemuCommandBuilder()
  .enableKvm()
  .setMachine('q35')  // Q35 machine type recommended for GPU passthrough
  .setCpu('host', 4)
  .setMemory(8)
  .addGpuPassthrough('01:00.0')  // Short format
  // or .addGpuPassthrough('0000:01:00.0')  // Long format

const { command, args } = builder.buildCommand()
```

The method automatically:
- Validates the PCI address format
- Enables multifunction support (required for GPUs)
- Generates correct vfio-pci device arguments

### GPU with Audio

Modern GPUs have an integrated audio controller for HDMI/DisplayPort audio output. Use `addGpuWithAudio()` to pass through both:

```typescript
import { QemuCommandBuilder } from '@infinibay/infinivirt'

const builder = new QemuCommandBuilder()
  .enableKvm()
  .setMachine('q35')
  .setCpu('host', 4)
  .setMemory(8)
  .addGpuWithAudio('01:00.0', '01:00.1')  // GPU + Audio
  //                   ↑           ↑
  //               GPU func    Audio func

const { command, args } = builder.buildCommand()
// Generated args include:
// -device vfio-pci,host=01:00.0,multifunction=on
// -device vfio-pci,host=01:00.1
```

Find your GPU's audio function with:
```bash
lspci | grep -i audio
# Example: 01:00.1 Audio device: NVIDIA Corporation...
```

### ROM File

Some GPUs require a custom ROM file for passthrough (especially if the GPU is the primary display during boot):

```typescript
const builder = new QemuCommandBuilder()
  .enableKvm()
  .setMachine('q35')
  .addGpuPassthrough('01:00.0', '/var/lib/infinivirt/roms/nvidia-rtx3080.rom')
  // or with audio:
  // .addGpuWithAudio('01:00.0', '01:00.1', '/var/lib/infinivirt/roms/nvidia-rtx3080.rom')
```

To extract a ROM from your GPU:
```bash
# Ensure GPU is bound to vfio-pci first
# Create the ROM directory if it doesn't exist
sudo mkdir -p /var/lib/infinivirt/roms
cat /sys/bus/pci/devices/0000:01:00.0/rom > /var/lib/infinivirt/roms/gpu.rom
```

### Generic PCI Passthrough

For non-GPU PCI devices (USB controllers, network cards, etc.), use `addPciPassthrough()`:

```typescript
const builder = new QemuCommandBuilder()
  .enableKvm()
  .setMachine('q35')
  .addPciPassthrough('04:00.0')  // USB controller
  .addPciPassthrough('05:00.0')  // Network card
```

Unlike `addGpuPassthrough()`, this method doesn't enable multifunction by default.

### PCI Address Validation

Use the validation utilities for safer PCI address handling:

```typescript
import {
  validatePciAddress,
  normalizePciAddress,
  PCI_ADDRESS_REGEX
} from '@infinibay/infinivirt'

// Validate address format
const result = validatePciAddress('01:00.0')
if (!result.valid) {
  console.error(result.error)
}

// Normalize to long format
const normalized = normalizePciAddress('01:00.0')
// Returns: '0000:01:00.0'

// Use regex for custom validation
if (PCI_ADDRESS_REGEX.test(userInput)) {
  // Valid format
}
```

### Important Notes

- **Host GPU Unavailable**: The host cannot use a GPU while it's passed through to a VM
- **Q35 Machine Type**: Required for GPU passthrough compatibility
- **UEFI Firmware**: Recommended for better GPU compatibility (OVMF)
- **IOMMU Groups**: All devices in an IOMMU group must be passed together
- **Reset Bug**: Some GPUs don't reset properly; may require VM shutdown/restart
- **Single GPU Systems**: Passing through the only GPU leaves the host without display

### Troubleshooting

| Issue | Solution |
|-------|----------|
| IOMMU not enabled | Add `intel_iommu=on` or `amd_iommu=on` to kernel cmdline |
| GPU not bound to vfio-pci | Unbind from host driver and bind to vfio-pci |
| IOMMU group contains other devices | Use ACS override patch or pass all devices in group |
| Black screen in VM | Try different ROM file or add `x-vga=on` parameter |
| VM won't start with GPU | Check dmesg for VFIO errors, verify permissions |
| GPU doesn't reset on VM shutdown | Use vendor reset module or reboot host |

### Architecture

```
QemuCommandBuilder
        ↓
addGpuPassthrough() / addGpuWithAudio() / addPciPassthrough()
        ↓
validatePciAddress() (PCI address validation)
        ↓
QEMU vfio-pci device arguments
        ↓
QemuProcess (spawns QEMU with passthrough devices)
```

For detailed QEMU GPU passthrough options, see `.internal/01-qemu-options-reference.md` section 9.

## VM Lifecycle (Infinivirt Class)

The `Infinivirt` class is the main public API for VM management. It orchestrates all VM operations and manages shared resources.

**Note**: Pass your application's PrismaClient singleton for connection pooling. Infinivirt does not create or manage its own Prisma instance.

### Basic Usage

```typescript
import { PrismaClient } from '@prisma/client'
import { Infinivirt } from '@infinibay/infinivirt'

// Use your application's Prisma singleton
const prisma = new PrismaClient()

const infinivirt = new Infinivirt({
  prismaClient: prisma,
  healthMonitorInterval: 30000  // optional
})

await infinivirt.initialize()

// Create and start a VM
const result = await infinivirt.createVM({
  vmId: 'machine-uuid-from-db',
  name: 'test-vm',
  internalName: 'vm-abc123',
  os: 'ubuntu',
  cpuCores: 4,
  ramGB: 8,
  diskSizeGB: 50,
  bridge: 'virbr0',
  displayType: 'spice',
  displayPort: 5901
})

console.log('VM created:', result.vmId)

// Start an existing VM
await infinivirt.startVM('vm-uuid')

// Stop a VM (graceful shutdown)
await infinivirt.stopVM('vm-uuid')

// Restart a VM
await infinivirt.restartVM('vm-uuid')

// Get VM status
const status = await infinivirt.getVMStatus('vm-uuid')
console.log(`Status: ${status.status}, PID: ${status.pid}`)

// Clean shutdown
await infinivirt.shutdown()
```

### Available Operations

- `createVM(config)` - Create disk, network, and start a new VM
- `startVM(vmId, config?)` - Start an existing VM from database config
- `stopVM(vmId, config?)` - Stop a running VM (graceful or force)
- `restartVM(vmId)` - Restart a VM
- `suspendVM(vmId)` - Suspend a running VM
- `resumeVM(vmId)` - Resume a suspended VM
- `resetVM(vmId)` - Hardware reset a VM
- `getVMStatus(vmId)` - Get detailed status including QMP state

### Configuration Options

```typescript
interface InfinivirtConfig {
  // Required: Your Prisma client singleton
  prismaClient: PrismaClient

  // Optional: Backend event manager for real-time updates
  eventManager?: EventManagerLike

  // Optional: Health monitor interval (default: 30000ms)
  healthMonitorInterval?: number

  // Optional: Auto-start health monitor (default: true)
  autoStartHealthMonitor?: boolean

  // Optional: Custom directory paths
  diskDir?: string
  qmpSocketDir?: string
  pidfileDir?: string
}
```

## Type System

Infinivirt provides a comprehensive TypeScript type system organized into specialized modules with consolidated entry points for common use cases.

### Type Organization

The type system is organized into:

1. **Specialized modules** - Domain-specific types in dedicated files
2. **Consolidated modules** - Unified entry points for common use cases

| Category | Specialized File | Consolidated File | Purpose |
|----------|------------------|-------------------|---------|
| VM | `lifecycle.types.ts`, `sync.types.ts` | `vm.types.ts` | VM operations, status, info |
| Config | `qemu.types.ts`, `display.types.ts`, `network.types.ts`, `storage.types.ts` | `config.types.ts` | All configuration types |
| QMP | `qmp.types.ts` | - | QMP protocol types |
| Firewall | `firewall.types.ts` | - | nftables rule types |
| Database | `db.types.ts` | - | Prisma adapter types |

### Import Examples

```typescript
// Import from consolidated VM types (recommended for VM operations)
import {
  VMCreateConfig,
  VMStatus,
  VMInfo,
  VMOperation,
  VMOperationStatus
} from '@infinibay/infinivirt'

// Import from consolidated config types (recommended for configuration)
import {
  DisplayConfig,
  NetworkConfig,
  StorageConfig,
  VMCompleteConfig,
  ConfigDefaults
} from '@infinibay/infinivirt'

// Import from specific modules (for specialized use cases)
import {
  QMPEventType,
  QMPStatusInfo,
  QMPClient
} from '@infinibay/infinivirt'

// Import firewall types
import {
  FirewallRuleInput,
  VMFirewallConfig,
  NftablesFamily
} from '@infinibay/infinivirt'
```

### Key Consolidated Types

**VM Types (`vm.types.ts`)**:
- `VMInfo` - Comprehensive VM information
- `VMStatus` - Database VM status (building, running, off, suspended, etc.)
- `VMOperation` - Operation types (CREATE, START, STOP, etc.)
- `VMOperationStatus` - Operation status (PENDING, IN_PROGRESS, SUCCESS, etc.)
- `VMResourceConfig` - CPU, RAM, disk configuration

**Config Types (`config.types.ts`)**:
- `DisplayConfig` - Unified SPICE/VNC configuration
- `NetworkConfig` - Complete network configuration with firewall
- `StorageConfig` - Disk configuration with format, bus, cache options
- `QemuConfig` - Complete QEMU configuration
- `VMCompleteConfig` - All-in-one VM configuration
- `ConfigDefaults` - Default values for all configuration options

### Type Guards

Infinivirt provides type guards for runtime validation:

```typescript
import {
  isValidVMStatus,
  isValidVMInfo,
  isValidDisplayConfig,
  isValidNetworkConfig,
  isValidStorageConfig,
  isValidDBStatus,
  isValidQMPStatus,
  isValidImageFormat
} from '@infinibay/infinivirt'

// Runtime type checking
const status = 'running'
if (isValidVMStatus(status)) {
  // status is typed as VMStatus
}

const config = await fetchConfig()
if (isValidDisplayConfig(config)) {
  // config is typed as DisplayConfig
}
```

### Configuration Defaults

Use `ConfigDefaults` for default values:

```typescript
import { ConfigDefaults } from '@infinibay/infinivirt'

// Access default values
const port = userPort ?? ConfigDefaults.display.spicePort     // 5900
const cores = userCores ?? ConfigDefaults.qemu.cpuCores       // 2
const format = ConfigDefaults.storage.format                   // 'qcow2'

// Check limits
if (cores > ConfigDefaults.limits.maxCpuCores) {
  throw new Error('Too many CPU cores')
}
```

### TypeScript Configuration

For optimal TypeScript support, ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "strict": true,
    "esModuleInterop": true
  }
}
```

## Implementation Status

Completed features:

- Core process management (QemuProcess, QemuCommandBuilder)
- QMP communication (QMPClient)
- Network management (TapDeviceManager, NftablesService)
- Storage management (QemuImgService, SnapshotManager)
- State synchronization (StateSync, EventHandler, HealthMonitor)
- Database integration (PrismaAdapter)
- **VM Lifecycle orchestration (VMLifecycle, Infinivirt)**
- **Consolidated type system (vm.types.ts, config.types.ts)**
- **Unattended OS installation (UnattendedInstaller, InstallationMonitor)**
