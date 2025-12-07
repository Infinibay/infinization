import path from 'path'
import {
  MachineType,
  MachineOptions,
  DiskOptions,
  NetworkOptions,
  SpiceOptions,
  VncOptions,
  BootDevice,
  QemuProcessOptions,
  validatePciAddress
} from '../types/qemu.types'
import { SpiceConfig } from '../display/SpiceConfig'
import { VncConfig } from '../display/VncConfig'

/**
 * Result of buildCommand() containing the binary and arguments separately
 */
export interface QemuCommand {
  command: string
  args: string[]
}

/**
 * QemuCommandBuilder provides a fluent API for building QEMU command arrays.
 * It supports all essential QEMU options for VM management.
 */
export class QemuCommandBuilder {
  private static readonly ALLOWED_ROM_DIR = '/var/lib/infinivirt/roms/'

  private binary: string = 'qemu-system-x86_64'
  private args: string[] = []
  private daemonizeEnabled: boolean = false
  private pidfilePath: string | null = null

  /**
   * Set the QEMU binary to use
   * @param binary - Path or name of the QEMU binary (default: qemu-system-x86_64)
   */
  setBinary (binary: string): this {
    this.binary = binary
    return this
  }

  /**
   * Get the configured binary name
   */
  getBinary (): string {
    return this.binary
  }

  /**
   * Check if daemonize is enabled
   */
  isDaemonizeEnabled (): boolean {
    return this.daemonizeEnabled
  }

  /**
   * Get the configured pidfile path
   */
  getPidfilePath (): string | null {
    return this.pidfilePath
  }

  /**
   * Validates that a ROM file path is within the allowed directory.
   * Prevents directory traversal attacks by normalizing the path.
   *
   * @param romfile - Path to ROM file
   * @returns The normalized absolute path
   * @throws Error if path is outside allowed directory
   */
  private static validateRomPath (romfile: string): string {
    const normalizedPath = path.resolve(romfile)
    if (!normalizedPath.startsWith(QemuCommandBuilder.ALLOWED_ROM_DIR)) {
      throw new Error(
        `ROM file must be in ${QemuCommandBuilder.ALLOWED_ROM_DIR}. ` +
        `Attempted path: ${romfile}`
      )
    }
    return normalizedPath
  }

  /**
   * Enable KVM hardware acceleration
   */
  enableKvm (): this {
    this.args.push('-enable-kvm')
    return this
  }

  /**
   * Set machine type (q35 or pc)
   * @param type - Machine type
   * @param options - Optional machine options (accel, kernelIrqchip)
   */
  setMachine (type: MachineType, options?: MachineOptions): this {
    let machineArg = type
    if (options?.accel) {
      machineArg += `,accel=${options.accel}`
    }
    if (options?.kernelIrqchip) {
      machineArg += `,kernel-irqchip=${options.kernelIrqchip}`
    }
    this.args.push('-machine', machineArg)
    return this
  }

  /**
   * Set CPU model and topology
   * @param model - CPU model (e.g., 'host')
   * @param cores - Number of CPU cores
   * @param threads - Threads per core (optional)
   * @param sockets - Number of sockets (optional)
   */
  setCpu (model: string, cores?: number, threads?: number, sockets?: number): this {
    this.args.push('-cpu', model)
    if (cores !== undefined) {
      let smpArg = `cores=${cores}`
      if (threads !== undefined) {
        smpArg += `,threads=${threads}`
      }
      if (sockets !== undefined) {
        smpArg += `,sockets=${sockets}`
      }
      this.args.push('-smp', smpArg)
    }
    return this
  }

  /**
   * Set memory size in GB
   * @param sizeGB - Memory size in gigabytes
   */
  setMemory (sizeGB: number): this {
    this.args.push('-m', `${sizeGB}G`)
    return this
  }

