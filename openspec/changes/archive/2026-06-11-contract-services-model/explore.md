# Exploration: contract-services-model (Backlog #43)

## Goal

Agregar al modelo `Contract`: (1) **nombre identificable** (campo `name`), (2) **dirección del contrato** (ya existe `address`/`lat`/`lng` — confirmar si es suficiente), y (3) **servicios contratados** via nuevo catálogo editable `ServiceCatalog` + tabla pivot `ContractService`. El catálogo sigue el patrón exacto de `DeviceTypeCatalog`/`MaterialCatalog`. La dirección ya vive en `Contract.address` y es sincronizada por GR — pero falta exponerla en el DTO del cliente y hay que agregar `name`. La UI nueva de contratos es el cambio #42 (siguiente); este cambio es modelo + API.

---

## Current State

### Modelo Contract (schema.prisma:207-229)

```
Contract {
  id, clientId, grContratoId (unique), type, plan, ip, status,
  startDate, endDate,
  address, lat, lng,           // ya existe — address=domicilio de instalación desde GR
  technology,                  // free-text, gateado por ContractTechnology catalog
  createdAt
  → tasks[], installedItems[], stockLocations[]
}
```

**Falta**: campo `name` (identificador legible, ej: "Fibra Casa", "Antena Trabajo"). GR no lo provee — es editable localmente.

**`address` ya existe** y ya se sincroniza desde GR (`c.domicilio` en `parseContractsResponse`, línea 219 de GestionRealClient.ts). El mapper en `PrismaClientMirrorRepository.upsertContract` (líneas 95-103) lo asigna correctamente. La semántica "dirección de facturación en Cliente, dirección de instalación en Contrato" YA está modelada.

**Falta exponer**: `address`/`lat`/`lng` en el DTO que consume la tab de contratos del cliente. `toService` en PrismaCustomerRepository.ts (líneas 57-72) SÍ mapea `address`/`lat`/`lng`. La entidad `Contract` en `domain/entities/customer.ts` (líneas 28-39) SÍ incluye `address`/`lat`/`lng`. Pero el FE `types/customer.ts Contract` los tiene como opcionales (`address?`, `lat?`, `lng?`) — OK, ya están presentes.

**PERO**: `Contract` en `customer.ts` (FE) NO tiene `name`. Y el ContractsTab (FE) muestra `contract.type · contract.plan` como identidad — necesitará `name` cuando exista.

### Sync GR → Contract

- `GestionRealClient.fetchContractsByClient` llama `action: 'contrato', cli_id, incluye_bajas: 'S'` (línea 72).
- `parseContractsResponse` (línea 212-229): extrae `id→grContratoId`, `nombre→plan`, `estado→status`, `inicio→startDate`, `domicilio→address`, `lat`, `lng`, `conexiones→pppoeUsername`.
- **`c.nombre` en GR = nombre del plan** (ej: "FIBRA 100MB"), NO un nombre de contrato libre. GR no tiene campo "nombre del contrato" editable.
- `upsertContract` (PrismaClientMirrorRepository:78-114): **excluye deliberadamente `technology`** (comentario explícito línea 92) porque es campo de usuario. El mismo patrón debe aplicarse a `name` — si el usuario lo editó, el sync no debe pisarlo.

### Rutas actuales de contratos

| Ruta | Use case | Propósito |
|------|----------|-----------|
| `GET /api/clients/:id/contracts` (vía CustomerRepository) | `GetClientContracts` | Tab contratos del cliente |
| `GET /api/contracts` | `ListContracts` | Página global de contratos |
| `GET /api/contracts/stats` | `GetContractStats` | KPIs |
| `GET /api/contracts/:contractId/inventory` | `ListContractInstalledItems` | Equipos instalados |

**No hay CRUD de contrato** propio — los contratos se crean/actualizan exclusivamente via sync GR o via `CustomerRepository` (add/update/delete que usa el FE). `AddContractData` / `UpdateContractData` en `types/customer.ts` (FE) son los shapes de creación/edición manual.

