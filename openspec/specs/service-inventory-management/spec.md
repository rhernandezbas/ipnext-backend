# Spec — service-inventory-management (delta)

> Strict TDD. Every requirement maps to ≥1 red test before implementation.
> Out of scope: stock control (`stockQuantity`), replacement tracking (`status='replaced'`), cost reports.

---

## F1 — CRUD completo de equipos del contrato (+ Remove)

### F1-1 — RemoveInstalledItem (soft-delete)

The `RemoveInstalledItem` use-case MUST set the item's `status` to `'removed'` and MUST NOT physically delete the row.

**Scenario: happy path**
- Given a `ContractInstalledItem` with `status='active'` belonging to contract `C`
- When `RemoveInstalledItem({ contractId: C, itemId })` is called
- Then the item's `status` becomes `'removed'` and `updatedAt` is refreshed, the item is still readable via `listByContract`

### F1-2 — RemoveInstalledItem idempotencia

`RemoveInstalledItem` MUST be a no-op (return success without error) when the item already has `status='removed'`.

**Scenario: item already removed**
- Given a `ContractInstalledItem` with `status='removed'`
- When `RemoveInstalledItem` is called again for that item
- Then the use-case returns successfully without throwing and the item remains `status='removed'`

### F1-3 — RemoveInstalledItem item not found

`RemoveInstalledItem` MUST throw `InstalledItemNotFoundError` when the `itemId` does not exist or does not belong to `contractId`.

**Scenario: item from another contract**
- Given item `I` belongs to contract `C2`, not `C1`
- When `RemoveInstalledItem({ contractId: C1, itemId: I })` is called
- Then `InstalledItemNotFoundError` is thrown

### F1-4 — Port `remove` method

The `ContractInventoryRepository` port MUST expose a method `remove(contractId: string, itemId: string): Promise<void>` (logical delete). Both `PrismaContractInventoryRepository` and `InMemoryContractInventoryRepository` MUST implement it.

### F1-5 — DELETE route soft-delete

The route `DELETE /contracts/:contractId/inventory/:itemId` MUST:
- Require permission `inventory.write`
- Delegate to `RemoveInstalledItem`
- Return `204 No Content` on success

**Scenario: authorized delete**
- Given valid JWT with `inventory.write`, item exists and is active
- When `DELETE /contracts/C1/inventory/I1`
- Then response is `204` and subsequent `GET` list still contains the item with `status='removed'`

### F1-6 — DELETE route unauthorized

**Scenario: missing permission**
- Given valid JWT without `inventory.write`
- When `DELETE /contracts/C1/inventory/I1`
- Then response is `403 Forbidden`

### F1-7 — UpdateInstalledItem accepts `type` field

`UpdateInstalledItemInput` MUST accept an optional `type` field. When provided, it MUST be validated against existing `DeviceTypeCatalog` entries.

**Scenario: valid type update**
- Given `DeviceTypeCatalog` contains `'ROUTER'`
- When `UpdateInstalledItem({ itemId, type: 'ROUTER' })` is called
- Then the item's `type` is updated to `'ROUTER'`

### F1-8 — UpdateInstalledItem unknown type → 422

**Scenario: unknown device type**
- Given `'UNKNOWN_GADGET'` does not exist in `DeviceTypeCatalog`
- When `UpdateInstalledItem({ itemId, type: 'UNKNOWN_GADGET' })` is called
- Then `UnknownDeviceTypeError` is thrown and the route returns `422 Unprocessable Entity`

---

## F2 — Catálogo de materiales (ABM)

### F2-1 — Entidad MaterialCatalog

`MaterialCatalog` MUST have fields: `id` (UUID), `name` (string, unique, stored UPPERCASE), `label` (string optional), `unit` (string optional, e.g. `'m'`, `'unidad'`), `active` (boolean, default `true`), `sortOrder` (int, default `0`), `createdAt`, `updatedAt`.

### F2-2 — CreateMaterialCatalog normaliza nombre a mayúsculas

`CreateMaterialCatalog` MUST store `name` as `name.toUpperCase()` regardless of the input casing.

**Scenario: lowercase input**
- Given input `{ name: 'cable coaxial', unit: 'm' }`
- When `CreateMaterialCatalog` is called
- Then the stored entry has `name = 'CABLE COAXIAL'`

### F2-3 — CreateMaterialCatalog nombre duplicado → conflict

`CreateMaterialCatalog` MUST throw `MaterialCatalogDuplicateNameError` when a material with the same normalized name already exists (active or inactive).

