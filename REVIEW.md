# Infinivirt Code Review

## Executive Summary

Infinivirt es un reemplazo directo de libvirt para gestionar VMs QEMU/KVM. La arquitectura es sólida y bien estructurada, pero hay varios puntos que necesitan atención antes de considerarlo production-ready como reemplazo completo de libvirt.

**Puntuación General: 7/10**

### Puntos Fuertes
- Arquitectura modular y bien organizada
- Uso correcto de QMP para comunicación con QEMU
- Buena validación de direcciones PCI
- Sistema de eventos y health monitoring
- Uso de virtio drivers por defecto (best practice)

### Áreas de Mejora Críticas
- Esquema de base de datos incompleto para configuración QEMU
- Condiciones de carrera en operaciones concurrentes
- Falta de features importantes (memory balloon, NUMA, CPU pinning)
- Valores hardcodeados que deberían ser configurables

---

## 1. Arquitectura General

### Estructura de Directorios
```
infinivirt/src/
├── core/           # Lógica principal (QemuCommandBuilder, VMLifecycle, QMPClient)
├── network/        # TAP devices, bridges, nftables
├── storage/        # qemu-img, snapshots
├── display/        # SPICE/VNC configuration
├── sync/           # Event handling, health monitoring, state sync
├── db/             # Prisma adapter
├── unattended/     # Instalación desatendida
└── types/          # TypeScript interfaces
```

**Valoración**: La separación de responsabilidades es clara y sigue el principio de single responsibility.

---

## 2. Base de Datos y Schema

### Campos Actuales en `MachineConfiguration`
| Campo | Tipo | Estado |
|-------|------|--------|
| `qmpSocketPath` | string | ✅ OK |
| `qemuPid` | number | ✅ OK |
| `tapDeviceName` | string | ✅ OK |
| `graphicProtocol` | string | ✅ OK |
| `graphicPort` | number | ✅ OK |
| `graphicPassword` | string | ⚠️ Plaintext (considerar encriptación simétrica AES-256-GCM para poder recuperar el valor original) |
| `graphicHost` | string | ✅ OK |
| `assignedGpuBus` | string | ✅ OK |

### Campos Faltantes para Control Completo de QEMU

**Prioridad Alta:**

| Campo | Tipo Sugerido | Propósito |
|-------|---------------|-----------|
| `bridge` | `string` | Network bridge (actualmente hardcodeado como `virbr0`) |
| `machineType` | `enum('q35','pc')` | Tipo de máquina QEMU |
| `cpuModel` | `string` | Modelo de CPU (host, qemu64, etc.) |
| `diskCacheMode` | `enum('none','writeback','writethrough')` | Modo de caché de disco |
| `diskBus` | `enum('virtio','scsi','ide','sata')` | Bus del disco |

**Prioridad Media:**

| Campo | Tipo Sugerido | Propósito |
|-------|---------------|-----------|
| `memoryBalloon` | `boolean` | Habilitar memory ballooning |
| `hugepages` | `boolean` | Usar hugepages para mejor rendimiento |
| `ioThreads` | `boolean` | I/O threading para discos |
| `networkModel` | `string` | Modelo de NIC (virtio-net-pci, e1000) |
| `networkQueues` | `number` | Multi-queue networking |

**Prioridad Baja (Features Avanzados):**

| Campo | Tipo Sugerido | Propósito |
|-------|---------------|-----------|
| `numaConfig` | `json` | Configuración NUMA |
| `cpuPinning` | `json` | CPU affinity configuration |
| `uefiFirmware` | `string` | Path a OVMF firmware |
| `secureboot` | `boolean` | UEFI Secure Boot |

### Recomendación de Esquema

```prisma
model MachineConfiguration {
  machineId        String   @id

  // Process info
  qemuPid          Int?
  qmpSocketPath    String?

  // Network
  tapDeviceName    String?
  bridge           String   @default("virbr0")
  networkModel     String   @default("virtio-net-pci")
  networkQueues    Int      @default(1)

  // Display
  graphicProtocol  String?
  graphicPort      Int?
  graphicPassword  String?  // TODO: Encrypt this
  graphicHost      String   @default("0.0.0.0")

  // Machine
  machineType      String   @default("q35")
  cpuModel         String   @default("host")

  // Storage
  diskBus          String   @default("virtio")
  diskCacheMode    String   @default("writeback")
  ioThreads        Boolean  @default(false)

  // GPU
  assignedGpuBus   String?
  gpuRomFile       String?
  gpuAudioBus      String?

  // Performance
  memoryBalloon    Boolean  @default(false)
  hugepages        Boolean  @default(false)

  // Advanced (JSON fields)
  numaConfig       Json?
  cpuPinning       Json?

  // UEFI
  uefiFirmware     String?
  secureboot       Boolean  @default(false)

  machine          Machine  @relation(...)
}
```