  /**
   * Add multiple disk drives with proper indexing.
   * Each disk is added as a separate -drive argument with sequential index.
   *
   * @param disks - Array of disk configuration options
   * @returns this for method chaining
   *
   * @example
   * builder.addDisks([
   *   { path: '/path/disk1.qcow2', format: 'qcow2', bus: 'virtio', cache: 'writeback' },
   *   { path: '/path/disk2.qcow2', format: 'qcow2', bus: 'virtio', cache: 'writeback' }
   * ])
   * // Generates:
   * // -drive file=/path/disk1.qcow2,format=qcow2,if=virtio,cache=writeback,index=0,discard=unmap
   * // -drive file=/path/disk2.qcow2,format=qcow2,if=virtio,cache=writeback,index=1,discard=unmap
   */
  addDisks (disks: DiskOptions[]): this {
    disks.forEach((disk, index) => {
      let driveArg = `file=${disk.path},format=${disk.format},if=${disk.bus},cache=${disk.cache},index=${index}`
      if (disk.discard) {
        driveArg += ',discard=unmap'
      }
      this.args.push('-drive', driveArg)
    })
    return this
  }

  /**
   * Add a network interface using TAP device
   * @param options - Network configuration options
   */
  addNetwork (options: NetworkOptions): this {
    let netdevArg = `tap,id=net0,ifname=${options.tapName},script=no,downscript=no`
    if (options.queues !== undefined && options.queues > 1) {
      netdevArg += `,queues=${options.queues},vhost=on`
    }
    this.args.push('-netdev', netdevArg)

    let deviceArg = `${options.model},netdev=net0,mac=${options.mac}`
    if (options.queues !== undefined && options.queues > 1) {
      deviceArg += `,mq=on,vectors=${options.queues * 2 + 2}`
    }
    this.args.push('-device', deviceArg)
    return this
  }

  /**
   * Add SPICE display
   *
   * @param options - SPICE configuration options or SpiceConfig instance
   *
   * @remarks
   * When using the legacy `SpiceOptions` object, the guest agent (virtio-serial for
   * copy/paste) is enabled by default. Set `enableAgent: false` to disable it.
   *
   * When using `SpiceConfig`, the guest agent behavior is controlled by the
   * `enableAgent` option passed to the SpiceConfig constructor (also defaults to true).
   *
   * @example
   * ```typescript
   * // Using SpiceConfig (recommended)
   * const spiceConfig = new SpiceConfig({
   *   port: 5901,
   *   addr: '0.0.0.0',
   *   enableAgent: false  // Disable guest agent
   * })
   * builder.addSpice(spiceConfig)
   *
   * // Using legacy options
   * builder.addSpice({
   *   port: 5901,
   *   addr: '0.0.0.0',
   *   enableAgent: false  // Disable guest agent
   * })
   * ```
   */
  addSpice (options: SpiceOptions | SpiceConfig): this {
    // Check if options is a SpiceConfig instance
    if (options instanceof SpiceConfig) {
      const { args } = options.generateArgs()
      this.args.push(...args)
      return this
    }

    // Legacy options object handling
    let spiceArg = `port=${options.port},addr=${options.addr}`
    if (options.password) {
      spiceArg += `,password=${options.password}`
    } else if (options.disableTicketing) {
      spiceArg += ',disable-ticketing=on'
    }
    this.args.push('-spice', spiceArg)
    this.args.push('-vga', 'qxl')

    // Add virtio-serial for guest agent (enabled by default)
    const enableAgent = options.enableAgent ?? true
    if (enableAgent) {
      this.args.push('-device', 'virtio-serial-pci')
      this.args.push('-device', 'virtserialport,chardev=spicechannel0,name=com.redhat.spice.0')
      this.args.push('-chardev', 'spicevmc,id=spicechannel0,name=vdagent')
    }

    return this
  }