**Scenario: duplicate name**
- Given `MaterialCatalog` contains `name='CABLE COAXIAL'`
- When `CreateMaterialCatalog({ name: 'cable coaxial' })` is called
- Then `MaterialCatalogDuplicateNameError` is thrown and the route returns `409 Conflict`

### F2-4 — UpdateMaterialCatalog rename collision

`UpdateMaterialCatalog` MUST throw `MaterialCatalogDuplicateNameError` when renaming would collide with an existing entry (excluding the item being updated).

**Scenario: rename to existing**
- Given entries `'CABLE COAXIAL'` (id=A) and `'FIBRA OPTICA'` (id=B)
- When `UpdateMaterialCatalog({ id: B, name: 'CABLE COAXIAL' })`
- Then `MaterialCatalogDuplicateNameError` is thrown

### F2-5 — DeleteMaterialCatalog material en uso → InUse error

`DeleteMaterialCatalog` MUST throw `MaterialInUseError` when the material is referenced by at least one `TaskMaterialConsumption` row.

**Scenario: material referenced**
- Given `MaterialCatalog` entry `M` and one `TaskMaterialConsumption` referencing `M`
- When `DeleteMaterialCatalog({ id: M })` is called
- Then `MaterialInUseError` is thrown and the route returns `409 Conflict`

### F2-6 — DeleteMaterialCatalog material no usado → success

**Scenario: unused material**
- Given `MaterialCatalog` entry `M` with no consumption rows
- When `DeleteMaterialCatalog({ id: M })` is called
- Then the entry is deleted and `ListMaterialCatalog` no longer returns it

### F2-7 — ListMaterialCatalog filtra activos

`ListMaterialCatalog` MUST return only entries with `active=true` by default. Passing `includeInactive=true` MUST return all entries.

**Scenario: inactive excluded**
- Given entries `'CABLE COAXIAL'` (active=true) and `'VIEJO'` (active=false)
- When `ListMaterialCatalog()` without flags
- Then only `'CABLE COAXIAL'` is returned

### F2-8 — Rutas GET `/api/inventory/material-types` requiere `inventory.read`

**Scenario: sin permiso**
- Given JWT without `inventory.read`
- When `GET /api/inventory/material-types`
- Then `403 Forbidden`

### F2-9 — Rutas POST/PUT/DELETE `/api/inventory/material-types` requieren `inventory.manage`

**Scenario: solo read, no manage**
- Given JWT with `inventory.read` but not `inventory.manage`
- When `POST /api/inventory/material-types`
- Then `403 Forbidden`

### F2-10 — Migración semilla idempotente

The Prisma migration that creates `MaterialCatalog` MUST seed at least 3 base materials using `upsert` (or equivalent idempotent SQL), so re-running the seed does not create duplicates.

**Scenario: double seed**
- Given the seed has been run once
- When the seed runs again
- Then `MaterialCatalog` count does not increase

---

## F3 — Consumo de materiales por tarea

### F3-1 — Entidad TaskMaterialConsumption

`TaskMaterialConsumption` MUST have fields: `id` (UUID), `taskId` (FK → `ScheduledTask`, cascade delete), `materialCatalogId` (FK → `MaterialCatalog`, restrict delete), `materialName` (string, snapshot), `quantity` (float, > 0), `unit` (string optional), `notes` (string optional), `recordedByUserId` (FK → `RbacUser`, set-null on delete), `createdAt`, `updatedAt`. Index on `taskId`.

### F3-2 — RecordMaterialConsumption happy path

`RecordMaterialConsumption` MUST create a `TaskMaterialConsumption` row with a snapshot of `materialName` from the catalog at the time of recording.

**Scenario: registro exitoso**
- Given task `T` exists, `MaterialCatalog` entry `M` with `name='CABLE COAXIAL'`
- When `RecordMaterialConsumption({ taskId: T, materialCatalogId: M.id, quantity: 10, unit: 'm', recordedBy: U })`
- Then a row is created with `materialName='CABLE COAXIAL'`, `quantity=10`, `unit='m'`

### F3-3 — RecordMaterialConsumption cantidad inválida → error

`RecordMaterialConsumption` MUST throw `InvalidQuantityError` when `quantity ≤ 0`.

**Scenario: quantity zero**
- Given valid task and material
- When `RecordMaterialConsumption({ quantity: 0 })`
- Then `InvalidQuantityError` is thrown and the route returns `422`

