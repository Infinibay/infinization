# QEMU Options Reference para Infinization

Este documento detalla las opciones de QEMU relevantes para implementar Infinization, basado en el análisis del código actual de Infinibay y las capacidades de QEMU.

## Mapeo: Funcionalidad Actual → Opciones QEMU

### 1. CPU

**Código actual (libvirt XML):**
```xml
<vcpu placement='static'>4</vcpu>
```

**QEMU equivalente:**
```bash
# Número de CPUs
-smp 4
# O configuración avanzada
-smp cores=4,threads=2,sockets=1

# Tipo de CPU (RECOMENDADO: host para KVM)
-cpu host

# CPU pinning (requiere cgroups o taskset externo)
# QEMU no tiene opción directa, se usa:
taskset -c 0-3 qemu-system-x86_64 ...
```

**Consideraciones para Infinization:**
- Usar siempre `-cpu host` con KVM para máximo rendimiento
- CPU pinning debe implementarse externamente (cgroups v2)
- Las estrategias BasicStrategy/HybridRandomStrategy del backend se traducen a configuración de cgroups

---

### 2. Memoria

**Código actual:**
```xml
<memory unit='KiB'>4194304</memory>
<currentMemory unit='KiB'>4194304</currentMemory>
```

**QEMU equivalente:**
```bash
# RAM fija
-m 4G
# O en MB
-m 4096M

# RAM con hotplug habilitado
-m 1G,slots=3,maxmem=4G

# Balloon device (ajuste dinámico)
-device virtio-balloon-pci,id=balloon0
```

**Consideraciones para Infinization:**
- Para VMs de producción: memoria fija sin hotplug (más simple)
- Balloon device útil para overcommit de memoria del host
- `maxmem` debe estar alineado a page size del host

---

### 3. Disco

**Código actual:**
```xml
<disk type='file' device='disk'>
  <driver name='qemu' type='qcow2'/>
  <source file='/var/lib/libvirt/images/vm-123.qcow2'/>
  <target dev='vda' bus='virtio'/>
</disk>
```

**QEMU equivalente (forma moderna):**
```bash
# Backend de almacenamiento
-blockdev driver=file,node-name=disk0-file,filename=/var/lib/libvirt/images/vm-123.qcow2
-blockdev driver=qcow2,node-name=disk0,file=disk0-file

# Frontend virtio-blk (más rápido)
-device virtio-blk-pci,drive=disk0

# O frontend virtio-scsi (más flexible, soporta TRIM)
-device virtio-scsi-pci,id=scsi0
-device scsi-hd,drive=disk0,bus=scsi0.0
```

**QEMU equivalente (forma legacy, más simple):**
```bash
-drive file=/var/lib/libvirt/images/vm-123.qcow2,format=qcow2,if=virtio
```

**Opciones de cache:**
```bash
# Sin cache (seguro, lento)
-drive file=disk.qcow2,cache=none

# Writeback (rápido, menos seguro)
-drive file=disk.qcow2,cache=writeback

# Para SSD con TRIM
-drive file=disk.qcow2,discard=unmap
```

**Consideraciones para Infinization:**
- Usar qcow2 para snapshots y thin provisioning
- virtio-blk para máximo rendimiento
- virtio-scsi si se necesita TRIM/discard
- Cache writeback para SSDs, none para HDDs

---

### 4. Red

**Código actual:**
```xml
<interface type='network'>
  <mac address='52:54:00:12:34:56'/>
  <source network='default'/>
  <model type='virtio'/>
  <filterref filter='ibay-vm-123'/>
</interface>
```

**QEMU equivalente:**
```bash
# TAP device conectado a bridge
-netdev tap,id=net0,ifname=vnet0,script=no,downscript=no
-device virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56

# O bridge helper (requiere configuración previa)
-netdev bridge,id=net0,br=virbr0
-device virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56
```

**Modo usuario (NAT simple, sin root):**
```bash
-netdev user,id=net0,hostfwd=tcp::2222-:22
-device virtio-net-pci,netdev=net0
```

**Multiqueue (alto rendimiento):**
```bash
-netdev tap,id=net0,ifname=vnet0,queues=4,vhost=on
-device virtio-net-pci,netdev=net0,mq=on,vectors=10
```

**Consideraciones para Infinization:**
- TAP devices requieren crear/configurar manualmente (ip tuntap add)
- Bridge debe existir previamente
- MAC address debe ser única y en rango QEMU (52:54:00:xx:xx:xx)
- El firewall (nwfilter equivalent) debe aplicarse al TAP device

---

### 5. Display (VNC/SPICE)

**Código actual:**
```xml
<graphics type='spice' port='5901' autoport='yes' listen='0.0.0.0'>
  <listen type='address' address='0.0.0.0'/>
</graphics>
```

