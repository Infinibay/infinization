# Funcionalidades Requeridas para Infinivirt

Este documento lista todas las funcionalidades que Infinivirt necesita implementar, basado en el análisis del código actual de Infinibay.

## 1. Gestión del Ciclo de Vida de VMs

### 1.1 Creación de VM

**Input requerido:**
```typescript
interface CreateVMInput {
  name: string
  internalName: string  // UUID único
  os: 'windows10' | 'windows11' | 'fedora' | 'ubuntu'

  // Recursos
  cpuCores: number
  ramGB: number
  diskSizeGB: number

  // Red
  macAddress: string
  networkBridge: string

  // Display
  graphicProtocol: 'spice' | 'vnc'
  graphicPort: number
  graphicPassword: string

  // Opcional
  gpuPciAddress?: string  // Para passthrough
  isoPath?: string        // Para instalación
}
```

**Operaciones:**
1. Generar comando QEMU con todas las opciones
2. Crear TAP device y conectar a bridge
3. Crear imagen de disco (qcow2)
4. Configurar socket QMP
5. Aplicar reglas de firewall
6. Iniciar proceso QEMU
7. Registrar PID y estado en DB

### 1.2 Power Operations

| Operación | QMP Command | Comportamiento |
|-----------|-------------|----------------|
| **powerOn** | `cont` (si paused) o spawn process | Inicia/resume VM |
| **powerOff** | `system_powerdown` | Shutdown graceful (ACPI) |
| **forcePowerOff** | `quit` o SIGKILL | Apagado forzado |
| **suspend** | `stop` | Pausa ejecución |
| **resume** | `cont` | Continúa ejecución |
| **reset** | `system_reset` | Reset hardware |
| **restart** | `system_powerdown` + wait + start | Reinicio completo |

### 1.3 Estados de VM

```typescript
type VMStatus =
  | 'building'            // Creándose
  | 'running'             // Ejecutándose
  | 'off'                 // Apagada
  | 'suspended'           // Pausada (stop)
  | 'paused'              // Pausa temporal
  | 'updating_hardware'   // Actualizando recursos
  | 'powering_off_update' // Apagándose para update
  | 'error'               // Error general
```

**Detección de estado via QMP:**
```json
{ "execute": "query-status" }
// Response: { "return": { "status": "running" | "paused" | "shutdown" | ... } }
```

---

## 2. Gestión de Hardware

### 2.1 CPU

**Funcionalidades:**
- Definir número de vCPUs al crear VM
- Cambiar vCPUs (requiere apagar VM con QEMU vanilla)

**Implementación:**
```bash
# Al crear
-smp 4

# Cambiar requiere recrear VM (sin libvirt live-change)
```

### 2.2 Memoria

**Funcionalidades:**
- Definir RAM al crear VM
- Cambiar RAM (requiere apagar VM)
- Balloon para ajuste dinámico (opcional)

**Implementación:**
```bash
# Al crear
-m 4G

# Con balloon (opcional)
-device virtio-balloon-pci
```

**QMP para balloon:**
```json
{ "execute": "balloon", "arguments": { "value": 2147483648 } }  // 2GB
```

### 2.3 Disco

**Funcionalidades:**
- Crear imagen qcow2 con tamaño específico
- Thin provisioning (grow on demand)
- Redimensionar disco (qemu-img resize)

**Comandos:**
```bash
# Crear imagen
qemu-img create -f qcow2 disk.qcow2 50G

# Info de imagen
qemu-img info disk.qcow2

# Redimensionar (VM apagada)
qemu-img resize disk.qcow2 +20G
```

### 2.4 GPU Passthrough

**Funcionalidades:**
- Agregar GPU dedicado a VM
- Quitar GPU de VM
- Listar GPUs disponibles

**Pre-requisitos del host:**
- IOMMU habilitado (intel_iommu=on)
- GPU bound a vfio-pci