---

## 3. Problemas Identificados

### 3.1. Condición de Carrera en `start()` - CRÍTICO

**Ubicación**: `VMLifecycle.ts:418-431`

```typescript
if (vmConfig.status === 'running') {
  if (pid && this.isProcessAlive(pid)) { return }
  // Process dead, reset and continue
  await this.prisma.updateMachineStatus(vmId, 'off')
}
```

**Problema**: Entre el check y el update, otro proceso podría iniciar la VM, resultando en procesos QEMU duplicados.

**Solución**:
```typescript
// Usar transacción con lock optimista
await this.prisma.$transaction(async (tx) => {
  const vm = await tx.machine.findUnique({
    where: { id: vmId },
    select: { status: true, version: true }
  })

  if (vm.status === 'running') {
    // Check with pessimistic lock
    throw new Error('VM already running')
  }

  await tx.machine.update({
    where: { id: vmId, version: vm.version },
    data: { status: 'starting', version: { increment: 1 } }
  })
})
```

### 3.2. Bridge Hardcodeado - MEDIO

**Ubicación**: `VMLifecycle.ts:473`

```typescript
const bridge = 'virbr0' // TODO: Store bridge in machine config
```

**Impacto**: No permite usar bridges personalizados. Usuarios con múltiples redes no pueden seleccionar el bridge.

**Solución**: Agregar campo `bridge` a `MachineConfiguration` y leerlo en `start()`.

### 3.3. Firewall Rules No Separados - BAJO

**Ubicación**: `VMLifecycle.ts:1142`

```typescript
// TODO: Properly split once we have source information
return {
  department: rules,
  vm: []
}
```

**Impacto**: Todas las reglas se tratan como reglas de departamento. Las reglas específicas de VM no se distinguen.

### 3.4. Password en Texto Plano - SEGURIDAD (BAJA PRIORIDAD)

**Ubicación**: `VMLifecycle.ts:327`

```typescript
graphicPassword: config.displayPassword ?? null
```

**Impacto**: Passwords de VNC/SPICE almacenados sin encriptar en la DB.

**Nota**: El password necesita ser recuperable para mostrarlo al usuario en la UI.

**Solución** (si se decide implementar):
```typescript
// backend/app/utils/crypto.ts
import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const SECRET_KEY = process.env.ENCRYPTION_KEY // 32 bytes

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Format: iv:authTag:encrypted (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decrypt(encrypted: string): string {
  const [ivB64, authTagB64, dataB64] = encrypted.split(':')
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(data) + decipher.final('utf8')
}
```

**Alternativa**: Si la DB ya está en un servidor seguro y el acceso está controlado, el plaintext puede ser aceptable dado que:
1. Los passwords de VNC/SPICE son temporales y auto-generados
2. El acceso a la DB ya requiere autenticación
3. Añade complejidad sin beneficio significativo en entornos controlados

### 3.5. Validación de ROM File Path - SEGURIDAD

**Ubicación**: `QemuCommandBuilder.ts:289`

```typescript
deviceArg += `,romfile=${romfile}`
```

**Impacto**: No hay validación del path del ROM file. Un atacante podría cargar archivos arbitrarios.

**Solución**:
```typescript
addGpuPassthrough (pciBus: string, romfile?: string): this {
  if (romfile) {
    const allowedDir = '/var/lib/infinivirt/roms/'
    const normalizedPath = path.resolve(romfile)
    if (!normalizedPath.startsWith(allowedDir)) {
      throw new Error(`ROM file must be in ${allowedDir}`)
    }
  }
  // ...
}
```

### 3.6. Cleanup Sin Transacción - MEDIO

**Ubicación**: `HealthMonitor.ts:296-343`

**Problema**: El cleanup de recursos (TAP, firewall, socket, DB) se hace secuencialmente sin transacción. Si falla a mitad, quedan recursos huérfanos.

**Solución**: Implementar rollback o retry mechanism.

---

## 4. Features Faltantes vs Libvirt

| Feature | Estado | Prioridad | Notas |
|---------|--------|-----------|-------|
| **Virtio Drivers** | ✅ Implementado | - | Default para disco/red |
| **Memory Balloon** | ❌ Falta | Alta | Necesario para overcommit |
| **CPU Pinning** | ❌ Falta | Media | cgroups integration |
| **NUMA** | ❌ Falta | Media | Multi-socket optimization |
| **Live Migration** | ❌ Falta | Baja | Infraestructura compleja |
| **Snapshots** | ✅ Parcial | - | Solo qcow2 snapshots |
| **GPU Passthrough** | ✅ Implementado | - | VFIO-PCI |
| **USB Passthrough** | ❌ Falta | Media | `-device usb-host` |
| **VirtIO-SCSI** | ❌ Falta | Baja | Alternativa moderna |
| **UEFI/OVMF** | ❌ Falta | Media | Secure boot |
| **Serial Console** | ❌ Falta | Baja | Debug access |
| **Device Hotplug** | ❌ Falta | Media | Runtime changes |
| **Disk Encryption** | ❌ Falta | Baja | LUKS support |
| **Hugepages** | ❌ Falta | Media | Performance |
| **Multi-disk** | ❌ Falta | Media | Solo 1 disco soportado |

