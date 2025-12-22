# Alternativas de Filtrado de Red para Infinization

Este documento analiza las alternativas modernas a iptables para implementar filtrado de red en VMs, dado que iptables está deprecated.

## Resumen Ejecutivo

| Tecnología | Rendimiento | Complejidad | Recomendación |
|------------|-------------|-------------|---------------|
| **nftables** | 46 mpps | Media | **RECOMENDADO** |
| eBPF/XDP | 24 mpps/core | Alta | Overkill para nuestro caso |
| tc + eBPF | 10-15 mpps | Alta | Muy específico |
| iptables | 39 mpps | Media | Deprecated, evitar |

**Recomendación**: Usar **nftables** como backend de firewall para Infinization.

---

## 1. nftables (Recomendado)

### ¿Qué es?

nftables es el **reemplazo oficial de iptables** en el kernel Linux (desde 3.13, 2014). Es parte del proyecto Netfilter y resuelve las limitaciones arquitecturales de iptables.

### Ventajas sobre iptables

**Rendimiento:**
- 46 millones de paquetes/segundo vs 39 mpps de iptables
- Maneja hasta 4 millones de reglas eficientemente (iptables < 1M)
- 30% menos tiempo de procesamiento por paquete
- 25% menos uso de CPU

**Arquitectura:**
- **Un solo comando** (`nft`) reemplaza iptables, ip6tables, arptables, ebtables
- **Dual stack nativo**: IPv4 e IPv6 en la misma tabla
- **Sets y maps**: Estructuras de datos eficientes para lookups
- **Actualizaciones atómicas**: Cambios sin interrumpir tráfico

### Sintaxis Básica

```bash
# Crear tabla
nft add table inet filter

# Crear chain
nft add chain inet filter input { type filter hook input priority 0 \; policy drop \; }

# Agregar regla
nft add rule inet filter input tcp dport 22 accept

# Listar ruleset
nft list ruleset

# Exportar/importar
nft list ruleset > firewall.nft
nft -f firewall.nft
```

### Filtrado por Interfaz TAP (VMs)

```bash
# Tabla específica para VMs
nft add table bridge vms

# Chain para VM específica
nft add chain bridge vms vm_123_forward { type filter hook forward priority 0 \; }

# Regla: permitir HTTP saliente desde VM
nft add rule bridge vms vm_123_forward \
  iifname "vnet-vm123" \
  ether saddr 52:54:00:12:34:56 \
  tcp dport 80 \
  accept

# Regla: bloquear SSH entrante a VM
nft add rule bridge vms vm_123_forward \
  oifname "vnet-vm123" \
  tcp dport 22 \
  drop
```

### Integración con Bridges

nftables soporta la familia `bridge` para filtrar tráfico en bridges como virbr0:

```bash
# Tabla bridge
nft add table bridge vmfilter

# Chain en forward hook del bridge
nft add chain bridge vmfilter forward { type filter hook forward priority 0 \; }

# Filtrar por MAC + IP
nft add rule bridge vmfilter forward \
  ether saddr 52:54:00:12:34:56 \
  ip saddr 192.168.122.10 \
  accept
```

### Estado Actual (2025)

- **Default en**: Debian 10+, Ubuntu 20.04+, RHEL 9+, Fedora 18+
- **Kubernetes**: kube-proxy usa nftables desde v1.29
- **Firewalld**: Backend nftables disponible

### Gestión Programática desde Node.js

Usamos el mismo patrón que ya existe en el backend (`unattendedManagerBase.ts:206`):

```typescript
// backend/app/services/unattendedManagerBase.ts - patrón existente
protected executeCommand(commandParts: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(commandParts[0], commandParts.slice(1))
    let output = ''

    process.stdout.on('data', (data) => { output += data })
    process.stderr.on('data', (data) => { console.error(`stderr: ${data}`) })

    process.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`Command failed with exit code ${code}`))
    })

    process.on('error', (error) => reject(error))
  })
}

// Uso en el código existente:
await this.executeCommand(['7z', 'x', isoPath, '-o' + extractDir])
```

**Para Infinization, reutilizamos este patrón:**

```typescript
// Reutilizar executeCommand del backend o crear utility compartida
import { executeCommand } from '@infinibay/shared/utils'

async function addRule(vmId: string, port: number) {
  await executeCommand([
    'nft', 'add', 'rule', 'bridge', 'vms',
    `vm_${vmId}`,
    'tcp', 'dport', port.toString(),
    'accept'
  ])
}

// Listar reglas
async function listRules(): Promise<string> {
  return await executeCommand(['nft', 'list', 'ruleset'])
}

// Con JSON (via archivo temporal, como hace el backend con ISOs)
async function applyRuleset(nftJson: object): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `nft-${Date.now()}.json`)
  try {
    await fsPromises.writeFile(tmpFile, JSON.stringify(nftJson), { mode: 0o600 })
    await executeCommand(['nft', '-j', '-f', tmpFile])
  } finally {
    await fsPromises.unlink(tmpFile).catch(() => {})
  }
}
```