**Implementación:**
```bash
# Al crear/modificar
-device vfio-pci,host=01:00.0,multifunction=on
```

---

## 3. Networking

### 3.1 TAP Device Management

**Funcionalidades:**
- Crear TAP device por VM
- Conectar TAP a bridge
- Asignar MAC address
- Destruir TAP al apagar VM

**Comandos:**
```bash
# Crear TAP
ip tuntap add dev vnet-vm123 mode tap

# Subir interfaz
ip link set vnet-vm123 up

# Conectar a bridge
ip link set vnet-vm123 master virbr0

# Destruir
ip link del vnet-vm123
```

### 3.2 Firewall (nftables)

**Funcionalidades (del sistema actual):**

```typescript
interface FirewallRule {
  id: string
  name: string
  description: string
  action: 'ACCEPT' | 'DROP' | 'REJECT'
  direction: 'IN' | 'OUT' | 'INOUT'
  priority: number
  protocol: 'tcp' | 'udp' | 'icmp' | 'all'
  srcPortStart?: number
  srcPortEnd?: number
  dstPortStart?: number
  dstPortEnd?: number
  srcIpAddr?: string
  srcIpMask?: string
  dstIpAddr?: string
  dstIpMask?: string
  connectionState?: {
    established?: boolean
    new?: boolean
    related?: boolean
    invalid?: boolean
  }
}
```

**Jerarquía:**
- Reglas de Departamento (heredadas por todas las VMs del dept)
- Reglas de VM (específicas, pueden override dept)

**Service Presets (toggles rápidos):**
- SSH (22/tcp)
- HTTP (80/tcp)
- HTTPS (443/tcp)
- RDP (3389/tcp)
- VNC (5900-5999/tcp)

### 3.3 MAC Address

**Generación:**
```typescript
function generateMacAddress(): string {
  // Prefijo QEMU: 52:54:00
  const prefix = '52:54:00'
  const suffix = Array(3)
    .fill(0)
    .map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0'))
    .join(':')
  return `${prefix}:${suffix}`
}
```

---

## 4. Display

### 4.1 SPICE

**Funcionalidades:**
- Puerto dinámico o fijo
- Password authentication
- Copy/paste entre host y guest (con agent)

**Configuración:**
```bash
-vga qxl
-spice port=5901,addr=0.0.0.0,password=secret
-device virtio-serial-pci
-device virtserialport,chardev=spicechannel0,name=com.redhat.spice.0
-chardev spicevmc,id=spicechannel0,name=vdagent
```

### 4.2 VNC

**Funcionalidades:**
- Puerto dinámico o fijo
- Password authentication (max 8 chars)

**Configuración:**
```bash
-vga std
-vnc :1,password=on
```

---

## 5. Snapshots

### 5.1 Operaciones

**Funcionalidades:**
- Crear snapshot
- Listar snapshots
- Restaurar snapshot
- Eliminar snapshot

### 5.2 QMP Commands

```json
// Crear snapshot interno (qcow2)
{
  "execute": "blockdev-snapshot-internal-sync",
  "arguments": {
    "device": "disk0",
    "name": "snapshot-2024-01-01"
  }
}

// Listar snapshots
{ "execute": "query-named-block-nodes" }
// O usar qemu-img:
// qemu-img snapshot -l disk.qcow2

// Restaurar (requiere VM apagada)
// qemu-img snapshot -a snapshot-name disk.qcow2

// Eliminar
{
  "execute": "blockdev-snapshot-delete-internal-sync",
  "arguments": {
    "device": "disk0",
    "name": "snapshot-2024-01-01"
  }
}
```

### 5.3 Modelo de datos

```typescript
interface Snapshot {
  id: string
  vmId: string
  name: string
  description?: string
  createdAt: Date
  sizeBytes: number
  isCurrent: boolean
}
```

---

## 6. Instalación de SO (Unattended)

### 6.1 ISO Generation

**Por SO:**

