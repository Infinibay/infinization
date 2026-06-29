# Configuración de `@infinibay/infinization`

La forma soportada y descubrible de configurar la librería es el objeto tipado
`InfinizationConfig` que se pasa al constructor (`new Infinization({ ... })`) y,
para la instalación desatendida, `UnattendedInstallerOptions`.

Además, **algunos comportamientos se pueden ajustar por variables de entorno**.
Históricamente estas vivían sólo en el código y no eran visibles para quien leía
el config tipado (ver `CODE_REVIEW_REPORT.md` §C.4 INT-02). Este documento es el
catálogo único de esas variables. **Regla de precedencia general:** un campo
explícito del config tipado gana sobre la env var, y la env var gana sobre el
default interno.

---

## Variables de entorno

### `INFINIZATION_BRIDGE_CONNTRACK_MODE` — postura de conntrack del firewall

| | |
|---|---|
| **Valores** | `degrade` \| (cualquier otro / ausente ⇒ `fail`) |
| **Default** | `fail` |
| **Campo tipado equivalente** | `InfinizationConfig.bridgeConntrackMode` (gana sobre la env var) |
| **Leído en** | `src/core/Infinization.ts`, `src/network/NftablesService.ts` (estático, a class-load) |
| **Impacto de seguridad** | ⚠️ **Alto** |

- `fail` (**recomendado, fail-closed**): en un host sin `nf_conntrack_bridge` /
  `br_netfilter`, `initialize()` lanza un error accionable en vez de arrancar VMs
  con un firewall degradado. Las cadenas por-VM instalan la regla con estado
  `ct state established,related`.
- `degrade` (**fail-open**): si falta el conntrack de bridge, corre **stateless**
  (omite la regla `ct state`) para que las VMs igual arranquen. Esto **debilita el
  firewall** (sin tracking established/related). Usar sólo a sabiendas.

```ts
// Preferido: explícito y tipado en el config.
new Infinization({ prismaClient, bridgeConntrackMode: 'fail' })

// Equivalente por entorno (sólo si no se pasa el campo tipado):
//   INFINIZATION_BRIDGE_CONNTRACK_MODE=degrade
```

> Nota: la postura es **process-wide** (estática en `NftablesService`, ver el
> comentario MF-5 en esa clase): el soporte de conntrack es propiedad del kernel,
> no de una instancia. El último valor explícito pasado a un `NftablesService`
> gana para todas las instancias del proceso.

### `INFINIZATION_QEMU_USER` — usuario por defecto del `-runas` de QEMU

| | |
|---|---|
| **Valores** | nombre de usuario del host (p.ej. `qemu`, `libvirt-qemu`) |
| **Default** | (ausente ⇒ no se aplica `-runas`; QEMU corre como el usuario del proceso) |
| **Campo tipado equivalente** | `VMCreateConfig.runAsUser` por-VM (gana sobre la env var **en create**) |
| **Leído en** | `src/core/VMLifecycle.ts` — create (`config.runAsUser ?? env`) y start/restart (solo env) |
| **Impacto de seguridad** | ⚠️ **Alto** (privilege drop) |

Provee el **default host-wide** para el drop de privilegios `-runas` de QEMU.
Precedencia **en la creación**: el `runAsUser` explícito por-VM gana
(`config.runAsUser ?? env`); si ninguno está seteado, no se aplica `-runas`
(comportamiento histórico). Recomendado en producción para no correr QEMU como root.

> ⚠️ **Limitación conocida (start/restart):** el `runAsUser` por-VM **no se
> persiste** en la DB, así que en `start()` / restart / recuperación post-reboot el
> `-runas` se resuelve **sólo** desde `INFINIZATION_QEMU_USER` (ver el comentario
> MF-4 en `VMLifecycle.ts`). Una VM creada con `runAsUser` explícito pero sin la env
> var **se relanza como root** al reiniciar. Para un privilege-drop consistente,
> setear `INFINIZATION_QEMU_USER` a nivel host y no depender sólo del campo por-VM.

### `INFINIBAY_BACKEND_SERVICES_PATH` — ruta de servicios para instalación desatendida

| | |
|---|---|
| **Valores** | ruta absoluta al directorio de servicios del backend |
| **Default** | ruta relativa `../../../backend/app/services` desde el módulo |
| **Campo tipado equivalente** | `UnattendedInstallerOptions.backendServicesPath` (gana sobre la env var) |
| **Leído en** | `src/unattended/UnattendedInstaller.ts` |
| **Impacto de seguridad** | Bajo |

Precedencia: `options.backendServicesPath` → `INFINIBAY_BACKEND_SERVICES_PATH` →
default relativo.

---

## Resumen de precedencia

```
campo tipado (InfinizationConfig / *Options)  >  variable de entorno  >  default interno
```

Si agregás una nueva variable de entorno que afecte el comportamiento, **documentala
acá** y, si es razonable, dale un campo tipado equivalente en el config — para que
el contrato público siga siendo descubrible sin leer el código.