  /**
   * Add VNC display
   * @param options - VNC configuration options or VncConfig instance
   */
  addVnc (options: VncOptions | VncConfig): this {
    // Check if options is a VncConfig instance
    if (options instanceof VncConfig) {
      const { args } = options.generateArgs()
      this.args.push(...args)
      return this
    }

    // Legacy options object handling
    let vncArg = `${options.addr}:${options.display}`
    if (options.password) {
      vncArg += ',password=on'
    }
    this.args.push('-vnc', vncArg)
    this.args.push('-vga', 'std')
    return this
  }

  /**
   * Add QMP socket for management
   * @param socketPath - Path to Unix socket
   */
  addQmp (socketPath: string): this {
    this.args.push('-qmp', `unix:${socketPath},server,nowait`)
    return this
  }

  /**
   * Add CD-ROM drive
   * @param isoPath - Path to ISO file
   */
  addCdrom (isoPath: string): this {
    this.args.push('-cdrom', isoPath)
    return this
  }

  /**
   * Add GPU passthrough via VFIO-PCI.
   *
   * Passes through a GPU to the VM for direct hardware access.
   * Automatically enables multifunction support for GPU passthrough.
   *
   * @param pciBus - PCI bus address (e.g., '01:00.0' or '0000:01:00.0')
   * @param romfile - Optional path to GPU ROM file (must be in /var/lib/infinivirt/roms/)
   * @returns this for method chaining
   * @throws Error if PCI address format is invalid
   *
   * @remarks
   * **Prerequisites:**
   * - IOMMU must be enabled in BIOS and kernel (intel_iommu=on or amd_iommu=on)
   * - vfio-pci kernel module must be loaded
   * - GPU must be bound to vfio-pci driver (not host driver)
   * - Use Q35 machine type for best compatibility
   *
   * **Important:**
   * - Host cannot use the GPU while it's passed through to VM
   * - UEFI firmware is recommended for GPU passthrough
   *
   * **Security:**
   * - ROM files must be located in /var/lib/infinivirt/roms/
   * - Path traversal attempts will be rejected
   *
   * @example
   * ```typescript
   * const builder = new QemuCommandBuilder()
   *   .enableKvm()
   *   .setMachine('q35')
   *   .addGpuPassthrough('01:00.0')
   *   .addGpuPassthrough('0000:02:00.0', '/var/lib/infinivirt/roms/gpu.rom')
   * ```
   */
  addGpuPassthrough (pciBus: string, romfile?: string): this {
    const validation = validatePciAddress(pciBus)
    if (!validation.valid) {
      throw new Error(`Invalid PCI address '${pciBus}': ${validation.error}`)
    }

    const safeRomfile = romfile ? QemuCommandBuilder.validateRomPath(romfile) : undefined

    let deviceArg = `vfio-pci,host=${pciBus},multifunction=on`
    if (safeRomfile) {
      deviceArg += `,romfile=${safeRomfile}`
    }
    this.args.push('-device', deviceArg)
    return this
  }

  /**
   * Add GPU passthrough with integrated audio (HDMI/DisplayPort audio).
   *
   * Modern GPUs often have a separate audio function for HDMI/DisplayPort audio output.
   * This method passes through both the GPU and its audio device.
   *
   * @param gpuBus - PCI bus address of the GPU (e.g., '01:00.0')
   * @param audioBus - PCI bus address of the audio function (e.g., '01:00.1') - must differ from gpuBus
   * @param romfile - Optional path to GPU ROM file
   * @returns this for method chaining
   * @throws Error if any PCI address format is invalid
   * @throws Error if gpuBus and audioBus are the same address
   *
   * @remarks
   * Typical NVIDIA/AMD GPU configuration:
   * - GPU function: 01:00.0 (VGA controller)
   * - Audio function: 01:00.1 (Audio device)
   *
   * Use `lspci` to find the correct addresses for your GPU.
   *
   * @example
   * ```typescript
   * const builder = new QemuCommandBuilder()
   *   .enableKvm()
   *   .setMachine('q35')
   *   .addGpuWithAudio('01:00.0', '01:00.1')
   * ```
   */
  addGpuWithAudio (gpuBus: string, audioBus: string, romfile?: string): this {
    const gpuValidation = validatePciAddress(gpuBus)
    if (!gpuValidation.valid) {
      throw new Error(`Invalid GPU PCI address '${gpuBus}': ${gpuValidation.error}`)
    }

    const audioValidation = validatePciAddress(audioBus)
    if (!audioValidation.valid) {
      throw new Error(`Invalid audio PCI address '${audioBus}': ${audioValidation.error}`)
    }

    // Guard: GPU and audio PCI addresses must differ
    if (gpuBus === audioBus) {
      throw new Error(
        `GPU and audio PCI addresses must differ. ` +
        `Both were set to '${gpuBus}'. ` +
        `Typically, GPU is at xx:xx.0 and audio at xx:xx.1 (e.g., 01:00.0 and 01:00.1)`
      )
    }

    // Add GPU with multifunction enabled
    this.addGpuPassthrough(gpuBus, romfile)

    // Add audio device without multifunction
    this.args.push('-device', `vfio-pci,host=${audioBus}`)

    return this
  }