---

## 5. Comparación con Best Practices QEMU

### 5.1. Configuración de Disco

**Actual**:
```typescript
builder.addDisk({
  path: paths.diskPath,
  format: DEFAULT_DISK_FORMAT,  // qcow2
  bus: DEFAULT_DISK_BUS,        // virtio
  cache: DEFAULT_DISK_CACHE,    // writeback
  discard: true
})
```

**Best Practice según QEMU docs**:
- ✅ virtio es correcto para performance
- ✅ qcow2 es correcto para features
- ⚠️ `writeback` es más rápido pero menos seguro que `none`
- ✅ `discard` habilitado es correcto para TRIM

**Recomendación**: Para Windows guests, considerar `cache=none` con `io=native` para mejor performance. Documentación: [QEMU virtio-blk configuration](https://www.qemu.org/2021/01/19/virtio-blk-scsi-configuration/)

### 5.2. Configuración de Red

**Actual**:
```typescript
builder.addNetwork({
  tapName: tapDevice,
  mac: macAddress,
  model: DEFAULT_NETWORK_MODEL  // virtio-net-pci
})
```

**Best Practice**:
- ✅ virtio-net-pci es correcto
- ⚠️ Falta multi-queue networking para VMs con muchos cores
- ⚠️ Falta vhost-net para offloading

**Recomendación**: Agregar soporte para `vhost=on` y `queues=N` cuando `cpuCores > 1`.

### 5.3. Configuración de Display

**Actual**:
```typescript
if (config.displayType === 'spice') {
  builder.addSpice(spiceConfig)
} else {
  builder.addVnc(vncConfig)
}
```

**Best Practice**:
- ✅ SPICE es mejor para VMs de escritorio
- ✅ VNC es correcto para acceso básico
- ⚠️ Falta `-vga virtio` para mejor performance gráfica

### 5.4. QMP Protocol

**Actual**: Implementación completa y correcta del protocolo QMP.

**Referencia**: [QEMU QMP Specification](https://www.qemu.org/docs/master/interop/qmp-spec.html)

- ✅ Handshake correcto con `qmp_capabilities`
- ✅ Manejo de eventos asincrónicos
- ✅ Timeout handling
- ✅ Reconnection support

**Nota**: DigitalOcean usa [go-qemu](https://github.com/digitalocean/go-qemu) en producción, lo cual valida el approach de comunicación directa con QEMU.

---

## 6. TODOs y Métodos Deprecated

### TODOs Encontrados

1. **`VMLifecycle.ts:473`** - Bridge hardcodeado
   ```typescript
   const bridge = 'virbr0' // TODO: Store bridge in machine config
   ```

2. **`VMLifecycle.ts:1142`** - Firewall rules no separados
   ```typescript
   // TODO: Properly split once we have source information
   ```

### Métodos Deprecated

No se encontraron métodos marcados con `@deprecated`.

---

## 7. Recomendaciones de Implementación

### Prioridad 1: Fixes Críticos

1. **Implementar locking para operaciones de VM**
   - Usar advisory locks de PostgreSQL o campo `version` para optimistic locking
   - Prevenir condiciones de carrera en start/stop

2. **Agregar campo `bridge` a la configuración**
   - Migración de Prisma
   - Actualizar VMLifecycle para usar el valor de DB

3. **Validar ROM file paths**
   - Whitelist de directorios permitidos
   - Verificar que el archivo existe antes de pasar a QEMU

### Prioridad 2: Mejoras de Seguridad

4. **Implementar cleanup transaccional**
   - Envolver cleanup en try/catch con retry
   - Log recursos que no pudieron limpiarse

### Prioridad 3: Features Nuevos

6. **Memory Balloon Support**
   ```typescript
   // En QemuCommandBuilder
   addMemoryBalloon(): this {
     this.args.push('-device', 'virtio-balloon-pci')
     return this
   }
   ```

7. **Multi-disk Support**
   ```typescript
   // Cambiar addDisk para aceptar array
   addDisks(disks: DiskOptions[]): this {
     disks.forEach((disk, index) => {
       this.args.push('-drive',
         `file=${disk.path},format=${disk.format},if=${disk.bus},index=${index}`)
     })
     return this
   }
   ```

8. **UEFI/OVMF Support**
   ```typescript
   setFirmware(type: 'bios' | 'uefi', path?: string): this {
     if (type === 'uefi') {
       const ovmfPath = path ?? '/usr/share/OVMF/OVMF_CODE.fd'
       this.args.push('-drive', `if=pflash,format=raw,readonly=on,file=${ovmfPath}`)
     }
     return this
   }
   ```

### Prioridad 4: Optimizaciones

9. **Hugepages**
   ```typescript
   enableHugepages(prealloc: boolean = true): this {
     if (prealloc) {
       this.args.push('-mem-prealloc')
     }
     this.args.push('-mem-path', '/dev/hugepages')
     return this
   }
   ```

10. **CPU Pinning via cgroups**
    - Requiere integración con systemd o cgroups directamente
    - Después de spawn(), mover proceso a cgroup específico

---

## 8. Arquitectura de Drivers Sugerida

Para preparar el sistema para cambios de drivers en el futuro, sugiero esta estructura:

```typescript
// types/drivers.types.ts
interface VMDriverConfig {
  disk: {
    bus: 'virtio' | 'scsi' | 'ide' | 'sata'
    cache: 'none' | 'writeback' | 'writethrough'
    aio: 'native' | 'threads'
    ioThread: boolean
  }
  network: {
    model: 'virtio-net-pci' | 'e1000' | 'rtl8139'
    vhost: boolean
    queues: number
  }
  display: {
    vga: 'qxl' | 'virtio' | 'std' | 'cirrus'
    protocol: 'spice' | 'vnc'
  }
  audio?: {
    model: 'ich9-intel-hda' | 'AC97'
  }
}

// Defaults por OS
const DRIVER_PRESETS: Record<string, VMDriverConfig> = {
  'windows': {
    disk: { bus: 'virtio', cache: 'none', aio: 'native', ioThread: true },
    network: { model: 'virtio-net-pci', vhost: true, queues: 4 },
    display: { vga: 'qxl', protocol: 'spice' }
  },
  'linux': {
    disk: { bus: 'virtio', cache: 'writeback', aio: 'threads', ioThread: false },
    network: { model: 'virtio-net-pci', vhost: true, queues: 2 },
    display: { vga: 'virtio', protocol: 'spice' }
  },
  'legacy': {
    disk: { bus: 'ide', cache: 'writethrough', aio: 'threads', ioThread: false },
    network: { model: 'e1000', vhost: false, queues: 1 },
    display: { vga: 'std', protocol: 'vnc' }
  }
}
```

---

## 9. Testing Recomendado

### Unit Tests Necesarios

```typescript
describe('QemuCommandBuilder', () => {
  it('should validate PCI addresses')
  it('should reject invalid ROM paths')
  it('should build correct command for GPU passthrough')
})

describe('VMLifecycle', () => {
  it('should handle concurrent start requests')
  it('should cleanup all resources on failure')
  it('should emit correct events')
})

describe('HealthMonitor', () => {
  it('should detect crashed processes')
  it('should not create false positives')
  it('should handle cleanup failures gracefully')
})
```

### Integration Tests

1. Crear VM, verificar proceso QEMU existe
2. Start VM que ya está running
3. Stop VM con graceful timeout
4. Crash detection y cleanup
5. GPU passthrough con ROM file

---

## 10. Conclusión

Infinivirt es una base sólida para reemplazar libvirt en escenarios simples. La arquitectura es limpia y extensible. Sin embargo, para producción necesita:

1. **Fixes de seguridad** (ROM path validation, password encryption)
2. **Fixes de concurrencia** (locking en operaciones)
3. **Completar el schema** (bridge, drivers, etc.)
4. **Features críticos** (memory balloon, multi-disk)

El acceso directo a QMP es una ventaja sobre libvirt, ya que permite control más granular de QEMU. La implementación del protocolo QMP es correcta y sigue las especificaciones oficiales.

**Roadmap Sugerido:**
1. Sprint 1: Fixes de seguridad y concurrencia
2. Sprint 2: Schema completo y bridge configurable
3. Sprint 3: Memory balloon y multi-disk
4. Sprint 4: UEFI support y optimizaciones

---

## Referencias

- [QEMU Documentation](https://www.qemu.org/docs/master/)
- [QEMU QMP Specification](https://www.qemu.org/docs/master/interop/qmp-spec.html)
- [QEMU virtio-blk/scsi Configuration](https://www.qemu.org/2021/01/19/virtio-blk-scsi-configuration/)
- [DigitalOcean go-qemu](https://github.com/digitalocean/go-qemu)
- [Proxmox Windows Best Practices](https://pve.proxmox.com/wiki/Windows_2025_guest_best_practices)
- [libvirt vs QEMU comparison](https://stackshare.io/stackups/libvirt-vs-qemu)