### F3-4 — RecordMaterialConsumption material inexistente → error

`RecordMaterialConsumption` MUST throw `MaterialCatalogNotFoundError` when `materialCatalogId` does not match any active catalog entry.

### F3-5 — ListTaskMaterialConsumptions scoped a task

`ListTaskMaterialConsumptions` MUST return only rows belonging to the given `taskId`.

**Scenario: scoping**
- Given consumptions for tasks `T1` and `T2`
- When `ListTaskMaterialConsumptions({ taskId: T1 })`
- Then only `T1`'s consumptions are returned

### F3-6 — DeleteMaterialConsumption happy path

`DeleteMaterialConsumption` MUST delete the row when `id` belongs to the given `taskId`.

**Scenario: delete own consumption**
- Given consumption `C` for task `T`
- When `DeleteMaterialConsumption({ taskId: T, id: C })`
- Then `C` is no longer in `ListTaskMaterialConsumptions({ taskId: T })`

### F3-7 — DeleteMaterialConsumption item de otra tarea → error

`DeleteMaterialConsumption` MUST throw `ConsumptionNotFoundError` when the consumption does not belong to the given `taskId`.

### F3-8 — Rutas task-scoped bajo `inventory.write`

`GET /scheduling/:taskId/inventory/materials`, `POST /scheduling/:taskId/inventory/materials`, `DELETE /scheduling/:taskId/inventory/materials/:id` MUST all require `inventory.write`.

**Scenario: sin permiso**
- Given JWT without `inventory.write`
- When `GET /scheduling/T1/inventory/materials`
- Then `403 Forbidden`

### F3-9 — ConfirmInventorySuggestion ramifica por `kind`

`ConfirmInventorySuggestion` MUST branch on `suggestion.kind`:
- `'DEVICE'` → creates/updates a `ContractInstalledItem` (existing behavior, unchanged)
- `'MATERIAL'` → creates a `TaskMaterialConsumption` (preserving `materialDesc` as `materialName`, `quantity`, `unit`); resolves the catalog entry by `materialDesc` using `upsert`

**Scenario: confirm MATERIAL suggestion**
- Given `TaskInventorySuggestion` with `kind='MATERIAL'`, `materialDesc='CABLE COAXIAL'`, `quantity=5`, `unit='m'`, linked to task `T` with `contractId`
- When `ConfirmInventorySuggestion({ suggestionId })`
- Then a `TaskMaterialConsumption` row exists for task `T` with `materialName='CABLE COAXIAL'`, `quantity=5`, `unit='m'` and `MaterialCatalog` contains `'CABLE COAXIAL'` (created if absent)

### F3-10 — ConfirmInventorySuggestion MATERIAL sin contrato → TaskHasNoContractError

**Scenario: task without contractId**
- Given `TaskInventorySuggestion` with `kind='MATERIAL'` linked to task `T` where `task.contractId` is null
- When `ConfirmInventorySuggestion({ suggestionId })`
- Then `TaskHasNoContractError` is thrown

### F3-11 — ConfirmInventorySuggestion DEVICE no regresa

The `'DEVICE'` branch of `ConfirmInventorySuggestion` MUST continue to behave exactly as before this change (no regression).

**Scenario: confirm DEVICE suggestion (regression)**
- Given `TaskInventorySuggestion` with `kind='DEVICE'`, `deviceType='ROUTER'`, `serialNumber='SN123'`, task `T` with `contractId='C1'`
- When `ConfirmInventorySuggestion({ suggestionId })`
- Then a `ContractInstalledItem` is created for contract `C1`, no `TaskMaterialConsumption` is created

---

## F4 — Inventario del contrato en el sidebar de la tarea (FE)

### F4-1 — Reemplazar ComingSoonPanel con datos reales

The `CustomerSidebar` component MUST NOT render the placeholder `ComingSoonPanel` with "Próximamente." text. It MUST instead render the real contract inventory for `contractId` derived from `task.contractId`.

**Scenario: task with contractId**
- Given a task with `contractId='C1'` and `C1` has 2 installed items
- When `CustomerSidebar` renders
- Then the 2 installed items are shown; the "Próximamente" panel is absent

### F4-2 — Inventario del sidebar es read-only cuando no hay `inventory.write`

When the user does NOT have `inventory.write`, the sidebar inventory MUST be read-only (no edit/remove actions).

