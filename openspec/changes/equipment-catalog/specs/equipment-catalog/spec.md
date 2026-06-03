<!-- generated from engram topic_key: sdd/equipment-catalog/spec -->
## Spec — equipment-catalog

### Capability
The system replaces the four hardcoded `DeviceType` enum duplications with a single data-driven
`DeviceTypeCatalog` table. Operators manage types from an **Inventory Settings** admin page.
Every pipeline consumer (OCR prompt, normalizer, confirm guards, manual-add guards) reads the
catalog at runtime. A new `reviewedByInventoryAt` + `reviewedByInventoryUserId` pair records
_who_ and _when_ marked a task as reviewed-by-inventory, providing complete traceability.

---

## F1 — Device-type catalog (data-driven)

### Entity: DeviceTypeCatalog

```
DeviceTypeCatalog {
  id:        string (uuid, PK)
  name:      string (unique, UPPER-CASE identifier, e.g. "ONU")
  label:     string | null   (human-readable display text)
  active:    boolean          (default true)
  sortOrder: number           (integer, default 0; lower → first)
  createdAt: DateTime
  updatedAt: DateTime
}
```

---

### F1-1 — Seed of base values

- THE SYSTEM MUST include a migration that seeds exactly the five base records:
  `ONU`, `ROUTER`, `ANTENA`, `REPETIDOR`, `OTROS` (in that sortOrder 0–4) when the table is empty.
- THE SYSTEM MUST NOT alter any existing `String` column in `ContractInstalledItem` or
  `InventorySuggestion` — migration is purely additive.

**Scenario — seed on fresh DB**
```
Given  a PostgreSQL database that has never had the DeviceTypeCatalog table
When   the migration runs
Then   the table contains exactly 5 rows with names [ONU, ROUTER, ANTENA, REPETIDOR, OTROS]
And    all 5 rows have active=true
```

**Scenario — migration is idempotent**
```
Given  the migration has already run and all 5 rows exist
When   the migration runs again (re-apply / rollback-then-apply)
Then   no duplicate rows are created
```

---

### F1-2 — ListDeviceTypes use-case

- `ListDeviceTypes.execute()` MUST return all catalog entries ordered by `sortOrder ASC`.
- THE SYSTEM MUST NOT filter by `active` here — the caller decides filtering.

**Scenario — happy path**
```
Given  the catalog has [ONU(0), ROUTER(1), ANTENA(2)] in that sortOrder
When   ListDeviceTypes.execute() is called
Then   the result is an array of 3 DeviceTypeCatalogDto ordered [ONU, ROUTER, ANTENA]
```

---

### F1-3 — GetDeviceType use-case

- `GetDeviceType.execute(id)` MUST return the entry if found.
- WHEN the id does not exist it MUST throw `DeviceTypeNotFoundError`.

**Scenario — not found**
```
Given  the catalog has no entry with id "x"
When   GetDeviceType.execute("x") is called
Then   a DeviceTypeNotFoundError is thrown
```

---

### F1-4 — CreateDeviceType use-case

- `CreateDeviceType.execute({ name, label, sortOrder })` MUST persist a new entry and return
  the created `DeviceTypeCatalogDto`.
- `name` MUST be stored UPPER-CASED and trimmed.
- WHEN another entry with the same `name` (case-insensitive) already exists the use-case
  MUST throw `DeviceTypeNameConflictError`.

**Scenario — happy path**
```
Given  the catalog has no entry named "SWITCH"
When   CreateDeviceType.execute({ name: "switch", label: "Switch", sortOrder: 5 }) is called
Then   a new entry with name="SWITCH" is persisted
And    the returned DTO has name="SWITCH", active=true
```

**Scenario — duplicate name**
```
Given  the catalog has an entry named "ONU"
When   CreateDeviceType.execute({ name: "onu", ... }) is called
Then   a DeviceTypeNameConflictError is thrown
And    no new row is inserted
```

---

### F1-5 — UpdateDeviceType use-case

- `UpdateDeviceType.execute(id, patch)` MUST apply only the supplied fields and return the
  updated `DeviceTypeCatalogDto`.
- WHEN `name` is updated it MUST be UPPER-CASED and trimmed and must not collide with another
  entry's name → `DeviceTypeNameConflictError`.