**Opción futura: Binding nativo NAPI-RS**
```typescript
// @infinibay/nftables-node (a crear con Rust + libnftables)
import { Nft } from '@infinibay/nftables-node'

const nft = new Nft()
await nft.addRule({
  family: 'bridge',
  table: 'vms',
  chain: 'forward',
  expr: [...]
})
```

### Principios de Seguridad (ya aplicados en el backend)

1. **Array de argumentos**: `spawn(cmd, args)` - nunca concatenar strings
2. **Sin shell**: No usar `exec()` ni `shell: true`
3. **Archivos temporales**: Para datos complejos (JSON, XML), escribir a archivo y pasar path

---

## 2. eBPF/XDP (No recomendado para Infinization)

### ¿Qué es?

eBPF es una **máquina virtual en el kernel** que permite ejecutar código sandboxed. XDP (eXpress Data Path) es un hook de eBPF que opera en el driver de red, antes de allocation de sk_buff.

### Rendimiento

- **24 millones de paquetes/segundo por core**
- Procesa paquetes antes del network stack (zero-copy path)

### Por qué NO para Infinization

1. **Overkill**: Target users (1-50 VMs) no necesitan este nivel de rendimiento
2. **Complejidad**: Requiere escribir código C, compilar a bytecode, debugging complejo
3. **Ecosistema Node.js inmaduro**: `node_bpf` tiene mantenimiento incierto
4. **Portabilidad**: Requiere kernel 4.18+ con CONFIG_BPF

### Cuándo sí considerar eBPF

- DDoS mitigation (Cloudflare Magic Firewall)
- Load balancing masivo (Facebook Katran)
- >1000 VMs con alto throughput

---

## 3. tc + eBPF (No recomendado)

### ¿Qué es?

tc (Traffic Control) es el subsistema de QoS de Linux. Desde kernel 4.1, soporta programas eBPF como filtros.

### Diferencias con XDP

| Característica | XDP | tc eBPF |
|---------------|-----|---------|
| Hook point | Driver NIC | Network stack |
| Rendimiento | 24 mpps | 10-15 mpps |
| Dirección | Solo ingress | Ingress **y egress** |

### Por qué NO para Infinization

- Misma complejidad que eBPF (código C)
- Beneficio principal (egress filtering) también disponible en nftables

---

## 4. Cómo Libvirt Implementa nwfilters

### Tecnologías internas

Libvirt nwfilter actualmente usa:
- **ebtables**: Filtrado Layer 2 (MAC, ARP)
- **iptables**: Filtrado IPv4
- **ip6tables**: Filtrado IPv6

### Estructura de chains

```
ebtables -t nat -L

Chain PREROUTING
    ibay-vnet0-pre     # Custom chain por interfaz

Chain ibay-vnet0-pre
    -p IPv4 -j ibay-vnet0-ipv4
    -p ARP -j ibay-vnet0-arp
```

### Mapeo de protocolos

- XML `<mac>`, `<arp>`, `<vlan>` → ebtables
- XML `<tcp>`, `<udp>` sobre IPv4 → iptables
- XML `<tcp>`, `<udp>` sobre IPv6 → ip6tables

### Estado de migración a nftables

- Libvirt virtual networks ya usan nftables (desde ~2019)
- **nwfilter subsystem AÚN usa iptables/ebtables**
- No hay timeline oficial para migración

---

## 5. Arquitectura Propuesta para Infinization

### Opción A: nftables puro (Recomendado)

```
┌─────────────────────────────────────────────────────────┐
│                   Infinization Backend                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │            FirewallService                        │   │
│  │  ┌───────────────┐    ┌──────────────────────┐  │   │
│  │  │ FirewallRule  │───▶│ NftablesTranslator   │  │   │
│  │  │ (DB Model)    │    │ (JSON/CLI generator) │  │   │
│  │  └───────────────┘    └──────────┬───────────┘  │   │
│  └─────────────────────────────────│───────────────┘   │
│                                     ▼                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │         NftablesExecutor                         │   │
│  │  - execSync('nft', [...args])                   │   │
│  │  - Validación de output                          │   │
│  │  - Rollback en errores                           │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│                    Linux Kernel                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │              nftables (netfilter)                │   │
│  │  table bridge vms {                              │   │
│  │    chain vm_123_forward { ... }                  │   │
│  │    chain vm_456_forward { ... }                  │   │
│  │  }                                               │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Modelo de datos (compatible con actual)

```typescript
interface FirewallRule {
  id: string
  vmId: string
  name: string
  action: 'ACCEPT' | 'DROP' | 'REJECT'
  direction: 'IN' | 'OUT' | 'INOUT'
  priority: number
  protocol: 'tcp' | 'udp' | 'icmp' | 'all'
  srcPortStart?: number
  srcPortEnd?: number
  dstPortStart?: number
  dstPortEnd?: number
  srcIpAddr?: string  // CIDR
  dstIpAddr?: string  // CIDR
}
```

### Traducción a nftables

```typescript
function translateToNft(rule: FirewallRule, vmInterface: string): string {
  const parts: string[] = []

  // Dirección
  if (rule.direction === 'IN') {
    parts.push(`oifname "${vmInterface}"`)
  } else if (rule.direction === 'OUT') {
    parts.push(`iifname "${vmInterface}"`)
  }

  // Protocolo
  if (rule.protocol !== 'all') {
    parts.push(`ip protocol ${rule.protocol}`)
  }

  // Puerto destino
  if (rule.dstPortStart) {
    const portRange = rule.dstPortEnd
      ? `${rule.dstPortStart}-${rule.dstPortEnd}`
      : rule.dstPortStart.toString()
    parts.push(`${rule.protocol} dport ${portRange}`)
  }

  // IP origen
  if (rule.srcIpAddr) {
    parts.push(`ip saddr ${rule.srcIpAddr}`)
  }

  // Acción
  parts.push(rule.action.toLowerCase())

  return parts.join(' ')
}

