<!-- generated from engram topic_key: sdd/equipment-catalog/design -->
## Design — equipment-catalog

> Implements F1 (data-driven device-type catalog), F2 (inventory settings sub-page + dynamic dropdowns), F3 (review traceability). Mirrors the `TaskPriority` full-stack template exactly. Strict TDD, additive migrations only, hexagonal DIP preserved.

---

## 0. Design principles & template anchor

Everything in F1 is a **clone of the `TaskPriority` catalog** already in the repo. When in doubt, copy that file and rename. Reference anchors:

| Concern | TaskPriority reference | New DeviceTypeCatalog target |
|---|---|---|
| Prisma model | `prisma/schema.prisma:513` (`model TaskPriority`, `@@map("TaskPriority")`) | new `model DeviceTypeCatalog`, `@@map("DeviceTypeCatalog")` |
| Entity | `src/domain/entities/taskPriority.ts` | `src/domain/entities/device-type-catalog.ts` |
| Port | `src/domain/ports/TaskPriorityRepository.ts` | `src/domain/ports/DeviceTypeCatalogRepository.ts` |
| Prisma adapter | `src/infrastructure/adapters/prisma/PrismaTaskPriorityRepository.ts` | `PrismaDeviceTypeCatalogRepository.ts` |
| InMemory adapter | `src/infrastructure/adapters/in-memory/InMemoryTaskPriorityRepository.ts` | `InMemoryDeviceTypeCatalogRepository.ts` |
| Use-cases (5) | `src/application/use-cases/{List,Get,Create,Update,Delete}TaskPriority.ts` | `{List,Get,Create,Update,Delete}DeviceType.ts` |
| Errors | `src/domain/errors/scheduling.ts:128-147` (NotFound/NameConflict/InUse) | `src/domain/errors/inventory.ts` (new trio) |
| DTO (Zod) | `src/application/dto/scheduling.dto.ts:7-14` | `src/application/dto/inventory.dto.ts` |
| Route factory | `src/infrastructure/http/routes/taskPriorities.routes.ts` | `deviceTypeCatalog.routes.ts` |
| DI wiring | `src/infrastructure/http/app.ts:181-187, 678-683, 921-925` | mirror at same regions |
| FE hook | `src/hooks/useTaskPriorities.ts` | `src/hooks/useDeviceTypes.ts` |
| FE api | `src/api/taskPriorities.api.ts` | `src/api/deviceTypes.api.ts` |
| FE CRUD body | `src/pages/scheduling/settings/TaskPrioritiesBody.tsx` | `src/pages/inventory/settings/DeviceTypesBody.tsx` |
| FE Tabs page | `src/pages/scheduling/SchedulingSettingsPage.tsx` | `src/pages/inventory/InventorySettingsPage.tsx` |

---

## 1. Prisma schema

### 1.1 New model `DeviceTypeCatalog`

Add after `model TaskPriority` (`prisma/schema.prisma:522`). Same shape as `TaskPriority`, swapping `color`/`weight` for `label`/`active`/`sortOrder`:

```prisma
// Editable catalog of inventory device types (ONU, ROUTER, ANTENA, ...).
// ContractInstalledItem.type + TaskInventorySuggestion.deviceType store the NAME
// (free-text String). Validation (OCR normalize, confirm guard, route guard) reads
// the active names from this table instead of a hardcoded enum.
model DeviceTypeCatalog {
  id        String   @id @default(uuid())
  name      String   @unique          // canonical, UPPERCASE (ONU, ROUTER, ...)
  label     String?                   // optional human label for the UI
  active    Boolean  @default(true)
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("DeviceTypeCatalog")
}
```

Notes:
- `name @unique` mirrors `TaskPriority.name`. Canonical names are stored UPPERCASE (the OCR/confirm pipeline already uppercases — see `normalizeQwenDeviceType.ts:12`). Uniqueness check in use-cases is case-insensitive (mirror `getByName` lower-casing).
- No `@@index` beyond the implicit unique on `name` — the table is tiny (<20 rows), `list()` orders by `sortOrder`.
- `label` optional, future-proofing the UI; not load-bearing for validation.

### 1.2 `ScheduledTask` additions (F3)

Add inside `model ScheduledTask` next to the existing `reviewedByInventory` flag (`prisma/schema.prisma:866-867`):

```prisma
  // RV — inventory team review flag
  reviewedByInventory Boolean @default(false)
  // RV traceability (equipment-catalog F3): who/when marked the review.
  reviewedByInventoryAt     DateTime?
  reviewedByInventoryUserId String?
  reviewedByInventoryUser   RbacUser? @relation("TaskInventoryReviewer", fields: [reviewedByInventoryUserId], references: [id], onDelete: SetNull)
```