- WHEN the id does not exist it MUST throw `DeviceTypeNotFoundError`.
- Marking an entry `active=false` is allowed for any non-`OTROS` entry.
- THE SYSTEM MUST NOT allow renaming `OTROS` (name is frozen for fallback purposes).

**Scenario — rename collision**
```
Given  the catalog has entries [ONU, ROUTER]
When   UpdateDeviceType.execute(routerId, { name: "ONU" }) is called
Then   a DeviceTypeNameConflictError is thrown
```

**Scenario — deactivate a type**
```
Given  the catalog has an active entry "ANTENA"
When   UpdateDeviceType.execute(antenaId, { active: false }) is called
Then   the entry has active=false
```

---

### F1-6 — DeleteDeviceType use-case

- `DeleteDeviceType.execute(id)` MUST delete the entry and return `true`.
- WHEN the entry does not exist it MUST throw `DeviceTypeNotFoundError`.
- WHEN any `ContractInstalledItem` row references this type (`type` column equals the entry's
  `name`) it MUST throw `DeviceTypeInUseError` and MUST NOT delete.
- `OTROS` MUST NOT be deletable regardless of usage — throw `DeviceTypeProtectedError`
  (code `DEVICE_TYPE_PROTECTED`). The `OTROS` check runs BEFORE the in-use count.

**Scenario — in-use block**
```
Given  catalog entry "ANTENA" exists
And    one ContractInstalledItem has type="ANTENA"
When   DeleteDeviceType.execute(antenaId) is called
Then   a DeviceTypeInUseError is thrown
And    the catalog entry is not deleted
```

**Scenario — OTROS always blocked**
```
Given  the catalog has entry "OTROS" with zero ContractInstalledItems referencing it
When   DeleteDeviceType.execute(otrosId) is called
Then   a DeviceTypeProtectedError (code DEVICE_TYPE_PROTECTED) is thrown
```

**Scenario — happy path**
```
Given  catalog entry "SWITCH" exists and no ContractInstalledItem references it
When   DeleteDeviceType.execute(switchId) is called
Then   the entry is deleted and true is returned
```

---

### F1-7 — Domain port: DeviceTypeCatalogRepository

- The port MUST expose: `list()`, `getById(id)`, `getByName(name)`, `create(data)`,
  `update(id, patch)`, `delete(id)`, `countInUse(typeName): Promise<number>`,
  `listActiveNames(): Promise<string[]>` (active type names, UPPERCASE — the valid set the
  OCR/confirm/route validators read).
- THE SYSTEM MUST provide a `PrismaDeviceTypeCatalogRepository` and an
  `InMemoryDeviceTypeCatalogRepository` (for unit tests).

---

### F1-8 — HTTP routes: `/api/inventory/device-types`

- `GET    /api/inventory/device-types`         → 200 `DeviceTypeCatalogDto[]` — requires `inventory.read`.
- `GET    /api/inventory/device-types/:id`     → 200 `DeviceTypeCatalogDto` | 404 — requires `inventory.read`.
- `POST   /api/inventory/device-types`         → 201 `DeviceTypeCatalogDto` — requires `inventory.manage`.
- `PUT    /api/inventory/device-types/:id`     → 200 `DeviceTypeCatalogDto` — requires `inventory.manage`.
- `DELETE /api/inventory/device-types/:id`     → 204 — requires `inventory.manage`.
- All routes MUST require authentication; unauthenticated → 401.
- Requests without `inventory.manage` on write routes → 403.
- After a successful POST/PUT/DELETE the route MUST invalidate the `DeviceTypeCatalogService` cache.

**Scenario — create without permission**
```
Given  an authenticated user without the inventory.manage permission
When   POST /api/inventory/device-types is called with valid payload
Then   the response status is 403
```

**Scenario — create duplicate via HTTP**
```
Given  the catalog has entry "ONU"
When   POST /api/inventory/device-types { name: "ONU" } with inventory.manage
Then   the response status is 409 with body { code: "DEVICE_TYPE_NAME_CONFLICT" }
```

**Scenario — delete in-use via HTTP**
```
Given  "ROUTER" is referenced by a ContractInstalledItem
When   DELETE /api/inventory/device-types/:routerId with inventory.manage
Then   the response status is 409 with body { code: "DEVICE_TYPE_IN_USE" }
```