  /**
   * Add generic PCI device passthrough via VFIO-PCI.
   *
   * Passes through any PCI device to the VM. Unlike `addGpuPassthrough`,
   * this method does not enable multifunction by default.
   *
   * Useful for passing through USB controllers, network cards, storage
   * controllers, and other PCI devices.
   *
   * @param pciBus - PCI bus address (e.g., '04:00.0' or '0000:04:00.0')
   * @param romfile - Optional path to device ROM file (must be in /var/lib/infinivirt/roms/)
   * @returns this for method chaining
   * @throws Error if PCI address format is invalid
   *
   * @remarks
   * **Prerequisites:**
   * - IOMMU must be enabled
   * - Device must be bound to vfio-pci driver
   * - Check IOMMU groups to ensure isolation
   *
   * **Security:**
   * - ROM files must be located in /var/lib/infinivirt/roms/
   * - Path traversal attempts will be rejected
   *
   * @example
   * ```typescript
   * const builder = new QemuCommandBuilder()
   *   .enableKvm()
   *   .setMachine('q35')
   *   .addPciPassthrough('04:00.0')  // USB controller
   *   .addPciPassthrough('05:00.0')  // Network card
   * ```
   */
  addPciPassthrough (pciBus: string, romfile?: string): this {
    const validation = validatePciAddress(pciBus)
    if (!validation.valid) {
      throw new Error(`Invalid PCI address '${pciBus}': ${validation.error}`)
    }

    const safeRomfile = romfile ? QemuCommandBuilder.validateRomPath(romfile) : undefined

    let deviceArg = `vfio-pci,host=${pciBus}`
    if (safeRomfile) {
      deviceArg += `,romfile=${safeRomfile}`
    }
    this.args.push('-device', deviceArg)
    return this
  }

  /**
   * Add memory balloon device for dynamic memory management.
   *
   * The virtio-balloon device enables dynamic memory management, allowing the host
   * to reclaim memory from or grant memory to the guest at runtime.
   *
   * @returns this for method chaining
   *
   * @remarks
   * **Guest Requirements:**
   * - The guest OS must have the virtio-balloon driver installed
   * - Linux guests typically have this driver built-in
   * - Windows guests require virtio drivers to be installed
   *
   * **Runtime Control:**
   * - Use QMP `balloon` command to request memory size changes
   * - Use QMP `query-balloon` to check current balloon size
   *
   * **Recommended Use Cases:**
   * - Memory overcommitment scenarios
   * - Dynamic resource allocation based on workload
   * - Consolidation of VMs on a single host
   *
   * @example
   * ```typescript
   * const builder = new QemuCommandBuilder()
   *   .enableKvm()
   *   .setMachine('q35')
   *   .setMemory(8)
   *   .addMemoryBalloon()  // Enable dynamic memory management
   *   .addDisk({ ... })
   * ```
   */
  addMemoryBalloon (): this {
    this.args.push('-device', 'virtio-balloon-pci')
    return this
  }