**QEMU VNC:**
```bash
# VNC en puerto 5900 + display number
-vnc :0                           # Puerto 5900
-vnc :1,password=on               # Puerto 5901 con auth
-vnc 0.0.0.0:0                    # Escuchar en todas las interfaces
-vnc unix:/tmp/vm-vnc.sock        # Unix socket (más seguro)

# VGA driver para VNC
-vga std                          # Standard VGA, hasta 2560x1600
```

**QEMU SPICE (mejor experiencia):**
```bash
# SPICE server
-spice port=5901,addr=0.0.0.0,disable-ticketing=on
# O con password
-spice port=5901,addr=0.0.0.0,password=secret

# QXL driver paravirtual
-vga qxl

# Guest agent para copy/paste
-device virtio-serial-pci
-device virtserialport,chardev=spicechannel0,name=com.redhat.spice.0
-chardev spicevmc,id=spicechannel0,name=vdagent
```

**Consideraciones para Infinization:**
- SPICE preferido para Linux guests
- VNC para compatibilidad universal
- Password limitado a 8 caracteres (inseguro para redes públicas)
- Para producción: usar tickets o TLS

---

### 6. Boot y Firmware

**Código actual:**
```xml
<os>
  <type arch='x86_64' machine='pc-q35-4.2'>hvm</type>
  <boot dev='cdrom'/>
  <boot dev='hd'/>
</os>
```

**QEMU BIOS (legacy):**
```bash
# Default, no requiere opción especial
-boot order=dc    # d=cdrom, c=hard disk
-boot menu=on     # Mostrar menú de boot
```

**QEMU UEFI:**
```bash
# Con OVMF firmware
-bios /usr/share/OVMF/OVMF_CODE.fd

# UEFI con vars persistentes (recomendado)
-drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd
-drive if=pflash,format=raw,file=/var/lib/infinization/vm-123/OVMF_VARS.fd
```

**Instalación de OVMF:**
```bash
# Ubuntu/Debian
apt install ovmf

# RHEL/Fedora
dnf install edk2-ovmf
```

**Consideraciones para Infinization:**
- Windows 11 requiere UEFI + Secure Boot
- Linux moderno funciona con ambos
- OVMF_VARS debe ser copia por VM (no compartir)

---

### 7. ISO/CD-ROM

**Código actual (para instalación):**
```xml
<disk type='file' device='cdrom'>
  <source file='/tmp/custom-install.iso'/>
  <target dev='sda' bus='sata'/>
</disk>
```

**QEMU equivalente:**
```bash
# CD-ROM simple
-cdrom /path/to/install.iso

# O forma explícita
-drive file=/path/to/install.iso,media=cdrom,readonly=on

# Múltiples CD-ROMs
-drive file=os.iso,index=0,media=cdrom
-drive file=drivers.iso,index=1,media=cdrom
```

**Consideraciones para Infinization:**
- Generar ISO personalizado para unattended install (como hace el backend actual)
- Remover CD-ROM después de instalación (via QMP)

---

### 8. Machine Type

**Código actual:**
```xml
<type arch='x86_64' machine='pc-q35-4.2'>hvm</type>
```

**QEMU equivalente:**
```bash
# Q35 chipset (moderno, PCIe nativo)
-machine q35,accel=kvm

# i440FX (legacy, más compatible)
-machine pc,accel=kvm

# Con opciones adicionales
-machine q35,accel=kvm,kernel-irqchip=split
```

**Consideraciones para Infinization:**
- Q35 para VMs modernas (PCIe, USB 3.0)
- i440FX si hay problemas de compatibilidad

---

### 9. GPU Passthrough

**Código actual:**
```xml
<hostdev mode='subsystem' type='pci' managed='yes'>
  <source>
    <address domain='0x0000' bus='0x01' slot='0x00' function='0x0'/>
  </source>
</hostdev>
```

**QEMU equivalente:**
```bash
# GPU passthrough (requiere IOMMU, vfio-pci)
-device vfio-pci,host=01:00.0,multifunction=on

# Con audio de GPU
-device vfio-pci,host=01:00.0
-device vfio-pci,host=01:00.1  # Audio function

# Romfile (algunos GPUs lo necesitan)
-device vfio-pci,host=01:00.0,romfile=/path/to/gpu.rom
```

**Prerequisitos:**
```bash
# 1. Habilitar IOMMU en kernel
# /etc/default/grub: GRUB_CMDLINE_LINUX="intel_iommu=on iommu=pt"

# 2. Cargar vfio-pci
modprobe vfio-pci

# 3. Bind GPU a vfio-pci
echo "10de 1b80" > /sys/bus/pci/drivers/vfio-pci/new_id
```

**Consideraciones para Infinization:**
- GPU passthrough requiere configuración del host (IOMMU groups)
- El backend actual ya valida pciBus en createMachine