**Scenario — delete OTROS via HTTP**
```
Given  the catalog entry "OTROS"
When   DELETE /api/inventory/device-types/:otrosId with inventory.manage
Then   the response status is 409 with body { code: "DEVICE_TYPE_PROTECTED" }
```

---

### F1-9 — RBAC permission: `inventory.manage`

- The seed (`prisma/seed.ts`) MUST create the `inventory.manage` permission and grant it to the
  `administrador` role (mirroring `scheduling.manage`).
- The seed MUST be idempotent (upsert, not insert).

**Scenario — seed is idempotent**
```
Given  prisma/seed.ts has already run once
When   prisma/seed.ts runs a second time
Then   no duplicate permission or role-assignment rows are created
```

---

### F1-10 — Dynamic validation: ConfirmInventorySuggestion

- `ConfirmInventorySuggestion` MUST accept a `validTypes: Set<string>` injected at construction
  (replaces the inline `VALID_TYPES` constant).
- `toType(raw, validTypes)` MUST return the matching catalog name when `raw` is in `validTypes`,
  or `'OTROS'` when it is not — it MUST NOT throw.
- `VALID_TYPES` hardcoded constant MUST be removed from this use-case file.

**Scenario — unknown type falls back to OTROS**
```
Given  validTypes = { "ONU", "ROUTER", "ANTENA", "REPETIDOR", "OTROS" }
And    a suggestion with deviceType="MIKROTIK"
When   ConfirmInventorySuggestion.execute({ suggestionId, typeOverride: "MIKROTIK" })
Then   the created ContractInstalledItem has type="OTROS"
And    the suggestion is marked confirmed
```

**Scenario — valid type is preserved**
```
Given  validTypes = { "ONU", "ROUTER", "ANTENA", "REPETIDOR", "OTROS" }
When   ConfirmInventorySuggestion.execute({ typeOverride: "ONU" })
Then   the created ContractInstalledItem has type="ONU"
```

---

### F1-11 — Dynamic validation: contractInventory.routes type guards

- The `VALID_TYPES` constant in `contractInventory.routes.ts` MUST be removed.
- Both HTTP type guards (confirm endpoint + manual-add endpoint) MUST validate the client-supplied
  `type` against the cached catalog (`DeviceTypeCatalogService.isValid`, injected at route-factory
  construction). An unknown type → **422 `INVALID_ITEM_TYPE`** (preserves the existing strict API
  boundary; the FE dropdown only ever offers catalog types, so a 422 only happens on a stale/bad client).
- This is the HTTP boundary ONLY. The use-case `ConfirmInventorySuggestion` keeps its `OTROS`
  fallback (F1-10) for the AUTOMATED closure path (`IngestClosedServiceOrders` → server-side
  confirm), which never passes through this guard. The two behaviors are intentional and distinct:
  strict at the human-facing API, lenient (never block) on the machine path.
- After a catalog mutation, the cache MUST be invalidated so a freshly-added type validates as valid.

**Scenario — confirm with unknown type rejected at the API**
```
Given  the catalog cache contains [ONU, ROUTER, ANTENA, REPETIDOR, OTROS]
When   POST .../suggestions/:id/confirm { type: "SWITCH" }
Then   the response status is 422 with body { code: "INVALID_ITEM_TYPE" }
```

**Scenario — newly-added type validates after cache invalidation**
```
Given  an admin POSTs a new device type "SWITCH" (cache invalidated)
When   POST .../suggestions/:id/confirm { type: "SWITCH" }
Then   the response status is 201 and the item type is "SWITCH"
```

---

### F1-12 — normalizeQwenDeviceType: injectable valid set

- `normalizeQwenDeviceType(raw, validTypes)` MUST accept the valid set as a second parameter.
- WHEN `raw` is not in `validTypes` it MUST return `null` (NOT `'OTROS'`).
- It MUST remain a pure function (no side effects, no throws).
- The old zero-parameter signature MUST be removed; callers pass the live catalog set.

**Scenario — unknown raw → null**
```
Given  validTypes = new Set(["ONU", "ROUTER", "ANTENA", "REPETIDOR", "OTROS"])
When   normalizeQwenDeviceType("MIKROTIK", validTypes)
Then   the return value is null
```

