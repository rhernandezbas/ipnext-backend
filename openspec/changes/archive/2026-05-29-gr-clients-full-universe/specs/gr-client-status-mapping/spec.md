# Spec: GR Client Status Mapping & Full-Universe Sync

**Capability**: `gr-client-status-mapping` (MODIFIED)
**Change**: `gr-clients-full-universe`
**Summary**: El sync de clientes amplía su alcance al universo completo de estados (`1,2,3,4,6`) y el mapeo `estado.codigo → ClientStatus` gana un valor de primera clase `baja` (codigo 6), manteniendo `status` como string en el wire (contrato del frontend intacto).

---

## Added / Modified Requirements

### REQ-SCOPE-1: El sync trae el universo completo de estados — MODIFIED

El default de `GR_SYNC_ESTADOS` (`config.ts`) MUST cambiar de `1,2` a `1,2,3,4,6` para que el espejo refleje GR en TODOS los estados (Activo, Deudor, Inactivo, Incobrable, Baja). El mecanismo de sync por-estado ya existe; este cambio solo amplía el alcance.

#### Scenario: Default trae los cinco estados

**Given** que `GR_SYNC_ESTADOS` NO está seteado en el entorno
**When** se lee la config
**Then** `estados` MUST ser `['1','2','3','4','6']`
**And** el sync MUST recorrer cada uno de esos segmentos de estado

#### Scenario: El operador puede override por env

**Given** que `GR_SYNC_ESTADOS=1,2` está seteado en el entorno
**When** se lee la config
**Then** `estados` MUST ser `['1','2']` (el env gana sobre el default)

> Rationale: bajas (codigo 6) e inactivos (codigo 3) nunca se traían bajo `1,2`; sin ampliar el alcance ningún cliente recibiría `baja` jamás.

### REQ-BAJA-ENUM-1: El enum `ClientStatus` gana `baja` — MODIFIED

El enum `ClientStatus` (`prisma/schema.prisma`) MUST incluir el valor `baja`, sumándose a los existentes (`active`, `late`, `blocked`, `inactive`). La migración MUST ser forward-only (`ALTER TYPE ... ADD VALUE`), con el caveat de transacción de Postgres manejado en el archivo de migración (decisión de `design`). El string-union local `ClientStatus` en `PrismaClientMirrorRepository.ts` MUST incluir `'baja'`.

### REQ-BAJA-MAP-1: `mapStatus` mapea el universo de estados — MODIFIED

`mapStatus(code)` (`PrismaClientMirrorRepository.ts`) MUST mapear así:

| `estado.codigo` | `ClientStatus` | Etiqueta GR |
|-----------------|----------------|-------------|
| `1` | `active` | Activo |
| `2` | `late` | Deudor |
| `3` | `inactive` | Inactivo |
| `4` | `blocked` | Incobrable |
| `6` | `baja` | Baja |
| otro / null | `inactive` | (fallback) |

#### Scenario: Codigo 6 → baja (nuevo)

**Given** un cliente de GR con `estado.codigo = '6'` (Baja)
**When** el adapter ejecuta `mapStatus('6')`
**Then** MUST devolver `'baja'`
**And** NO MUST devolver `'inactive'` ni `'blocked'`

#### Scenario: Codigo 3 → inactive (preservado)

**Given** un cliente de GR con `estado.codigo = '3'` (Inactivo)
**When** el adapter ejecuta `mapStatus('3')`
**Then** MUST devolver `'inactive'`

#### Scenario: Codigo 4 → blocked = Incobrable (preservado)

**Given** un cliente de GR con `estado.codigo = '4'` (Incobrable)
**When** el adapter ejecuta `mapStatus('4')`
**Then** MUST devolver `'blocked'`
**And** `blocked` MUST seguir significando Incobrable, NUNCA Baja

#### Scenario: Codigo desconocido o null → inactive (fallback)

**Given** un cliente de GR con `estado.codigo = null` o un codigo no mapeado (p.ej. `'5'`)
**When** el adapter ejecuta `mapStatus`
**Then** MUST devolver `'inactive'` (fallback actual preservado)

### REQ-BAJA-RESTAMP-1: El próximo sync re-estampa codigo-6 a baja

#### Scenario: Cliente Baja previamente marcado inactive se restampea

**Given** un cliente con `grClienteId = G` y `status = 'inactive'` en el espejo (mapeo viejo de codigo 6)
**And** que GR sigue reportando `G` con `estado.codigo = '6'`
**And** que `GR_SYNC_ESTADOS` incluye `6`
**When** corre el siguiente `SyncGestionRealClients` (upsert)
**Then** el `status` local de `G` MUST pasar a `'baja'`
**And** el upsert MUST seguir siendo no-destructivo (sin borrar la fila)

### REQ-DTO-STRING-1: `status` se serializa como STRING; `baja` es valor válido — MODIFIED

Cualquier DTO de cliente MUST serializar `status` como **string**. Agregar `baja` es additive en el wire (un nuevo valor posible), NO un cambio de shape. La traducción codigo↔nombre MUST permanecer dentro del mapper/repositorio, NUNCA filtrarse a use-cases ni routes.

#### Scenario: status en el wire es string, no objeto/enum

**Given** un cliente con `status = 'baja'` en el espejo
**When** se serializa el DTO del cliente
**Then** `status` MUST ser el string `"baja"` (no un objeto, no un código numérico)
**And** el contrato del frontend (union de strings) MUST poder extenderse con `"baja"` sin romper

#### Scenario: Los valores previos siguen siendo strings válidos

**Given** clientes con `status` `active`, `late`, `blocked`, `inactive`
**When** se serializan sus DTOs
**Then** cada `status` MUST ser su string correspondiente (contrato preexistente intacto)

---

## Appendix: Estado → Status crosswalk

| codigo | Etiqueta GR | `ClientStatus` (wire string) | Cambio |
|--------|-------------|------------------------------|--------|
| 1 | Activo | `active` | sin cambio |
| 2 | Deudor | `late` | sin cambio |
| 3 | Inactivo | `inactive` | sin cambio |
| 4 | Incobrable | `blocked` | sin cambio |
| 6 | Baja | `baja` | **NUEVO** (antes → `inactive`) |
| null/otro | — | `inactive` | fallback sin cambio |