  /**
   * Enable hugepages for improved memory performance.
   *
   * Hugepages reduce TLB misses and improve memory access performance for VMs
   * with large memory allocations. Requires host system to have hugepages
   * configured and mounted at /dev/hugepages.
   *
   * @returns this for method chaining
   *
   * @remarks
   * **Host Requirements:**
   * - Hugepages must be configured in kernel boot parameters
   * - /dev/hugepages must be mounted (typically via systemd)
   * - Sufficient hugepages must be allocated for the VM's memory size
   *
   * **Configuration:**
   * - Add to kernel boot params: `hugepagesz=2M hugepages=N` (where N = total GB * 512)
   * - Verify with: `cat /proc/meminfo | grep Huge`
   * - Check mount: `mount | grep hugepages`
   *
   * **Performance Impact:**
   * - Reduces TLB pressure for large memory VMs (>4GB)
   * - Improves memory-intensive workload performance
   * - Requires pre-allocation (memory not swappable)
   *
   * @example
   * ```typescript
   * const builder = new QemuCommandBuilder()
   *   .enableKvm()
   *   .setMachine('q35')
   *   .setMemory(16)
   *   .enableHugepages()  // Enable hugepages for 16GB VM
   *   .addDisk({ ... })
   * ```
   */
  enableHugepages (): this {
    this.args.push('-mem-prealloc')
    this.args.push('-mem-path', '/dev/hugepages')
    return this
  }

  /**
   * Set firmware for UEFI boot using OVMF.
   *
   * Configures the VM to boot with UEFI firmware instead of legacy BIOS.
   * Requires OVMF firmware files to be installed on the host system.
   *
   * @param firmwarePath - Path to OVMF code file (e.g., /usr/share/OVMF/OVMF_CODE.fd)
   * @returns this for method chaining
   *
   * @remarks
   * **OVMF Files Required:**
   * - Code file: Contains UEFI firmware code (read-only)
   * - Vars file: Contains UEFI variables (read-write, per-VM)
   *
   * **Secure Boot:**
   * For UEFI Secure Boot, callers must provide a Secure Boot-capable firmware file
   * (e.g., OVMF_CODE.secboot.fd instead of OVMF_CODE.fd). This method does not
   * modify QEMU arguments based on Secure Boot status - the firmware file itself
   * determines whether Secure Boot is available to the guest.
   *
   * **Host Requirements:**
   * - Install ovmf package: `apt install ovmf` (Debian/Ubuntu) or `dnf install edk2-ovmf` (Fedora/RHEL)
   * - Files typically located in /usr/share/OVMF/ or /usr/share/edk2/ovmf/
   *
   * @example
   * ```typescript
   * // Standard UEFI boot
   * builder.setFirmware('/usr/share/OVMF/OVMF_CODE.fd')
   *
   * // UEFI with Secure Boot (use secboot-capable firmware)
   * builder.setFirmware('/usr/share/OVMF/OVMF_CODE.secboot.fd')
   * ```
   */
  setFirmware (firmwarePath: string): this {
    // Add OVMF code (read-only firmware)
    this.args.push('-drive', `if=pflash,format=raw,readonly=on,file=${firmwarePath}`)

    // Note: OVMF vars file (per-VM UEFI variables) should be passed via setUefiVars
    // to ensure each VM has its own vars file.

    return this
  }

  /**
   * Set UEFI variables file for per-VM UEFI settings persistence.
   *
   * This file stores UEFI variables (boot entries, secure boot state, etc.)
   * and should be unique to each VM. The file should be created by copying
   * a template file (e.g., /usr/share/OVMF/OVMF_VARS.fd) to the VM's directory.
   *
   * @param varsPath - Path to the VM-specific UEFI vars file
   * @returns this for method chaining
   *
   * @example
   * ```typescript
   * // Create UEFI boot with per-VM vars
   * builder
   *   .setFirmware('/usr/share/OVMF/OVMF_CODE.fd')
   *   .setUefiVars('/var/lib/infinivirt/vms/myvm/uefi-vars.fd')
   * ```
   */
  setUefiVars (varsPath: string): this {
    // Add OVMF vars (read-write per-VM variables)
    this.args.push('-drive', `if=pflash,format=raw,file=${varsPath}`)
    return this
  }