**Scenario — known raw → normalized**
```
Given  validTypes as above
When   normalizeQwenDeviceType(" onu ", validTypes)
Then   the return value is "ONU"
```

**Scenario — null/empty input → null**
```
When   normalizeQwenDeviceType(null, validTypes)
Then   the return value is null
```

---

### F1-13 — OllamaDevicePhotoOcr: dynamic OCR prompt

- `OllamaDevicePhotoOcr` MUST accept a `getDeviceTypeNames: () => string[]` function injected
  at construction (replaces the hardcoded enum list in the PROMPT constant).
- The generated prompt MUST list the live catalog names (e.g. `"ONU|ROUTER|ANTENA|REPETIDOR|OTROS|SWITCH"`).
- `classifyDeviceType` behavior MUST remain unchanged (keyword→type mapping unchanged per
  proposal out-of-scope declaration); only its output is validated against the catalog
  (unknown → `'OTROS'`).

**Scenario — dynamic prompt reflects catalog**
```
Given  the catalog has active types [ONU, ROUTER, ANTENA, REPETIDOR, OTROS, SWITCH]
When   OllamaDevicePhotoOcr.extract(photoUrl) is called
Then   the Ollama API receives a prompt containing "ONU|ROUTER|ANTENA|REPETIDOR|OTROS|SWITCH"
```

---

### F1-14 — DeviceTypeCatalogDto

```
DeviceTypeCatalogDto {
  id:        string
  name:      string
  label:     string | null
  active:    boolean
  sortOrder: number
  createdAt: string  // ISO 8601
  updatedAt: string  // ISO 8601
}
```

- THE SYSTEM MUST NOT return raw Prisma rows — adapters MUST map to this DTO.

---

## F2 — Inventory config sub-page + dynamic dropdowns

### F2-1 — InventorySettingsPage route

- THE SYSTEM MUST expose a route `/admin/inventory/settings` in the FE router (`App.tsx`).
- The route MUST be guarded by `inventory.read` — unauthenticated or unauthorized users are
  redirected to login / shown Forbidden.
- The Sidebar MUST show a "Configuración" child link under the Inventario item, pointing to
  `/admin/inventory/settings`, visible only to users with `inventory.read`.

**Scenario — unauthorized user cannot access**
```
Given  a user without inventory.read
When   they navigate to /admin/inventory/settings
Then   they are redirected to /login or see a Forbidden page
```

---

### F2-2 — DeviceTypesBody: list tab

- The "Equipos" tab MUST display a table with columns: **Nombre**, **Label**, **Orden**,
  **Activo**, **Acciones**.
- THE SYSTEM MUST call `GET /api/device-types` to populate the list.
- Data MUST be ordered by `sortOrder ASC` (server returns pre-ordered).

**Scenario — empty catalog**
```
Given  the catalog has 0 entries
When   the Equipos tab renders
Then   the table shows an empty-state message (no rows)
```

**Scenario — populated catalog**
```
Given  the catalog has 5 entries
When   the Equipos tab renders
Then   the table shows 5 rows in sortOrder order
```

---

### F2-3 — DeviceTypesBody: create

- A "Nuevo tipo" button MUST be visible only to users with `inventory.manage`; hidden otherwise.
- The create modal MUST collect: `name` (required), `label` (optional), `sortOrder` (optional,
  default 0).
- On submit the FE MUST call `POST /api/device-types`.
- On 409 `DEVICE_TYPE_NAME_CONFLICT` the form MUST display an inline error "Ya existe un tipo con ese nombre".
- On success the list MUST refresh.

**Scenario — create success**
```
Given  the user has inventory.manage
When   they open the create modal, enter name="SWITCH", and submit
Then   POST /api/device-types is called
And    on 201 the modal closes and the list re-fetches
```

**Scenario — create conflict**
```
Given  the server responds 409 DEVICE_TYPE_NAME_CONFLICT
When   the user submits the create form
Then   the modal stays open and shows "Ya existe un tipo con ese nombre"
```

---

### F2-4 — DeviceTypesBody: edit

- An "Editar" action per row MUST be visible only to users with `inventory.manage`.
- The edit modal pre-fills current values and calls `PATCH /api/device-types/:id` on submit.
- On success the list MUST refresh.

