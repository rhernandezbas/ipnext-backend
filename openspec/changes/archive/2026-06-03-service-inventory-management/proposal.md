<!-- generated from engram topic_key: sdd/service-inventory-management/proposal -->
## Proposal — service-inventory-management

> Implementa el ítem #8 del backlog, con el modelo de datos de 3 conceptos confirmado por el usuario. Multi-repo (BE + FE). Strict TDD. Migraciones aditivas. El control de **stock** (`stockQuantity` que sube/baja) queda FUERA — fase futura; este cambio deja el modelo listo para eso.

### Why
El inventario hoy tiene tres agujeros:
1. **No se puede QUITAR un equipo** del contrato como operación de primera clase. El `ContractInventoryRepository` solo tiene `listByContract/create/update`; el `status='removed'` es alcanzable por PATCH crudo pero sin use-case, sin DELETE, sin reglas de negocio. El FE no expone ni editar ni quitar.
2. **Los materiales son ciudadanos de segunda**: las sugerencias `TaskInventorySuggestion.kind='MATERIAL'` (que vienen del cierre de OS de IClass, con `materialDesc/quantity/unit`) **no se pueden confirmar a ningún lado** — `ConfirmInventorySuggestion` no ramifica por `kind` y crea un ítem device tipo `OTROS`, tirando los datos del material. Quedan huérfanas.
3. **El operador no ve el inventario actual del servicio** al trabajar una tarea — no puede validar contra lo que ya está instalado antes de agregar/confirmar (#8 puro).

Además, el inventario del contrato se protege con `clients.write` (namespace mezclado), no con un permiso de inventario propio.

### El modelo — 3 conceptos (NO un `kind` en una tabla)
El equipo es **ESTADO** durable del contrato; el material es **CONSUMO** por visita que sale de un stock. Mezclarlos complica el control de stock futuro. Por eso:
- **Equipos instalados** = `ContractInstalledItem` (ya existe). Estado del contrato.
- **Catálogo de materiales** = `MaterialCatalog` (NUEVO, espeja `DeviceTypeCatalog` + un campo `unit` default). La "base de inventario", futuro `stockQuantity`.
- **Consumo por visita** = `TaskMaterialConsumption` (NUEVO, espeja `TaskComment`). Ledger por tarea: material + cantidad. Futuro: decrementa stock.

### What changes

**F1 — CRUD completo de equipos del contrato (+ REMOVE)**
- Nuevo use-case `RemoveInstalledItem` (soft-delete → `status='removed'`, preserva historial; idempotente; no re-remueve un `removed`/`replaced`). Nuevo método `remove(id)` en el port (o `delete` lógico) + adapters Prisma/InMemory.
- Nueva ruta `DELETE /contracts/:contractId/inventory/:itemId` (soft-delete) bajo `inventory.write`.
- `UpdateInstalledItemInput` gana `type?` (hoy no se puede cambiar el tipo de un ítem existente) — validado contra el `DeviceTypeCatalog`.
- FE: `ServiceInventorySection` gana acciones **Editar** + **Quitar** por fila (hoy solo lista + agrega), gateadas por `inventory.write`.

**F2 — Catálogo de materiales (ABM)**
- Nueva tabla `MaterialCatalog` (mirror exacto de `DeviceTypeCatalog`: `id, name @unique, label?, active, sortOrder` + nuevo `unit String?` default tipo "m"/"unidad"). Stack hexagonal completo espejando el de device-types (entity, port, adapters Prisma/InMemory, 5 use-cases CRUD, DTO Zod, route factory, `MaterialCatalogService` cache, DI). Migración aditiva que siembra unos materiales base idempotente.
- Borrado protegido: no se puede eliminar un material en uso (cuenta `TaskMaterialConsumption.materialCatalogId`) → `MaterialInUseError`.
- Rutas `/api/inventory/material-types` (GET `inventory.read`, POST/PUT/DELETE `inventory.manage`).
- FE: nuevo tab **"Materiales"** en `InventorySettingsPage` = `MaterialsBody` (mirror `DeviceTypesBody`) + `materialTypes.api.ts` + `useMaterialTypes`.

**F3 — Consumo de materiales por tarea**
- Nueva tabla `TaskMaterialConsumption` (mirror `TaskComment`: `id, taskId FK→ScheduledTask Cascade, materialCatalogId FK→MaterialCatalog Restrict, materialName` (snapshot denormalizado), `quantity Float, unit String?, notes String?, recordedByUserId FK→RbacUser SetNull, createdAt, updatedAt`, `@@index([taskId])`).
- Port `TaskMaterialConsumptionRepository` (`listByTask/create/delete`) + adapters. Use-cases `RecordMaterialConsumption`, `ListTaskMaterialConsumptions`, `DeleteMaterialConsumption`.
- Rutas task-scoped bajo `inventory.write`: `GET/POST /scheduling/:taskId/inventory/materials`, `DELETE /scheduling/:taskId/inventory/materials/:id`.
- **Cierra el agujero**: `ConfirmInventorySuggestion` ramifica por `kind` — `DEVICE` → `ContractInstalledItem` (como hoy); `MATERIAL` → `TaskMaterialConsumption` (preserva materialDesc/qty/unit; resuelve/crea el material en el catálogo por nombre). Guard `TaskHasNoContractError` cuando aplica.
- FE: nueva sección de consumo en el tab de inventario de la tarea (listar + agregar consumo, dropdown de materiales del catálogo).

**F4 — #8: ver el inventario actual del servicio en la página de la tarea (modal derecho)**
- Reemplazar el placeholder `ComingSoonPanel` "Inventario del cliente — Equipos y materiales asignados. Próximamente." que vive en `CustomerSidebar.tsx:83-88` (el sidebar/modal derecho de la página de tarea) por el inventario REAL del contrato: los **equipos instalados** (`ContractInstalledItem` del contrato) + un resumen de **materiales consumidos** en la(s) tarea(s) del contrato.
- El `CustomerSidebar` ya recibe el `contractId` (de `task.contractId`). Reusa el listado de inventario del contrato (read-only en el sidebar; el CRUD completo vive en `ServiceInventorySection`/el tab de inventario). Gateado por `inventory.read`; acciones por `inventory.write`.
- Sigue el patrón ya hecho (el panel de inventario / `ServiceInventorySection` / `useServiceInstalledItems`), NO se reinventa el fetching.
- (El registro de **consumo de material por visita** vive en el tab de inventario de la tarea — F3; el sidebar "Inventario del cliente" es la VISTA del estado del contrato.)

**F5 — Permiso `inventory.write` + migración de rutas**
- Migración RBAC idempotente (mirror `20260604060000`) que crea `inventory.write` y lo otorga a `tecnico` + `administrador` + `super_admin` (`'write'` ya está en `KNOWN_ACTIONS`, el módulo `inventory` existe).
- Migrar los guards de las rutas del inventario del contrato de `clients.read/write` → `inventory.read/write`. Las rutas task-scoped de materiales/consumo usan `inventory.write`. (Las de sugerencias siguen en `scheduling.*` — son otro flujo.)
- FE: las acciones del inventario (agregar/editar/quitar/consumir) se gatean con `<Can permission="inventory.write">`.

### Out of scope (fase futura)
- **Control de stock**: `stockQuantity` en `MaterialCatalog`, decremento por consumo, restock. Este cambio deja el modelo listo (el consumo referencia el catálogo) pero NO implementa el contador.
- Reportes de costo de material por cliente/contrato (la cadena de agregación `consumption → task.contractId → contract.clientId` queda disponible).
- Reemplazo de equipo (`status='replaced'` con tracking del reemplazante) — el remove es soft; el replace es futuro.

### Riesgos & rollback
- **Migración de permisos (riesgo medio)**: mover de `clients.write` a `inventory.write` puede dejar sin acceso a quien tenga `clients.write` pero no `inventory.write`. Mitigación: la migración otorga `inventory.write` a tecnico+administrador+super_admin (los roles operativos); revisar el SQL antes de pushear. Cambio coordinado FE+BE.
- **Migraciones aditivas**: 3 tablas/columnas nuevas (`MaterialCatalog`, `TaskMaterialConsumption`, `UpdateInstalledItem.type` no es columna — es DTO) → seguras, viajan con el deploy.
- **`ConfirmInventorySuggestion` ramifica por kind**: tocar un use-case en el flujo de cierre (ya en prod) — strict TDD + la suite existente como red (mismo cuidado que en equipment-catalog Batch 3).
- Orden de deploy: BE antes que FE; el FE degrada si los endpoints nuevos faltan.