And the back-relation on `model RbacUser` (`prisma/schema.prisma:1577-1581`, next to `tasksReported`/`tasksAssigned`):

```prisma
  tasksInventoryReviewed ScheduledTask[] @relation("TaskInventoryReviewer")
```

**FK target decision — `RbacUser`, not `Admin`.** `req.user.id` is an RbacUser id: the existing inventory path (`ConfirmInventorySuggestion.execute` → `input.addedByUserId` → `RbacUserRepository.findById`, see `ConfirmInventorySuggestion.ts:11,72`) already resolves the actor against `RbacUser`. The existing task reporter/assignee FKs also point at `RbacUser` (`schema.prisma:843-845`). Same relation style: named relation `"TaskInventoryReviewer"`, `onDelete: SetNull` (a deleted user must not cascade-delete tasks; the badge degrades to "fecha sin usuario").

### 1.3 Migrations (two, additive)

1. **`add_device_type_catalog`** — `CREATE TABLE "DeviceTypeCatalog"` + unique index on `name`. Seed the 5 current values **inside the migration** (raw `INSERT ... ON CONFLICT DO NOTHING`) so existing `ContractInstalledItem.type` values keep validating from minute one:
   - `ONU` (sortOrder 0), `ROUTER` (1), `ANTENA` (2), `REPETIDOR` (3), `OTROS` (4). All `active=true`.
   - Rationale: the seed lives in the migration (not just `prisma/seed.ts`) because prod doesn't re-run `seed.ts`, and the dynamic validation would reject everything against an empty table. This is the proposal's "medium risk" mitigation.
2. **`add_task_inventory_review_traceability`** — `ALTER TABLE "ScheduledTask" ADD COLUMN reviewedByInventoryAt TIMESTAMP NULL, ADD COLUMN reviewedByInventoryUserId TEXT NULL` + FK constraint `ON DELETE SET NULL`. Both nullable → no backfill, no break.