### Catálogos editables — patrón exacto

Referencia: `DeviceTypeCatalog` / `MaterialCatalog`.

**Tabla**: `DeviceTypeCatalog` (schema:529-541):
- `id`, `name` UNIQUE (UPPERCASE canónico), `label` (UI display), `active`, `sortOrder`, `createdAt`, `updatedAt`
- SIN FK desde la entidad que lo usa — el campo en Contract/etc. guarda el `name` (free-text). Validación en runtime via `DeviceTypeCatalogService` (caché en memoria, invalida en ABM).

**Seed**: migración idempotente con `ON CONFLICT (name) DO NOTHING` (migration.sql:17-25).

**ABM routes**: `GET/POST /device-types`, `GET/PUT/DELETE /device-types/:id` con permisos `inventory.read` / `inventory.manage`.

**Para `ServiceCatalog`**: misma estructura. El campo `Contract.serviceId` (o `ContractService.serviceCatalogId`) referencia el catálogo. Diferencia respecto a `DeviceTypeCatalog`: un contrato puede tener **múltiples servicios** (internet + TV + cámaras), por lo que se necesita una tabla pivot `ContractService` (N:N entre Contract y ServiceCatalog).

### ContractInstalledItem (no romper)

`ContractInstalledItem` (schema:861-893) cuelga del `contractId` con `onDelete: Cascade`. Tiene `assetId` FK opcional a `InventoryAsset`. El EPIC #38 usa `StockLocation` también ligado al contrato. El cambio #43 NO toca esta tabla — solo agrega `name`, posiblemente `ContractService`, y confirma que `address` ya está correctamente mapeado.

### Política sync manual-wins (lección UISP)

El sync UISP (`SyncUispMirror.ts:115-167`) implementa: si ya hay valor local → el auto-sync NO lo sobreescribe (línea 157: `else if (existing.coordinates === null)`). El sync GR ya implementa la misma política para `technology` (comentario explícito en `upsertContract`). Para `name` y `services`: el sync NO debe tocarlos — son campos de usuario.

---

## GR Address Evidence

El response de `action: 'contrato'` incluye (documentado en SKILL.md + code evidence):
- `domicilio`: string directo (distinto de cliente que tiene objeto anidado)
- `lat`, `lng`: flotantes

`parseContractsResponse` (GestionRealClient.ts:212-229):
```ts
address: str(c.domicilio) || null,
lat: numOrNull(c.lat),
lng: numOrNull(c.lng),
```

`upsertContract` (PrismaClientMirrorRepository.ts:95-103) los persiste en `Contract.address/lat/lng`. El DTO del cliente (`toService`) los expone. La FE `Contract` type ya los tiene (`address?`, `lat?`, `lng?`). **La dirección del contrato YA está modelada y sincronizada** — solo necesita documentarse (y quizás agregar a `AddContractData`/`UpdateContractData` para creación manual).

---

## Affected Areas

**BE:**
- `prisma/schema.prisma` — agregar `name String?` a `Contract`; agregar modelo `ServiceCatalog`; agregar modelo `ContractService` (pivot)
- `prisma/migrations/` — nueva migración: columna `name`, tabla `ServiceCatalog` (con seed ON CONFLICT), tabla `ContractService`
- `src/domain/entities/gestionReal.ts` — `GrContract` no cambia (GR no tiene `name` editable)
- `src/domain/entities/customer.ts` — `Contract` domain entity: agregar `name: string | null`
- `src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts` — `upsertContract`: NO agregar `name` al data object (manual-wins)
- `src/infrastructure/adapters/prisma/PrismaCustomerRepository.ts` — `toService`: agregar `name` al mapeo
- `src/application/dto/contract.dto.ts` — `ContractSummaryDto`: agregar `name`
- `src/domain/ports/ContractRepository.ts` — `ContractListItem`: agregar `name`
- **NUEVO** `src/domain/entities/service-catalog.ts`
- **NUEVO** `src/domain/ports/ServiceCatalogRepository.ts`
- **NUEVO** `src/application/services/ServiceCatalogService.ts`
- **NUEVO** `src/infrastructure/adapters/prisma/PrismaServiceCatalogRepository.ts`
- **NUEVO** `src/infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository.ts`
- **NUEVO** `src/infrastructure/http/routes/serviceCatalog.routes.ts`
- **NUEVO** use cases: `ListServiceCatalog`, `GetServiceCatalog`, `CreateServiceCatalog`, `UpdateServiceCatalog`, `DeleteServiceCatalog`
- **NUEVO** `src/domain/entities/contract-service.ts` (pivot entity)
- **NUEVO** `src/domain/ports/ContractServiceRepository.ts`
- **NUEVO** `src/infrastructure/adapters/prisma/PrismaContractServiceRepository.ts`
- **NUEVO** use cases: `ListContractServices`, `AddContractService`, `RemoveContractService`
- **NUEVO** routes: `GET/POST/DELETE /contracts/:contractId/services`
- `src/infrastructure/http/app.ts` — wiring DI de nuevos routers
- **NUEVOS tests**: unit (in-memory), routes (supertest)