// Resultado:
// iifname "vnet-vm123" ip protocol tcp tcp dport 80 accept
```

### Lifecycle hooks

```typescript
class InfinizationVMManager {
  async startVM(vmId: string) {
    // 1. Crear TAP device
    const tapName = await this.createTapDevice(vmId)

    // 2. Aplicar reglas de firewall
    await this.firewallService.applyRules(vmId, tapName)

    // 3. Iniciar QEMU
    await this.qemuService.start(vmId, { netdev: tapName })
  }

  async stopVM(vmId: string) {
    // 1. Parar QEMU
    await this.qemuService.stop(vmId)

    // 2. Limpiar reglas de firewall
    await this.firewallService.removeRules(vmId)

    // 3. Eliminar TAP device
    await this.destroyTapDevice(vmId)
  }
}
```

---

## 6. Comparativa Final

### Para Infinization específicamente

| Criterio | nftables | eBPF/XDP |
|----------|----------|----------|
| Rendimiento necesario | ✅ Sobra | ✅ Overkill |
| Complejidad desarrollo | ✅ Baja | ❌ Alta |
| Mantenimiento | ✅ Bajo | ❌ Alto |
| Portabilidad | ✅ Cualquier distro moderna | ⚠️ Requiere kernel específico |
| Debugging | ✅ nft list ruleset | ❌ bpftrace, complejo |
| Ecosistema Node.js | ✅ exec/JSON | ❌ Inmaduro |
| Match con filosofía | ✅ Simplicidad | ❌ Complejidad |

### Decisión

**nftables** es la opción correcta para Infinization:
- Rendimiento más que suficiente para 1-50 VMs
- Sintaxis moderna y unificada
- Bien documentado y soportado
- Gestión programática simple (exec + JSON API)
- Alineado con principio de simplicidad de Infinibay

---

## 7. Implementación Sugerida

### Paso 1: Servicio de nftables

```typescript
// services/NftablesService.ts
export class NftablesService {
  private async exec(command: string): Promise<string> {
    const { stdout } = await execAsync(`nft ${command}`)
    return stdout
  }

  async initializeVMTable(): Promise<void> {
    await this.exec('add table bridge infinization')
  }

  async createVMChain(vmId: string): Promise<void> {
    const chainName = `vm_${vmId}`
    await this.exec(`add chain bridge infinization ${chainName}`)
  }

  async addRule(vmId: string, rule: FirewallRule, tapName: string): Promise<void> {
    const nftRule = this.translateRule(rule, tapName)
    await this.exec(`add rule bridge infinization vm_${vmId} ${nftRule}`)
  }

  async removeVMRules(vmId: string): Promise<void> {
    await this.exec(`delete chain bridge infinization vm_${vmId}`)
  }
}
```

### Paso 2: Integración con lifecycle de VM

```typescript
// Al iniciar VM
async onVMStart(vmId: string, tapName: string) {
  await this.nftables.createVMChain(vmId)
  const rules = await this.db.getFirewallRules(vmId)
  for (const rule of rules) {
    await this.nftables.addRule(vmId, rule, tapName)
  }
}

// Al parar VM
async onVMStop(vmId: string) {
  await this.nftables.removeVMRules(vmId)
}
```

### Paso 3: Sincronización con DB

Mantener el mismo modelo de `FirewallRule` que usa el backend actual, solo cambiar el translator de XML (libvirt) a nftables CLI.

---

## Referencias

- [nftables Wiki](https://wiki.nftables.org/)
- [Red Hat - nftables Benchmarks](https://developers.redhat.com/blog/2017/04/11/benchmarking-nftables)
- [eBPF.io](https://ebpf.io/)
- [Libvirt Firewall Documentation](https://libvirt.org/firewall.html)