---

### 10. Aceleración KVM

**QEMU con KVM:**
```bash
# Habilitar KVM (CRÍTICO para rendimiento)
-enable-kvm
# O
-accel kvm

# Fallback a TCG (emulación, muy lento)
-accel kvm -accel tcg
```

**Verificar soporte KVM:**
```bash
# Debe retornar 0 bytes
cat /dev/kvm

# O
kvm-ok
```

**Consideraciones para Infinization:**
- SIEMPRE usar KVM si está disponible
- Sin KVM, rendimiento es ~10x menor

---

### 11. QMP (QEMU Machine Protocol)

**Habilitar QMP:**
```bash
# Unix socket (recomendado)
-qmp unix:/var/run/infinization/vm-123.sock,server,nowait

# TCP (menos seguro)
-qmp tcp:localhost:4444,server,nowait

# Múltiples monitores
-chardev socket,id=qmp1,path=/var/run/vm.sock,server,nowait
-mon chardev=qmp1,mode=control
```

**Comandos QMP principales:**

```json
// Iniciar sesión QMP
{ "execute": "qmp_capabilities" }

// Estado de la VM
{ "execute": "query-status" }
// Response: { "return": { "running": true, "singlestep": false, "status": "running" } }

// Pausar VM
{ "execute": "stop" }

// Continuar VM
{ "execute": "cont" }

// Shutdown graceful
{ "execute": "system_powerdown" }

// Reset
{ "execute": "system_reset" }

// Info de CPUs
{ "execute": "query-cpus-fast" }

// Info de bloques
{ "execute": "query-block" }

// Snapshot
{ "execute": "blockdev-snapshot-internal-sync",
  "arguments": { "device": "disk0", "name": "snap1" } }

// Eject CD
{ "execute": "eject", "arguments": { "device": "ide1-cd0" } }

// Hot-add disco
{ "execute": "blockdev-add", "arguments": { "driver": "file", "node-name": "file1", "filename": "/path/to/disk.qcow2" } }
{ "execute": "device_add", "arguments": { "driver": "virtio-blk-pci", "drive": "file1" } }
```

**Consideraciones para Infinization:**
- Unix socket es más seguro que TCP
- Siempre ejecutar `qmp_capabilities` primero
- Usar para monitoreo, snapshots, hot-plug

---

## Comando Completo de Ejemplo

Basado en la configuración típica de Infinibay:

```bash
qemu-system-x86_64 \
  # Aceleración
  -enable-kvm \
  -machine q35,accel=kvm \

  # CPU y memoria
  -cpu host \
  -smp 4 \
  -m 4G \

  # UEFI firmware
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd \
  -drive if=pflash,format=raw,file=/var/lib/infinization/vms/vm-123/OVMF_VARS.fd \

  # Disco principal
  -drive file=/var/lib/infinization/vms/vm-123/disk.qcow2,format=qcow2,if=virtio,cache=writeback \

  # CD-ROM para instalación
  -drive file=/tmp/infinization/vm-123/install.iso,media=cdrom \

  # Red
  -netdev tap,id=net0,ifname=vnet-vm123,script=no,downscript=no \
  -device virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56 \

  # Display SPICE
  -vga qxl \
  -spice port=5901,addr=0.0.0.0,disable-ticketing=on \
  -device virtio-serial-pci \
  -device virtserialport,chardev=spicechannel0,name=com.redhat.spice.0 \
  -chardev spicevmc,id=spicechannel0,name=vdagent \

  # QMP socket
  -qmp unix:/var/run/infinization/vm-123.sock,server,nowait \

  # Misc
  -name vm-123 \
  -uuid 550e8400-e29b-41d4-a716-446655440000 \
  -daemonize \
  -pidfile /var/run/infinization/vm-123.pid
```

---

## Diferencias Clave: Libvirt vs QEMU Directo

| Aspecto | Libvirt | QEMU Directo |
|---------|---------|--------------|
| Gestión TAP | Automática | Manual (ip tuntap) |
| Bridge setup | Automático | Manual (brctl/ip link) |
| MAC address | Generada | Manual |
| Puerto SPICE/VNC | Autoport | Manual |
| Firewall | nwfilter XML | nftables/eBPF manual |
| PID tracking | Automático | Manual |
| Cleanup on crash | Automático | Manual |
| Storage pools | Abstracción | Paths directos |

---

## Siguientes Pasos para Infinization

1. **Networking**: Implementar creación/destrucción de TAP devices
2. **Storage**: Crear/redimensionar imágenes qcow2 con qemu-img
3. **QMP**: Wrapper TypeScript para comunicación via socket
4. **Process management**: Spawning seguro de procesos QEMU
5. **State sync**: Sincronizar estado QEMU ↔ PostgreSQL