**Scenario — edit label**
```
Given  entry ONU exists with label=null
When   the user edits it and sets label="Optical Network Unit" and saves
Then   PATCH /api/device-types/:onuId { label: "Optical Network Unit" } is called
And    the table row updates to show the new label
```

---

### F2-5 — DeviceTypesBody: delete with confirm

- A "Eliminar" action per row MUST be visible only to users with `inventory.manage`.
- WHEN the user clicks delete a confirmation dialog MUST appear.
- On confirmation the FE MUST call `DELETE /api/device-types/:id`.
- On 409 `DEVICE_TYPE_IN_USE` the dialog MUST show "Este tipo está en uso y no puede eliminarse".
- On 409 with `OTROS_IS_RESERVED` reason the dialog MUST show "El tipo OTROS no puede eliminarse".

**Scenario — delete in-use**
```
Given  the user confirms deletion of "ROUTER"
And    the server responds 409 DEVICE_TYPE_IN_USE
Then   the confirmation dialog shows "Este tipo está en uso y no puede eliminarse"
And    the entry remains in the list
```

---

### F2-6 — useDeviceTypes hook

- `useDeviceTypes()` MUST call `GET /api/device-types` and return
  `{ data: DeviceTypeDto[], isLoading, error }`.
- Mutations (`useCreateDeviceType`, `useUpdateDeviceType`, `useDeleteDeviceType`) MUST
  invalidate the `['deviceTypes']` query key on success.
- THE SYSTEM MUST type `InstalledItemType` as `string` (not the old union literal) in FE types.

**Scenario — query caching**
```
Given  the hook has already fetched the list
When   a second component mounts and calls useDeviceTypes()
Then   no additional HTTP request is made (TanStack Query cache hit)
```

---

### F2-7 — Dynamic dropdown in SuggestionCard and ServiceInventorySection

- Both components MUST replace the hardcoded `TYPES` array with `useDeviceTypes()`.
- The `<select>` MUST offer only `active=true` entries for **new** selections, ordered by `sortOrder`.
- WHEN an already-resolved item has a type that is currently `active=false`, that type MUST
  still render in the select (so the saved value is not lost).
- WHEN `useDeviceTypes()` returns an empty array (catalog not yet loaded or API error),
  the select SHOULD show a single disabled option "Cargando…".

**Scenario — inactive type still shown on resolved item**
```
Given  item I was confirmed with type="ANTENA"
And    "ANTENA" has since been marked active=false in the catalog
When   the SuggestionCard for item I renders
Then   the select shows "ANTENA" as the selected value (not replaced by blank)
```

**Scenario — active-only for new selection**
```
Given  the catalog has [ONU(active), ROUTER(active), ANTENA(inactive)]
When   the user opens a new unresolved SuggestionCard
Then   the dropdown offers only [ONU, ROUTER] (ANTENA is excluded)
```

---

## F3 — Reviewed-by-inventory traceability

### F3-1 — Schema migration: reviewedByInventory fields

- `ScheduledTask` MUST gain two new nullable columns:
  - `reviewedByInventoryAt  DateTime?`
  - `reviewedByInventoryUserId  String?`  (FK → `RbacUser`, `onDelete: SetNull`)
- Both columns MUST be nullable so existing rows require no default.
- THE SYSTEM MUST NOT rename or drop the existing `reviewedByInventory Boolean` column.

**Scenario — migration is additive**
```
Given  a ScheduledTask row exists with reviewedByInventory=true
When   the migration runs
Then   the row still exists with reviewedByInventory=true
And    reviewedByInventoryAt=null and reviewedByInventoryUserId=null (pre-fill)
```

---

### F3-2 — SetTaskInventoryReview use-case signature

- `SetTaskInventoryReview.execute(taskId, reviewed, actorId)` MUST accept `actorId: string | null`
  as a third parameter.
- WHEN `reviewed=true` the use-case MUST persist `reviewedByInventoryAt = now()` and
  `reviewedByInventoryUserId = actorId`.
- WHEN `reviewed=false` the use-case MUST set `reviewedByInventoryAt = null` and
  `reviewedByInventoryUserId = null`.
- WHEN the task does not exist it MUST throw `TaskNotFoundError`.
- THE SYSTEM MUST NOT accept `actorId` from the request body — the route MUST read it
  from `req.user.id`.