Generate with `npm run prisma:migrate` (never hand-edit SQL except the additive seed `INSERT` in migration #1). User runs the command; we don't.

---

## 2. Domain layer

### 2.1 Entity `src/domain/entities/device-type-catalog.ts`

```ts
export interface DeviceTypeCatalog {
  id: string;
  name: string;       // canonical UPPERCASE
  label: string | null;
  active: boolean;
  sortOrder: number;
}
```

(Drop timestamps from the entity, mirroring `taskPriority.ts` which omits createdAt/updatedAt.)

### 2.2 Port `src/domain/ports/DeviceTypeCatalogRepository.ts`

Mirrors `TaskPriorityRepository` + adds the validation read used by the dynamic-validation consumers:

```ts
import { DeviceTypeCatalog } from '../entities/device-type-catalog';

export interface DeviceTypeCatalogRepository {
  list(): Promise<DeviceTypeCatalog[]>;
  getById(id: string): Promise<DeviceTypeCatalog | null>;
  getByName(name: string): Promise<DeviceTypeCatalog | null>;
  create(data: { name: string; label?: string | null; active?: boolean; sortOrder?: number }): Promise<DeviceTypeCatalog>;
  update(id: string, data: Partial<{ name: string; label: string | null; active: boolean; sortOrder: number }>): Promise<DeviceTypeCatalog | null>;
  delete(id: string): Promise<boolean>;
  /** How many ContractInstalledItem rows use this type NAME (delete guard). Mirrors TaskPriorityRepository.countTasksUsing. */
  countInUse(typeName: string): Promise<number>;
  /** Active type NAMES (UPPERCASE) — the valid set for OCR/confirm/route validation. */
  listActiveNames(): Promise<string[]>;
}
```

`listActiveNames()` is the single read the validation consumers depend on (returns `name` of rows where `active=true`). Keeping it on the port means callers never touch Prisma.

### 2.3 New errors `src/domain/errors/inventory.ts`

Append the trio, copying the `TaskPriority*` shape (`scheduling.ts:128-147`):

```ts
export class DeviceTypeNotFoundError extends DomainError {
  constructor(id: string) { super(`DeviceType with id ${id} not found`, 'DEVICE_TYPE_NOT_FOUND'); this.name = 'DeviceTypeNotFoundError'; }
}
export class DeviceTypeNameConflictError extends DomainError {
  constructor(name: string) { super(`A device type named "${name}" already exists`, 'DEVICE_TYPE_NAME_CONFLICT'); this.name = 'DeviceTypeNameConflictError'; }
}
export class DeviceTypeInUseError extends DomainError {
  constructor(public readonly itemCount: number) { super(`Device type is in use by ${itemCount} installed item(s)`, 'DEVICE_TYPE_IN_USE'); this.name = 'DeviceTypeInUseError'; }
}
export class DeviceTypeProtectedError extends DomainError {
  constructor() { super('The OTROS device type cannot be deleted', 'DEVICE_TYPE_PROTECTED'); this.name = 'DeviceTypeProtectedError'; }
}
```

`DeviceTypeProtectedError` guards the `OTROS` fallback (proposal F1: `OTROS` is non-deletable).

---

## 3. Application layer — use-cases + dynamic validation

### 3.1 The 5 CRUD use-cases (`src/application/use-cases/*DeviceType.ts`)

Direct clones of `*TaskPriority.ts`:

- **`ListDeviceType`** — `repo.list()`.
- **`GetDeviceType`** — `getById` → `DeviceTypeNotFoundError`.
- **`CreateDeviceType`** — `getByName` (case-insensitive) → `DeviceTypeNameConflictError`, else `create`. **Normalize `name` to UPPERCASE before persisting** (so OCR-uppercased values match).
- **`UpdateDeviceType`** — like `UpdateTaskPriority.ts`: `getById` → NotFound; if `name` changes, conflict check; `update`.
- **`DeleteDeviceType`** — like `DeleteTaskPriority.ts`: `getById` → NotFound; **if `name === 'OTROS'` → `DeviceTypeProtectedError`**; `countInUse(item.name)` > 0 → `DeviceTypeInUseError`; else `delete`.

Every use-case depends only on `DeviceTypeCatalogRepository`. No infra imports.

### 3.2 Dynamic validation threading — KEY DECISION

Three consumers validate a device-type string against the catalog today via a hardcoded array:
- `normalizeQwenDeviceType.ts:1-14` (uses `VALID_DEVICE_TYPES`)
- `ConfirmInventorySuggestion.ts:14-16` (local `VALID_TYPES` + `toType`)
- `contractInventory.routes.ts:10,54,84` (local `VALID_TYPES`)

**Decision: make the validators PURE + injectable, and feed them the valid set from the port. NO use-case imports infra.**

#### 3.2.1 `normalizeQwenDeviceType` → pure with injected set

New signature (proposal explicitly calls this out):

```ts
// src/application/services/normalizeQwenDeviceType.ts
export function normalizeQwenDeviceType(
  raw: string | null | undefined,
  validNames: Set<string>,   // UPPERCASE active names from the catalog
): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const u = raw.trim().toUpperCase();
  return validNames.has(u) ? u : null;          // unknown → null (NOT 'OTROS')
}
```

Return type relaxes from `DeviceType` to `string` (union dies — §5). Caller `ExtractDeviceInfoFromPhoto` (`ExtractDeviceInfoFromPhoto.ts:39`) must obtain the set. **`ExtractDeviceInfoFromPhoto` gains a `DeviceTypeCatalogRepository` constructor dep** (`ExtractDeviceInfoFromPhoto.ts:22-25`) and calls `await this.catalog.listActiveNames()` → `new Set(...)` → passes to `normalizeQwenDeviceType`. This keeps the use-case depending on a PORT, not infra.

#### 3.2.2 `ConfirmInventorySuggestion` → catalog-backed `toType`

`ConfirmInventorySuggestion` gains a `DeviceTypeCatalogRepository` dep (added to its constructor, `ConfirmInventorySuggestion.ts:31-37`). The local `VALID_TYPES`/`toType` (`:14-16`) are replaced by an in-method fetch:

```ts
const validNames = new Set(await this.catalog.listActiveNames());
const toType = (t: string | null): string =>
  t && validNames.has(t.toUpperCase()) ? t.toUpperCase() : 'OTROS';
const effectiveType = toType(input.typeOverride ?? suggestion.deviceType);
```

Unknown/empty → `'OTROS'` (the fallback that keeps the closure flow from breaking — proposal risk mitigation). The use-case still depends only on ports.

#### 3.2.3 Route guards — `DeviceTypeCatalogService` (cached), NOT per-request DB hit

The two route guards (`contractInventory.routes.ts:54,84`) currently do a synchronous `VALID_TYPES.includes(...)`. Options:

| Option | Pros | Cons |
|---|---|---|
| **A. async `repo.listActiveNames()` per request** | always fresh, trivial | extra DB round-trip on every confirm/add; the guard becomes async; couples a thin HTTP guard to the DB on the hot path |
| **B. small in-memory `DeviceTypeCatalogService` cache** | zero DB hit on the hot path; sync `isValid()`; matches proposal wording ("lista cacheada en memoria, refrescada en cada mutación") | needs invalidation wiring on catalog mutations |

**PICK B.** Introduce an application service:

```ts
// src/application/services/DeviceTypeCatalogService.ts
export class DeviceTypeCatalogService {
  private cache: Set<string> | null = null;
  constructor(private readonly repo: DeviceTypeCatalogRepository) {}
  async ensure(): Promise<Set<string>> {
    if (!this.cache) this.cache = new Set(await this.repo.listActiveNames());
    return this.cache;
  }
  invalidate(): void { this.cache = null; }                 // called after Create/Update/Delete
  async isValid(name: string | null | undefined): Promise<boolean> {
    if (!name) return false;
    return (await this.ensure()).has(name.toUpperCase());
  }
}
```

- Constructed **once** in `app.ts` (singleton) and passed both to the route guards (for `isValid`) and as the invalidation hook wired into the 3 mutating use-cases.
- **Invalidation wiring:** rather than coupling each use-case to the service, the route factory calls `service.invalidate()` after a successful Create/Update/Delete response (the catalog mutation routes live in `deviceTypeCatalog.routes.ts`, §6.1). This keeps the cache truth in the HTTP layer that already owns the singleton. Single-process app → no cross-instance staleness concern; if the app scales horizontally later, swap `ensure()` for a short TTL (documented in §11).
- The route validation in `contractInventory.routes.ts` becomes `if (!(await deviceTypes.isValid(rawType))) → 422 INVALID_ITEM_TYPE`. `contractInventory.routes.ts` gains a `deviceTypes: DeviceTypeCatalogService` param (wired in app.ts).

**Trade-off recorded:** B adds one stateful singleton + an invalidation call, in exchange for keeping the hot inventory-confirm path DB-free and the guards synchronous-ish (one cached `await`). For a catalog of <20 rows mutated rarely, the cache hit-rate is ~100%. A would be simpler but puts a DB read on every confirm — rejected.

---

## 4. OCR prompt — dynamic catalog names

`OllamaDevicePhotoOcr` hardcodes the type list twice in `PROMPT` (`OllamaDevicePhotoOcr.ts:5-10`). `classifyDeviceType` stays unchanged (proposal: only its OUTPUT is validated; keyword map is out of scope — `classifyDeviceType.ts` untouched).

**Decision: constructor-inject a names provider, build the prompt per call.** The adapter must not import the catalog repo directly (it's infra→infra, allowed, but we keep it port-shaped for testability). Add to `OllamaOcrConfig`:

```ts
export interface OllamaOcrConfig {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  /** Returns the active device-type names for the prompt. Defaults to the 5 base types. */
  deviceTypeNames?: () => Promise<string[]>;
}
```

- `PROMPT` becomes a function `buildPrompt(names: string[])` that interpolates `names.join('|')` into the `device_type` enum hint and the "use exactly one of: ..." line.
- In `ask()`/`extract()`, resolve `const names = (await this.cfg.deviceTypeNames?.()) ?? DEFAULT_DEVICE_TYPE_NAMES;` then `buildPrompt(names)`.
- Wired in `app.ts`: pass `deviceTypeNames: () => deviceTypeCatalogService.ensure().then(s => [...s])` (reuses the cache).

Why constructor/config injection over per-call arg: `DevicePhotoOcr.extract(photoUrl, deviceTypeHint?)` (`DevicePhotoOcr.ts:24`) signature is consumed by `ExtractDeviceInfoFromPhoto` (`ExtractDeviceInfoFromPhoto.ts:31`) — adding a names param there would leak catalog plumbing into the use-case. Keeping the provider in the adapter config leaves the port signature intact. Default fallback keeps the adapter usable without a catalog (degrades to the 5 base types) — matches the proposal's graceful-degrade stance.

---

## 5. `InstalledItemType` / `DeviceType` union → `string` (ripple)

The union types become `string` (catalog is the source of truth). Files affected:

**BE:**
- `src/domain/entities/device-type.ts` — `DeviceType` union + `VALID_DEVICE_TYPES` const **removed**. `classifyDeviceType.ts` returns `string` (its keyword map still emits the 5 literals, fine as strings). `classifyDeviceType.ts:1-2` re-export of `DeviceType` dropped.
- `src/domain/entities/contract-installed-item.ts:1` — `InstalledItemType` union → `type: string`. `ContractInstalledItem.type: string`.
- `ConfirmInventorySuggestion.ts:4,14-16` — drop `InstalledItemType` import + local `VALID_TYPES`/`toType` (replaced per §3.2.2).
- `contractInventory.routes.ts:8,10` — drop `InstalledItemType` import + `VALID_TYPES`; validate via service (§3.2.3).
- `normalizeQwenDeviceType.ts` — return `string | null` (§3.2.1).
- Any DTO/entity referencing these unions (e.g. `InstalledItemDto`) → `type: string`. (Grep `InstalledItemType` / `VALID_DEVICE_TYPES` before edit; current hits: the 4 files above + tests.)

**FE:**
- `src/types/serviceInventory.ts:1` — `InstalledItemType` → `export type InstalledItemType = string;` (keep the alias name so imports don't churn; just widen it). `ServiceInstalledItem.type`, `AddInstalledItemInput.type`, `TaskInventorySuggestion.deviceType` already `string`-compatible.
- `SuggestionCard.tsx:5-7` — drop hardcoded `TYPES` + `toValidType`; consume `useDeviceTypes()` (§8). `toValidType` becomes "if the value isn't in the active names → fall back to first/`OTROS`".
- `ServiceInventorySection.tsx:6,14,62-63` — same: dropdown from `useDeviceTypes()`, `EMPTY.type` defaults to first active name (or `'ROUTER'` fallback while loading).

Tests referencing `VALID_DEVICE_TYPES` (`normalizeQwenDeviceType.test.ts`, `classifyDeviceType.test.ts`) are rewritten to pass an explicit `Set` (§10).

---

## 6. HTTP routes

### 6.1 New `src/infrastructure/http/routes/deviceTypeCatalog.routes.ts`

Factory `createDeviceTypeCatalogRouter`, mirroring `taskPriorities.routes.ts` but with `requirePerm` guards (TaskPriority's router is auth-only; we add granular perms per proposal):

```ts
export function createDeviceTypeCatalogRouter(
  auth: RequestHandler,
  readPerm: RequestHandler,     // requirePerm('inventory','read')
  managePerm: RequestHandler,   // requirePerm('inventory','manage')
  list: ListDeviceType, get: GetDeviceType, create: CreateDeviceType,
  update: UpdateDeviceType, del: DeleteDeviceType,
  service: DeviceTypeCatalogService,   // to invalidate cache on mutation
): Router
```

Endpoints (mounted at `/api/inventory`):
- `GET    /api/inventory/device-types`        → `auth, readPerm`   → `list.execute()`
- `GET    /api/inventory/device-types/:id`    → `auth, readPerm`   → `get` (404 `DEVICE_TYPE_NOT_FOUND`)
- `POST   /api/inventory/device-types`        → `auth, managePerm` → Zod `CreateDeviceTypeSchema`, 201; 409 `DEVICE_TYPE_NAME_CONFLICT`; **then `service.invalidate()`**
- `PUT    /api/inventory/device-types/:id`    → `auth, managePerm` → Zod `UpdateDeviceTypeSchema`; 404/409; `service.invalidate()`
- `DELETE /api/inventory/device-types/:id`    → `auth, managePerm` → 204; 404; 409 `DEVICE_TYPE_IN_USE` or `DEVICE_TYPE_PROTECTED`; `service.invalidate()`

Error→status mapping mirrors `taskPriorities.routes.ts:31-96`. Zod schemas in new `src/application/dto/inventory.dto.ts`:

```ts
export const CreateDeviceTypeSchema = z.object({
  name: z.string().min(1),
  label: z.string().nullish(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export const UpdateDeviceTypeSchema = CreateDeviceTypeSchema.partial();
```

### 6.2 F3 route + DTO changes

**`SetTaskInventoryReview` signature gains `actorId`:**

```ts
// SetTaskInventoryReview.ts
async execute(taskId: string, reviewed: boolean, actorId: string | null): Promise<ScheduledTask> {
  const updated = await this.repo.setInventoryReview(taskId, reviewed, actorId);
  if (!updated) throw new TaskNotFoundError(taskId);
  return updated;
}
```

**`SchedulingRepository.setInventoryReview` signature** (`SchedulingRepository.ts:40`) gains `actorId`:
```ts
setInventoryReview(taskId: string, reviewed: boolean, actorId: string | null): Promise<ScheduledTask | null>;
```
- **Prisma adapter** (`PrismaSchedulingRepository.ts:519-530`): when `reviewed===true` set `reviewedByInventory: true, reviewedByInventoryAt: new Date(), reviewedByInventoryUserId: actorId`; when `false` set all three to `false/null/null`. Add `reviewedByInventoryUser: { select: { id:true, name:true } }` to the `INCLUDE` (`PrismaSchedulingRepository.ts:127`) and map `reviewedByInventoryAt` (ISO) + `reviewedByInventoryUserName: row.reviewedByInventoryUser?.name ?? null` in `toTask` (`:90`).
- **InMemory adapter** (`InMemorySchedulingRepository.ts:365-369`): mirror — set/clear the two new fields; default `reviewedByInventoryAt: null`, `reviewedByInventoryUserName: null` in the seed/create (`:70,311`).

**Entity `ScheduledTask`** (`scheduling.ts:58`) gains:
```ts
  reviewedByInventory: boolean;
  reviewedByInventoryAt: string | null;        // ISO
  reviewedByInventoryUserName: string | null;  // JOIN-derived
```
Add both to the `Omit<...>` in `CreateTaskInput` (`SchedulingRepository.ts:7`) so creates don't require them.

**Route** (`scheduling.routes.ts:238-255`): the `PATCH /:id/inventory-review` handler passes the actor:
```ts
const actorId = (req as { user?: { id?: string } }).user?.id ?? null;
const task = await setTaskInventoryReview.execute(req.params['id'], parsed.data.reviewed, actorId);
```
Task DTO already serializes the whole entity → `reviewedByInventoryAt` + `reviewedByInventoryUserName` flow out automatically.

---

## 7. Permission model — `inventory.manage`

The `inventory` RBAC module exists with `read` only; `manage` must be created and granted to `administrador`, mirroring the `scheduling.manage` seed block (`prisma/seed.ts:356-403`).

Add an analogous block (or extend the existing pattern) in `prisma/seed.ts`:

```ts
// equipment-catalog: ensure inventory.manage exists + grant to administrador
// (mirror of scheduling.manage). read already exists.
const inventoryModule = await (prisma as any).rbacModule.findUnique({ where: { code: 'inventory' } })
if (adminRole && inventoryModule) {
  for (const action of ['manage', 'read']) {
    let perm = await (prisma as any).rbacPermission.findFirst({ where: { moduleId: inventoryModule.id, action } })
    if (!perm) perm = await (prisma as any).rbacPermission.create({ data: { moduleId: inventoryModule.id, action } })
    await (prisma as any).rbacRolePermission.upsert({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id } },
      update: {}, create: { roleId: adminRole.id, permissionId: perm.id },
    })
  }
}
```

`requirePerm('inventory','manage')` (built via `app.ts:493`) guards the catalog mutations (§6.1). Read endpoints use the existing `requirePerm('inventory','read')`. `super_admin` already has all perms via migration.

> Note: a RBAC migration that seeds `inventory.manage` into super_admin (like the `scheduling.manage` migration) is the clean path for environments that don't run `seed.ts`. If the project's RBAC migrations follow that pattern, add a small additive migration granting `inventory.manage` to super_admin; otherwise the `ON CONFLICT`-safe seed block above suffices. Decide during tasks based on how `scheduling.manage` was originally introduced (check `prisma/migrations` for the scheduling perm seed).

---

## 8. Front-end structure

### 8.1 New files
- `src/types/deviceType.ts` — `export interface DeviceType { id, name, label, active, sortOrder }` (mirror `types/taskPriority.ts`).
- `src/api/deviceTypes.api.ts` — clone `taskPriorities.api.ts`, `BASE = '/inventory/device-types'`, `list/create/update/delete`.
- `src/hooks/useDeviceTypes.ts` — clone `useTaskPriorities.ts`: `useDeviceTypes()` (query key `['device-types']`, `staleTime: 60_000`), `useCreateDeviceType/useUpdateDeviceType/useDeleteDeviceType` mutations invalidating the key.
- `src/pages/inventory/settings/DeviceTypesBody.tsx` (+ reuse a `.module.css`) — clone `TaskPrioritiesBody.tsx`: toolbar "+ Nuevo tipo", table (Nombre / Etiqueta / Activo / Orden), create/edit modal, delete-with-confirm. Error mapping: 409 `DEVICE_TYPE_NAME_CONFLICT` → "Ya existe un tipo con ese nombre"; 409 `DEVICE_TYPE_IN_USE` → "No se puede eliminar: hay equipos que usan este tipo"; 409 `DEVICE_TYPE_PROTECTED` → "El tipo OTROS no se puede eliminar". Mutations gated by `<Can permission="inventory.manage">` (hide create/edit/delete buttons when absent; mirror existing `Can` usage).
- `src/pages/inventory/InventorySettingsPage.tsx` (+ `.module.css`) — clone `SchedulingSettingsPage.tsx` Tabs-lazy pattern. `TABS = [{ id:'equipos', label:'Equipos', content:<DeviceTypesBody/> }]`. Breadcrumb "Inventario /", title "Configuración". Hash-sync + lazy mount as in the template.

### 8.2 Consumers
- `SuggestionCard.tsx` — replace `TYPES`/`toValidType` (`:5-7`) with `const { data: deviceTypes = [] } = useDeviceTypes();` → options from `deviceTypes` (`active` only, by `sortOrder`). `toValidType` falls back to `'OTROS'` if the suggestion's `deviceType` isn't an active name. While loading, show the suggestion's own value.
- `ServiceInventorySection.tsx` — same hook; `<select>` (`:62-63`) maps `deviceTypes`; `EMPTY.type` defaults to first active name (fallback `'OTROS'`).
- Graceful degrade: if `useDeviceTypes()` errors/empty, dropdowns fall back to `['OTROS']` so the form still submits (proposal's degrade requirement).

### 8.3 F3 InventoryPanel badge
`TaskTabs.tsx` `InventoryPanel` (`:34-79`) + `TaskTabsProps`/`InventoryPanelProps` gain `reviewedByInventoryAt?: string | null` and `reviewedByInventoryUserName?: string | null` (threaded from the task DTO via the detail page, same way `reviewedByInventory` is passed `:15-16,86-87,138-142`). Render logic:
```tsx
{reviewedByInventory ? (
  <span className={styles.reviewedBadge}>
    ✓ Revisado{reviewedByInventoryUserName ? ` · ${reviewedByInventoryUserName}` : ''}{reviewedByInventoryAt ? ` · ${formatDate(reviewedByInventoryAt)}` : ''}
  </span>
) : (
  <label> {/* existing checkbox */} </label>
)}
```
Unchecking (when allowed) still uses the checkbox; the badge replaces the bare checked checkbox per proposal. `scheduling.api.ts` task type + the detail page mapping gain the two new fields.

### 8.4 Routing + nav
- `App.tsx` — add lazy `InventorySettingsPage` (next to `:115`) and a route under the existing `inventory` group (`:258-264`): `<Route path="settings" element={<RequirePermission permission="inventory.read"><InventorySettingsPage /></RequirePermission>} />` → `/admin/inventory/settings`. (Read-gates the page; the manage perm gates the mutation buttons inside.)
- `Sidebar.tsx` — add to the Inventario `children` (`:146-151`): `{ to: '/admin/inventory/settings', label: 'Configuración' }` (mirrors the scheduling "Configuración" child `:139`).

---

## 9. DI wiring in `app.ts`

Mirror the three TaskPriority regions:

**Imports (~`:181-187`):**
```ts
import { PrismaDeviceTypeCatalogRepository } from '../adapters/prisma/PrismaDeviceTypeCatalogRepository';
import { createDeviceTypeCatalogRouter } from './routes/deviceTypeCatalog.routes';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';
import { ListDeviceType } from '@application/use-cases/ListDeviceType';
import { GetDeviceType } from '@application/use-cases/GetDeviceType';
import { CreateDeviceType } from '@application/use-cases/CreateDeviceType';
import { UpdateDeviceType } from '@application/use-cases/UpdateDeviceType';
import { DeleteDeviceType } from '@application/use-cases/DeleteDeviceType';
```

**Instantiation (~`:678-683`):**
```ts
const deviceTypeCatalogRepo = new PrismaDeviceTypeCatalogRepository();
const deviceTypeCatalogService = new DeviceTypeCatalogService(deviceTypeCatalogRepo);
const listDeviceType = new ListDeviceType(deviceTypeCatalogRepo);
const getDeviceType = new GetDeviceType(deviceTypeCatalogRepo);
const createDeviceType = new CreateDeviceType(deviceTypeCatalogRepo);
const updateDeviceType = new UpdateDeviceType(deviceTypeCatalogRepo);
const deleteDeviceType = new DeleteDeviceType(deviceTypeCatalogRepo);
```

**Cross-wiring (the new dep into existing graphs):**
- `ConfirmInventorySuggestion` instantiation: add `deviceTypeCatalogRepo` arg (find where it's `new`-ed in app.ts).
- `ExtractDeviceInfoFromPhoto` instantiation: add `deviceTypeCatalogRepo` arg.
- `OllamaDevicePhotoOcr` config: add `deviceTypeNames: () => deviceTypeCatalogService.ensure().then(s => [...s])`.
- `createContractInventoryRouter(...)` (`app.ts:~988`): pass `deviceTypeCatalogService`.

**Router mount (~`:921-925`, before any `/:id` catch-all):**
```ts
app.use('/api/inventory', createDeviceTypeCatalogRouter(
  authAdapter,
  requirePerm('inventory','read'),
  requirePerm('inventory','manage'),
  listDeviceType, getDeviceType, createDeviceType, updateDeviceType, deleteDeviceType,
  deviceTypeCatalogService,
));
```

**F3:** `SetTaskInventoryReview` constructor is unchanged (still takes `SchedulingRepository`); only its `.execute` gains `actorId` (§6.2) — no DI change. Ensure the scheduling router already receives `setTaskInventoryReview` (`scheduling.routes.ts:85`) — it does.

---

## 10. Testing strategy (Strict TDD — red→green→refactor)

Per layer, test FIRST. Use InMemory ports, never Prisma mocks.

**Domain/InMemory adapter** (`src/__tests__/infrastructure/InMemoryDeviceTypeCatalogRepository.test.ts`):
- list ordered by `sortOrder`; getById/getByName (case-insensitive); create assigns id; update partial; delete; `countInUse` via a `public itemCounts: Record<string,number>` seam (mirror `InMemoryTaskPriorityRepository.taskCounts`); `listActiveNames` returns only `active` names uppercased.

**Use-cases** (`src/__tests__/application/*DeviceType.test.ts`) with `InMemoryDeviceTypeCatalogRepository`:
- Create: happy path; name-conflict (case-insensitive) → `DeviceTypeNameConflictError`; name persisted UPPERCASE.
- Update: not-found → `DeviceTypeNotFoundError`; rename-conflict.
- Delete: not-found; `OTROS` → `DeviceTypeProtectedError`; in-use (`itemCounts`) → `DeviceTypeInUseError`; clean delete.
- `normalizeQwenDeviceType`: rewrite `normalizeQwenDeviceType.test.ts` to pass an explicit `Set` — known→UPPERCASE, unknown/empty/null→null.
- `ConfirmInventorySuggestion`: override→that type; unknown override→`OTROS`; suggestion's own type used when no override; validity read from injected catalog repo (seed the InMemory catalog).
- `DeviceTypeCatalogService`: `isValid` true/false; `invalidate()` re-reads on next `ensure()`.
- `ExtractDeviceInfoFromPhoto`: `qwenDeviceType` normalized against the injected catalog (fake OCR + InMemory catalog).
- `SetTaskInventoryReview`: marking sets `reviewedByInventoryAt`+`...UserId` from `actorId`; unmarking clears both; not-found → `TaskNotFoundError` (extend `SetTaskInventoryReview.test.ts`).

**Routes (supertest, in-memory repos injected)**:
- `deviceTypeCatalog.routes`: GET list/by-id; POST 201 + 409 conflict; PUT 404/409; DELETE 204 + 409 in-use/protected; **403 without `inventory.manage`** on mutations, 200 read with `inventory.read`. Cache invalidation: after POST, a subsequent confirm with the new type is accepted.
- `contractInventory.routes`: confirm/add with an active catalog type → ok; with an unknown type → 422 `INVALID_ITEM_TYPE` (seed catalog via injected service); extend existing inventory route tests.
- `scheduling.inventoryReview.test.ts`: extend — response exposes `reviewedByInventoryAt` (non-null when reviewed) + `reviewedByInventoryUserName`; unsetting nulls both.

**FE (vitest + RTL)**:
- `DeviceTypesBody`: renders rows from mocked `useDeviceTypes`; create/edit modal submit; delete-confirm; 409 error mappings; mutation buttons hidden without `inventory.manage` (`Can` mock).
- `SuggestionCard` / `ServiceInventorySection`: dropdown options come from the hook (mock returns custom types e.g. `SWITCH`); unknown `deviceType` falls back to `OTROS`; empty hook → `['OTROS']` fallback.
- `InventoryPanel`: when `reviewedByInventory` true → badge `✓ Revisado · {name} · {date}`; when false → checkbox.

---

## 11. Open design notes / decisions

1. **FK to `RbacUser`, not `Admin`** — `req.user.id` is an RbacUser id; the existing inventory actor path resolves against `RbacUserRepository`. `onDelete: SetNull` so user deletion doesn't cascade to tasks. (§1.2)
2. **Seed inside the migration, not only `seed.ts`** — prod doesn't re-run `seed.ts`; dynamic validation against an empty table would reject everything. The 5 base types are seeded in migration #1. (§1.3)
3. **Cache (Option B) over per-request DB read (Option A)** for the route guard — keeps the hot confirm path DB-free; invalidated from the HTTP layer that owns the singleton after each catalog mutation. Trade-off: one stateful singleton. If the app ever scales horizontally, switch `ensure()` to a short TTL (e.g. 30s) — cache staleness window is bounded and the fallback is always `OTROS`, so it never breaks closure. (§3.2.3)
4. **OCR names via config provider, not port-signature change** — keeps `DevicePhotoOcr.extract` and the `ExtractDeviceInfoFromPhoto` use-case clean; adapter degrades to the 5 base names when no provider given. (§4)
5. **`OTROS` is non-deletable + is the universal fallback** — `DeviceTypeProtectedError` enforces it; `toType`/normalize fall back to `OTROS` for unknowns, guaranteeing the closure flow never blocks on a bad type. (§3.2.2)
6. **Union → `string`, alias kept on FE** — `InstalledItemType` widens to `string` but the alias name stays to minimize import churn; the BE `DeviceType` union + `VALID_DEVICE_TYPES` are deleted outright. (§5)
7. **`classifyDeviceType` untouched** — keyword→type map stays (out of scope); only its output is validated against the catalog (unknown→`OTROS`). Moving keywords to the table is a future change. (§4)
8. **Page read-gated, mutations manage-gated** — the settings route uses `inventory.read` (so anyone who can see inventory can view the catalog), while create/update/delete buttons + endpoints require `inventory.manage`. Mirrors how scheduling settings is read-gated with manage-gated mutations.
9. **Migration vs seed for `inventory.manage` grant** — decide in tasks by checking how `scheduling.manage` was first introduced in `prisma/migrations`; prefer an additive migration for super_admin + the idempotent seed block for `administrador`. (§7)