  /**
   * Set boot order
   * @param devices - Array of boot devices (c=disk, d=cdrom, n=network)
   */
  setBootOrder (devices: BootDevice[]): this {
    this.args.push('-boot', `order=${devices.join('')}`)
    return this
  }

  // ===========================================================================
  // TPM Support
  // ===========================================================================

  /**
   * Add TPM 2.0 emulator device.
   *
   * Requires swtpm to be running. The socket path should point to the
   * swtpm control socket.
   *
   * @param socketPath - Path to swtpm socket (e.g., /var/lib/swtpm/vmid/swtpm-sock)
   * @returns this for method chaining
   *
   * @example
   * ```typescript
   * // Add TPM 2.0 with swtpm
   * builder.addTPM('/var/lib/swtpm/my-vm/swtpm-sock')
   * ```
   */
  addTPM (socketPath: string): this {
    // chardev for swtpm socket
    this.args.push('-chardev', `socket,id=chrtpm,path=${socketPath}`)
    // TPM device backend
    this.args.push('-tpmdev', 'emulator,id=tpm0,chardev=chrtpm')
    // TPM TIS device
    this.args.push('-device', 'tpm-tis,tpmdev=tpm0')
    return this
  }

  // ===========================================================================
  // VirtIO Serial Channels
  // ===========================================================================

  private virtioSerialAdded: boolean = false
  private virtioSerialPortCount: number = 0

  /**
   * Ensures virtio-serial-pci controller is added (only once).
   * Called automatically by addVirtioChannel methods.
   */
  private ensureVirtioSerial (): void {
    if (!this.virtioSerialAdded) {
      this.args.push('-device', 'virtio-serial-pci,id=virtio-serial0')
      this.virtioSerialAdded = true
    }
  }

  /**
   * Add a VirtIO serial channel with Unix socket backend.
   *
   * This is the base method for adding virtio-serial channels like
   * QEMU Guest Agent, InfiniService, etc.
   *
   * @param channelName - The virtio channel name (e.g., 'org.qemu.guest_agent.0')
   * @param socketPath - Path to Unix socket for host communication
   * @param chardevId - Unique chardev identifier
   * @returns this for method chaining
   */
  addVirtioChannel (channelName: string, socketPath: string, chardevId: string): this {
    this.ensureVirtioSerial()

    // Add chardev for socket communication
    this.args.push('-chardev', `socket,path=${socketPath},server=on,wait=off,id=${chardevId}`)

    // Add virtio serial port
    this.args.push('-device', `virtserialport,chardev=${chardevId},name=${channelName}`)

    this.virtioSerialPortCount++
    return this
  }

  /**
   * Add QEMU Guest Agent channel.
   *
   * Enables communication with qemu-guest-agent inside the VM for:
   * - File operations (read/write files)
   * - Network configuration
   * - Process execution
   * - System commands (shutdown, suspend)
   *
   * @param socketPath - Path to guest agent socket
   * @returns this for method chaining
   *
   * @example
   * ```typescript
   * builder.addGuestAgentChannel('/var/run/qemu/vm1-ga.sock')
   * ```
   */
  addGuestAgentChannel (socketPath: string): this {
    return this.addVirtioChannel(
      'org.qemu.guest_agent.0',
      socketPath,
      'chagent0'
    )
  }