**Scenario — mark reviewed with actor**
```
Given  task T exists with reviewedByInventory=false
And    the authenticated user has id="user-1"
When   SetTaskInventoryReview.execute(T.id, true, "user-1") is called
Then   task T has reviewedByInventory=true
And    reviewedByInventoryAt is set to approximately now()
And    reviewedByInventoryUserId="user-1"
```

**Scenario — unmark clears actor**
```
Given  task T has reviewedByInventory=true, reviewedByInventoryAt=<date>, reviewedByInventoryUserId="user-1"
When   SetTaskInventoryReview.execute(T.id, false, "user-1") is called
Then   task T has reviewedByInventory=false
And    reviewedByInventoryAt=null
And    reviewedByInventoryUserId=null
```

**Scenario — actorId from req.user only**
```
Given  the route handler receives req.user.id = "user-42"
And    req.body contains { reviewed: true, actorId: "hacker-id" }
When   the route calls SetTaskInventoryReview.execute(taskId, true, req.user.id)
Then   reviewedByInventoryUserId="user-42" (body actorId is ignored)
```

---

### F3-3 — ScheduledTaskDto: reviewedBy fields

- The task DTO MUST expose:
  - `reviewedByInventory: boolean`
  - `reviewedByInventoryAt: string | null`   (ISO 8601 or null)
  - `reviewedByInventoryUserName: string | null`  (resolved from the FK join, or null)
- THE SYSTEM MUST NOT return `reviewedByInventoryUserId` in the DTO (internal FK only).

**Scenario — dto with reviewed actor**
```
Given  task T has reviewedByInventory=true, reviewedByInventoryUserId="user-1"
And    user "user-1" has name="María Gómez"
When   the task DTO is constructed
Then   dto.reviewedByInventoryUserName = "María Gómez"
And    dto.reviewedByInventoryAt is an ISO 8601 string
```

**Scenario — dto with deleted actor (SetNull)**
```
Given  task T has reviewedByInventory=true and reviewedByInventoryUserId=null (user was deleted)
When   the task DTO is constructed
Then   dto.reviewedByInventoryUserName = null
And    dto.reviewedByInventoryAt is still an ISO 8601 string
```

---

### F3-4 — FE badge: "✓ Revisado · {nombre} · {fecha}"

- WHEN `reviewedByInventory=true` the InventoryPanel MUST show a badge:
  `"✓ Revisado · {reviewedByInventoryUserName ?? 'Sistema'} · {reviewedByInventoryAt formatted as DD/MM/YYYY}"`.
- WHEN `reviewedByInventory=false` the panel MUST show only the toggle (no badge).
- WHEN `reviewedByInventory=true` but both timestamp and name are null (legacy row) the badge
  MUST show `"✓ Revisado"` without the `·` separators.
- The date format MUST be `DD/MM/YYYY` (not ISO 8601).

**Scenario — full badge**
```
Given  task has reviewedByInventory=true, reviewedByInventoryUserName="Carlos López",
       reviewedByInventoryAt="2026-06-03T14:30:00.000Z"
When   InventoryPanel renders
Then   the badge text is "✓ Revisado · Carlos López · 03/06/2026"
```

**Scenario — legacy row (no actor)**
```
Given  task has reviewedByInventory=true, reviewedByInventoryUserName=null, reviewedByInventoryAt=null
When   InventoryPanel renders
Then   the badge text is "✓ Revisado"
```

**Scenario — not reviewed (no badge)**
```
Given  task has reviewedByInventory=false
When   InventoryPanel renders
Then   no badge is shown; only the toggle is present
```

---

### F3-5 — scheduling.api.ts types update

- The FE `ScheduledTask` type MUST include:
  `reviewedByInventoryAt: string | null` and `reviewedByInventoryUserName: string | null`.
- The existing `reviewedByInventory: boolean` field MUST be retained.

---

### Out of scope (per Proposal)

- Item #1 — default de proyecto + descripción obligatoria en CreateTaskModal.
- Moving `classifyDeviceType` keyword mapping to the catalog table.
- Icons/colors per device type.
- Migrating lowercase enum usage in `InventoryItemsPage` / `Products` / `CpePage`.