**FE (solo contexto, cambia en #42):**
- `src/types/customer.ts` — `Contract`: agregar `name?`, `services?`
- `src/pages/customers/tabs/ContractsTab.tsx` — mostrará `name` cuando exista (#42)

---

## Options — Modelo de Servicios

### Opción A: Tabla pivot `ContractService` + catálogo `ServiceCatalog` (recomendada)

**Modelo**:
```sql
ServiceCatalog { id, name UNIQUE, label, active, sortOrder, createdAt, updatedAt }
ContractService { id, contractId FK, serviceCatalogId FK, addedAt, notes? }
```

- Pros: flexible (N servicios por contrato), extensible (agregar precio/periodo por servicio), catálogo editable por operadores, patrón idéntico a DeviceTypeCatalog (fácil de implementar y testear), consulta limpia, UI de "servicios activos por contrato" trivial.
- Cons: una tabla extra + pivot; para mostrar en el listado global (`/api/contracts`) requiere JOIN o campo agregado.
- Esfuerzo: Medio — ~8 archivos nuevos (entidad, port, adapter, service, use cases, routes, tests).

### Opción B: Array JSON en `Contract.services`

**Modelo**: `Contract.services Json? DEFAULT '[]'`

- Pros: cero tablas extra, rápido de implementar.
- Cons: NO filtrable/indexable por servicio, sin integridad referencial, no editable por catálogo, patrón contrario al stack (todos los catálogos son tablas relacionales aquí), migraciones de datos más complejas si luego se normaliza.
- Esfuerzo: Bajo — pero deuda técnica alta.

### Opción C: Enum/free-text en `Contract.serviceType`

**Modelo**: campo `serviceType String?` en `Contract`.

- Pros: un solo servicio por contrato es simple.
- Cons: no soporta múltiples servicios (requirimiento explícito: "internet, TV, cámaras"), violación del mismo patrón que Contract.technology ya resolvió con catálogo.
- Esfuerzo: Muy bajo, pero no cumple el requirimiento.

---

## Sync / Override Policy

Regla: **manual gana, sync nunca borra**.

Para `name`:
- GR no provee nombre identificable de contrato → el campo `Contract.name` es SIEMPRE manual.
- `upsertContract` en PrismaClientMirrorRepository: **NO incluir `name` en el data object** (igual que `technology`).
- Si el usuario edita `name`, el sync no lo toca.

Para `ContractService`:
- GR no devuelve servicios contratados como entidad separada → los servicios son SIEMPRE creados manualmente.
- El sync GR no toca la tabla `ContractService`.

Para `address`:
- **YA sincroniza desde GR** (`c.domicilio`). Si el usuario edita la dirección manualmente, el PRÓXIMO sync la pisaría (a diferencia de `technology`/`name`).
- DECISIÓN PENDIENTE: ¿proteger `address` del mismo modo que `technology`? (agregar guard `if (!existing.address)` en `upsertContract`). Si la dirección de GR es la fuente de verdad, no hace falta. Si el usuario puede tener una dirección diferente a la de GR, sí.
- **Recomendación**: dejar el comportamiento actual (GR wins para address) y documentarlo — la dirección de instalación viene de GR y es la correcta. El usuario puede editarla manualmente si GR tiene datos incorrectos, pero el próximo sync la restaurará. Alinear con el usuario si esto es aceptable.

---

## Risks

1. **Contrato sin `name`**: la mayoría de los contratos existentes (sincronizados desde GR) no tendrán `name`. El campo debe ser `String?` (nullable). La UI del #42 mostrará `plan` como fallback cuando `name` es null.
2. **Rotura del API existente**: `GET /api/clients/:id/contracts` devuelve `Contract[]`. Agregar `name` y `services` a la respuesta es **additive** — no rompe clientes actuales (FE ya tiene campos opcionales).
3. **N+1 en `listContracts`**: si se incluyen los servicios en el response de contratos, hay que hacer JOIN/include en `PrismaCustomerRepository.listContracts` — no consulta separada por contrato.
4. **Permisos para `ServiceCatalog`**: ¿`inventory.manage` o `clients.manage`? Evidencia: `DeviceTypeCatalog` usa `inventory.manage` (deviceTypeCatalog.routes.ts:34-35). Pero servicios por contrato conceptualmente pertenece al dominio de clientes. Recomendación: usar `clients.manage` para el ABM del catálogo y `clients.write` para agregar/quitar servicios en un contrato — consistente con cómo se gestiona `ContractInstalledItem` (que usa `inventory.write`). A confirmar con el usuario.
5. **`address` policy**: si address se edita manualmente y el sync la pisa, el usuario pierde el dato. Confirmar antes de implementar.
6. **Orden de cambios**: este cambio (#43) es modelo + API. El cambio #42 (UI) depende de él. Verificar que el DTO nuevo no rompe ningún consumer FE actual antes de mergear.

---

## Recommendation

**Opción A** (pivot `ContractService` + catálogo `ServiceCatalog`) con las siguientes decisiones:

1. Agregar `Contract.name String?` — campo libre, manual, sync-protected.
2. Crear `ServiceCatalog` con patrón idéntico a `DeviceTypeCatalog` (seed con 4-5 servicios base: `INTERNET`, `TV`, `CAMARAS`, `VOZ`, `OTRO`).
3. Crear tabla pivot `ContractService` (N:N, un contrato tiene N servicios).
4. Incluir `services` (array de nombres) en el response de `listContracts` via JOIN eager — evitar N+1.
5. `address` sigue siendo sincronizada desde GR (GR wins) — documentar comportamiento, no cambiar policy.
6. Permisos: `clients.read` para leer servicios, `clients.write` para ABM en contrato, `clients.manage` para el catálogo de servicios.
7. Exponer nuevas rutas: `GET/POST/DELETE /api/contracts/:contractId/services` + `GET/POST/PUT/DELETE /api/settings/services` (catálogo).

---

## Open Questions

1. **`address` policy**: ¿GR wins para address del contrato, o el usuario puede tener su propia dirección que no sea pisada por el sync?
2. **Permisos `ServiceCatalog`**: ¿`inventory.manage` (como DeviceTypeCatalog) o `clients.manage`?
3. **Servicios en la respuesta de `listContracts` global** (`/api/contracts`): ¿incluir array de servicios en `ContractSummaryDto` también, o solo en la ruta por cliente?
4. **`Contract.name` en creación manual**: cuando el operador crea un contrato manualmente (sin GR), ¿el `name` es requerido o sigue siendo opcional?
5. **Seed del `ServiceCatalog`**: ¿confirmamos los valores base? Propuesta: `INTERNET`, `TV`, `CAMARAS`, `VOZ`, `OTRO`.

---

## Ready for Proposal

Yes. Las decisiones de arquitectura están claras, las open questions son de detalle (pueden resolverse en spec/design). El riesgo más importante es la policy de `address` — confirmar antes de codificar `upsertContract`.