**Scenario: read-only user**
- Given user with `inventory.read` but not `inventory.write`
- When the sidebar renders
- Then no "Editar" or "Quitar" buttons are visible in the inventory section

### F4-3 — Sidebar gateado por `inventory.read`

When the user does NOT have `inventory.read`, the inventory section MUST NOT be rendered (or shows an empty/permission-denied state). It MUST NOT make API calls for inventory data.

### F4-4 — Sidebar reutiliza el hook existente

The `CustomerSidebar` inventory section MUST reuse `useServiceInstalledItems` (or equivalent existing hook) — it MUST NOT implement a new fetch mechanism from scratch.

### F4-5 — Task sin contractId muestra estado vacío

When `task.contractId` is null/undefined, the sidebar inventory section MUST show an appropriate empty/not-applicable state rather than crashing or making API calls with undefined.

**Scenario: no contractId**
- Given a task with no `contractId`
- When `CustomerSidebar` renders
- Then the inventory section renders a "Sin contrato asociado" (or equivalent) message without errors

---

## F5 — Permiso `inventory.write` y migración de rutas

### F5-1 — Migración RBAC crea `inventory.write` idempotente

The RBAC Prisma migration MUST create the `inventory.write` permission (module=`'inventory'`, action=`'write'`) using an idempotent `upsert`. Re-running the migration MUST NOT create duplicates.

**Scenario: migración doble**
- Given the migration has already run
- When it runs again (or seed reruns)
- Then `Permission` count for `inventory.write` is exactly 1

### F5-2 — `inventory.write` otorgado a tecnico, administrador, super_admin

The same migration MUST assign `inventory.write` to the roles `tecnico`, `administrador`, and `super_admin` via idempotent `upsert` on `RolePermission`.

**Scenario: role assignment**
- Given migration has run
- When `ListPermissionsForRole('tecnico')` is called
- Then `inventory.write` is in the result

### F5-3 — Rutas de inventario del contrato migradas a `inventory.read/write`

The following routes MUST require `inventory.read` (GET) or `inventory.write` (POST/PATCH/DELETE) instead of `clients.read/clients.write`:

- `GET /contracts/:contractId/inventory` → `inventory.read`
- `POST /contracts/:contractId/inventory` → `inventory.write`
- `PATCH /contracts/:contractId/inventory/:itemId` → `inventory.write`
- `DELETE /contracts/:contractId/inventory/:itemId` → `inventory.write`

**Scenario: `clients.write` sin `inventory.write`**
- Given JWT with `clients.write` but NOT `inventory.write`
- When `POST /contracts/C1/inventory`
- Then `403 Forbidden`

**Scenario: `inventory.write` sin `clients.write`**
- Given JWT with `inventory.write` but NOT `clients.write`
- When `POST /contracts/C1/inventory`
- Then `201 Created` (or `200 OK`)

### F5-4 — Rutas task-scoped de materiales usan `inventory.write`

All routes under `/scheduling/:taskId/inventory/materials` MUST require `inventory.write` (confirmed in F3-8 — this requirement makes the cross-feature contract explicit).

### F5-5 — FE gatea acciones con `inventory.write`

All mutating FE actions (add, edit, remove equipment; record/delete material consumption) MUST be wrapped with `<Can permission="inventory.write">` (or equivalent hook). They MUST NOT render for users lacking `inventory.write`.

**Scenario: acción oculta sin permiso**
- Given a user with `inventory.read` but not `inventory.write`
- When `ServiceInventorySection` renders
- Then "Agregar", "Editar", "Quitar" buttons are absent

---

## Constraints globales (aplican a todos los features)

- **GC-1**: Ningún use-case en `application/` MUST NOT import from `infrastructure/` or Prisma directly. All external dependencies MUST be injected via ports.
- **GC-2**: Prisma entities MUST NOT be returned raw from use-cases or routes. All outputs MUST be mapped to DTOs.
- **GC-3**: All new adapters MUST follow naming convention `Prisma{Entity}Repository.ts` / `InMemory{Entity}Repository.ts`.
- **GC-4**: All new domain errors MUST live in `src/domain/errors/`.
- **GC-5**: All new routes MUST use path aliases (`@infrastructure/`, etc.) — no relative `../../../` imports across layers.
- **GC-6**: Migrations MUST be aditivas (no column drops, no table drops, no existing-column renames) to allow safe zero-downtime deploys.
- **GC-7**: BE MUST be deployed before FE. FE MUST degrade gracefully if new endpoints are absent (no crash, show loading/empty state).