| SO | Método | Archivos |
|----|--------|----------|
| Windows | Sysprep | autounattend.xml |
| Ubuntu | cloud-init | user-data, meta-data |
| Fedora/RHEL | Kickstart | ks.cfg |

### 6.2 Datos de instalación

```typescript
interface InstallConfig {
  username: string
  password: string
  productKey?: string  // Windows
  locale: string
  timezone: string
  hostname: string
  applications?: Application[]
  firstBootScripts?: Script[]
}
```

### 6.3 Flujo

1. Generar archivos de respuesta (autounattend.xml, etc.)
2. Crear ISO con archivos de respuesta
3. Montar ISO como CD-ROM secundario
4. Bootear desde ISO de instalación del SO
5. SO lee respuestas y se instala automáticamente
6. Al terminar, expulsar ISO y rebootear

---

## 7. Comunicación QMP

### 7.1 Socket Management

```typescript
interface QMPConnection {
  socketPath: string  // /var/run/infinivirt/vm-123.sock
  connect(): Promise<void>
  disconnect(): Promise<void>
  execute(command: string, args?: object): Promise<any>
  on(event: string, handler: Function): void
}
```

### 7.2 Comandos Esenciales

```typescript
// Handshake inicial
await qmp.execute('qmp_capabilities')

// Estado
const status = await qmp.execute('query-status')

// Power
await qmp.execute('system_powerdown')
await qmp.execute('system_reset')
await qmp.execute('cont')
await qmp.execute('stop')
await qmp.execute('quit')

// Info
await qmp.execute('query-cpus-fast')
await qmp.execute('query-block')
await qmp.execute('query-vnc')
await qmp.execute('query-spice')

// Dispositivos
await qmp.execute('eject', { device: 'ide1-cd0' })
await qmp.execute('device_add', { driver: 'virtio-blk-pci', drive: 'disk1' })
await qmp.execute('device_del', { id: 'device0' })
```

### 7.3 Eventos

```typescript
// Eventos importantes a escuchar
type QMPEvent =
  | 'SHUTDOWN'        // VM apagándose
  | 'POWERDOWN'       // ACPI powerdown
  | 'RESET'           // Reset
  | 'STOP'            // Pausada
  | 'RESUME'          // Resumed
  | 'SUSPEND'         // Suspendida
  | 'WAKEUP'          // Despertada
  | 'DEVICE_DELETED'  // Dispositivo removido
  | 'BLOCK_JOB_COMPLETED' // Job de disco completado
```

---

## 8. Sincronización de Estado

### 8.1 DB ↔ QEMU

**Problema:** El estado en PostgreSQL debe reflejar el estado real de QEMU.

**Solución:**
1. **Polling**: Consultar estado QMP periódicamente
2. **Eventos QMP**: Reaccionar a eventos en tiempo real
3. **Proceso crash**: Detectar muerte de proceso QEMU

```typescript
class VMStateSync {
  async syncState(vmId: string): Promise<void> {
    const qmpState = await this.qmp.execute('query-status')
    const dbState = await this.db.getVMStatus(vmId)

    if (this.mapQMPtoDBState(qmpState) !== dbState) {
      await this.db.updateVMStatus(vmId, this.mapQMPtoDBState(qmpState))
    }
  }

  private mapQMPtoDBState(qmpStatus: string): VMStatus {
    switch (qmpStatus) {
      case 'running': return 'running'
      case 'paused': return 'suspended'
      case 'shutdown': return 'off'
      default: return 'off'
    }
  }
}
```

### 8.2 Crash Detection

```typescript
// Verificar si proceso existe
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Si proceso muerto pero DB dice running → actualizar DB
async function detectCrashedVMs(): Promise<void> {
  const runningVMs = await db.getVMsByStatus('running')
  for (const vm of runningVMs) {
    if (!isProcessAlive(vm.pid)) {
      await db.updateVMStatus(vm.id, 'off')
      await cleanupVMResources(vm.id)  // TAP, firewall, etc.
    }
  }
}
```