  /**
   * Add InfiniService channel for custom host-VM communication.
   *
   * Used for metrics collection, health monitoring, and management
   * operations specific to Infinibay.
   *
   * @param socketPath - Path to InfiniService socket
   * @returns this for method chaining
   *
   * @example
   * ```typescript
   * builder.addInfiniServiceChannel('/opt/infinibay/sockets/vm-123.socket')
   * ```
   */
  addInfiniServiceChannel (socketPath: string): this {
    return this.addVirtioChannel(
      'com.infinibay.infiniservice.0',
      socketPath,
      'chinfini0'
    )
  }

  // ===========================================================================
  // Additional CD-ROM Support
  // ===========================================================================

  private cdromCount: number = 0

  /**
   * Add an additional CD-ROM drive.
   *
   * Useful for attaching VirtIO drivers ISO alongside the installation ISO.
   *
   * @param isoPath - Path to ISO file
   * @param index - Optional drive index (auto-incremented if not specified)
   * @returns this for method chaining
   *
   * @example
   * ```typescript
   * // Add installation ISO
   * builder.addCdrom('/path/to/install.iso')
   * // Add VirtIO drivers ISO
   * builder.addSecondCdrom('/path/to/virtio-win.iso')
   * ```
   */
  addSecondCdrom (isoPath: string): this {
    this.cdromCount++
    // Use ide for compatibility, with auto-incrementing index
    this.args.push('-drive', `file=${isoPath},media=cdrom,readonly=on,index=${this.cdromCount + 1}`)
    return this
  }

  // ===========================================================================
  // Audio Device Support
  // ===========================================================================

  /**
   * Add audio device for VM sound support.
   *
   * Uses Intel HDA with output to SPICE for remote audio.
   *
   * @returns this for method chaining
   */
  addAudioDevice (): this {
    // Intel HDA audio controller
    this.args.push('-device', 'intel-hda')
    // HDA output to SPICE
    this.args.push('-device', 'hda-duplex')
    // Audio backend to SPICE
    this.args.push('-audiodev', 'spice,id=audio0')
    return this
  }

  // ===========================================================================
  // USB Support
  // ===========================================================================

  private usbControllerAdded: boolean = false

  /**
   * Ensures USB controller is added (only once).
   */
  private ensureUsbController (): void {
    if (!this.usbControllerAdded) {
      this.args.push('-device', 'qemu-xhci,id=usb')
      this.usbControllerAdded = true
    }
  }

  /**
   * Add USB tablet input device for better mouse synchronization.
   *
   * Provides absolute positioning which works better with SPICE/VNC
   * than relative mouse movement.
   *
   * @returns this for method chaining
   */
  addUsbTablet (): this {
    this.ensureUsbController()
    this.args.push('-device', 'usb-tablet')
    return this
  }

  /**
   * Add USB keyboard device.
   *
   * @returns this for method chaining
   */
  addUsbKeyboard (): this {
    this.ensureUsbController()
    this.args.push('-device', 'usb-kbd')
    return this
  }

  /**
   * Set process options (name, uuid, daemonize, pidfile)
   * @param options - Process configuration options
   */
  setProcessOptions (options: QemuProcessOptions): this {
    this.args.push('-name', options.name)
    if (options.uuid) {
      this.args.push('-uuid', options.uuid)
    }
    if (options.daemonize) {
      this.args.push('-daemonize')
      this.daemonizeEnabled = true
    }
    if (options.pidfile) {
      this.args.push('-pidfile', options.pidfile)
      this.pidfilePath = options.pidfile
    }
    return this
  }

  /**
   * Add a raw argument for advanced use cases
   * @param arg - Raw argument string
   */
  addRawArg (arg: string): this {
    this.args.push(arg)
    return this
  }

  /**
   * Build and return the command and arguments separately
   * @returns Object with command (binary) and args array
   */
  buildCommand (): QemuCommand {
    return {
      command: this.binary,
      args: [...this.args]
    }
  }

  /**
   * Build and return only the arguments array (without the binary)
   * @returns Copy of the command arguments array
   */
  build (): string[] {
    return [...this.args]
  }
}