---

## 9. Storage Management

### 9.1 Operaciones qemu-img

```typescript
interface StorageService {
  // Crear imagen
  createImage(path: string, sizeGB: number, format: 'qcow2' | 'raw'): Promise<void>

  // Info
  getImageInfo(path: string): Promise<ImageInfo>

  // Redimensionar
  resizeImage(path: string, newSizeGB: number): Promise<void>

  // Convertir
  convertImage(src: string, dst: string, format: string): Promise<void>

  // Snapshot
  createSnapshot(path: string, name: string): Promise<void>
  listSnapshots(path: string): Promise<Snapshot[]>
  revertSnapshot(path: string, name: string): Promise<void>
  deleteSnapshot(path: string, name: string): Promise<void>
}
```

### 9.2 Comandos

```bash
# Crear
qemu-img create -f qcow2 disk.qcow2 50G

# Info
qemu-img info disk.qcow2

# Redimensionar (offline)
qemu-img resize disk.qcow2 +20G

# Convertir
qemu-img convert -f raw -O qcow2 disk.raw disk.qcow2

# Snapshots
qemu-img snapshot -c snap1 disk.qcow2     # Crear
qemu-img snapshot -l disk.qcow2           # Listar
qemu-img snapshot -a snap1 disk.qcow2     # Revertir
qemu-img snapshot -d snap1 disk.qcow2     # Eliminar
```

---

## 10. Módulos de Infinivirt

### Arquitectura propuesta

```
infinivirt/
├── src/
│   ├── core/
│   │   ├── QemuProcess.ts      # Spawn y manage QEMU process
│   │   ├── QMPClient.ts        # Comunicación QMP via socket
│   │   └── VMLifecycle.ts      # Power operations
│   │
│   ├── storage/
│   │   ├── QemuImgService.ts   # Wrapper para qemu-img
│   │   └── SnapshotService.ts  # Gestión de snapshots
│   │
│   ├── network/
│   │   ├── TapManager.ts       # Crear/destruir TAP devices
│   │   ├── NftablesService.ts  # Firewall rules
│   │   └── BridgeManager.ts    # Gestión de bridges
│   │
│   ├── display/
│   │   ├── SpiceConfig.ts      # Configuración SPICE
│   │   └── VncConfig.ts        # Configuración VNC
│   │
│   ├── unattended/
│   │   ├── WindowsUnattend.ts  # Sysprep generator
│   │   ├── CloudInit.ts        # Ubuntu cloud-init
│   │   └── Kickstart.ts        # Fedora/RHEL kickstart
│   │
│   ├── db/
│   │   └── PrismaClient.ts     # Conexión a PostgreSQL
│   │
│   └── index.ts                # API pública
│
├── .internal/                   # Documentación interna
│   ├── 01-qemu-options-reference.md
│   ├── 02-network-filtering-alternatives.md
│   └── 03-required-functionality.md
│
└── package.json
```

---

## 11. Resumen de Prioridades

### P0 - Core (MVP)

1. **QemuProcess**: Spawn QEMU con opciones correctas
2. **QMPClient**: Comunicación via socket
3. **VMLifecycle**: Start, stop, status
4. **QemuImgService**: Crear discos
5. **TapManager**: Networking básico

### P1 - Essential Features

6. **NftablesService**: Firewall
7. **SpiceConfig/VncConfig**: Display remoto
8. **StateSync**: DB ↔ QEMU
9. **SnapshotService**: Snapshots

### P2 - Full Feature Parity

10. **GPU Passthrough**: vfio-pci
11. **Unattended Install**: Windows, Ubuntu, Fedora
12. **Hardware Update**: Cambiar CPU/RAM
13. **Hot-plug**: Discos adicionales

### P3 - Nice to Have

14. **Live Migration**: Mover VM entre hosts
15. **Balloon**: Memory overcommit
16. **USB Passthrough**: Dispositivos USB
