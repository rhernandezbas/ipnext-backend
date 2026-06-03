<!-- generated from engram topic_key: sdd/service-inventory-management/design -->
## Design — service-inventory-management

> Multi-repo (BE `ipnext-backend` + FE `ipnext-frontend`). Strict TDD. Migraciones aditivas generadas SIN base de datos. Implementa el modelo de 3 conceptos del proposal (F1-F5). Esto alimenta `tasks → apply` sin re-investigar: cada decisión apunta a `path:line` del template a espejar.

### El modelo de 3 conceptos (recordatorio)

| Concepto | Tabla | Naturaleza | Template a espejar |
|----------|-------|-----------|--------------------|
| Equipo instalado | `ContractInstalledItem` (existe) | ESTADO durable del contrato | — (extender) |
| Catálogo de materiales | `MaterialCatalog` (NUEVO) | base de inventario (futuro `stockQuantity`) | `DeviceTypeCatalog` |
| Consumo por visita | `TaskMaterialConsumption` (NUEVO) | ledger por tarea | `TaskComment` |

`ConfirmInventorySuggestion` es el puente: `kind='DEVICE'` → `ContractInstalledItem` (como hoy); `kind='MATERIAL'` → resuelve/crea material en `MaterialCatalog` + crea `TaskMaterialConsumption`.

---

## 1. Prisma — modelos y migraciones

### 1.1 `MaterialCatalog` (mirror `DeviceTypeCatalog`, schema.prisma:528-538)

Espeja exactamente `DeviceTypeCatalog` + un campo `unit String?` (default lógico "unidad" se aplica en el use-case/seed, NO en la columna: la columna es nullable para no romper fixtures).

```prisma
model MaterialCatalog {
  id        String   @id @default(uuid())
  name      String   @unique          // canonical, UPPERCASE (CABLE_UTP, CONECTOR_RJ45, ...)
  label     String?                   // optional human label for the UI
  unit      String?                   // "m" | "unidad" | "rollo" — default applied in use-case
  active    Boolean  @default(true)
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  consumptions TaskMaterialConsumption[]

  @@map("MaterialCatalog")
}
```

### 1.2 `TaskMaterialConsumption` (mirror `TaskComment`, schema.prisma:968-978)

Ledger de consumo por tarea. FK a `ScheduledTask` Cascade (igual que TaskComment), FK a `MaterialCatalog` Restrict (no se borra un material en uso), `materialName` snapshot denormalizado (sobrevive renombres del catálogo), `recordedByUserId` FK `RbacUser` SetNull (mirror del patrón `reviewedByInventoryUserId`, schema.prisma:885-886).

```prisma
model TaskMaterialConsumption {
  id                String          @id @default(uuid())
  taskId            String
  task              ScheduledTask   @relation(fields: [taskId], references: [id], onDelete: Cascade)
  materialCatalogId String
  material          MaterialCatalog @relation(fields: [materialCatalogId], references: [id], onDelete: Restrict)
  materialName      String          // snapshot del nombre al momento del consumo
  quantity          Float
  unit              String?
  notes             String?         @db.Text
  recordedByUserId  String?
  recordedByUser    RbacUser?       @relation("TaskMaterialRecorder", fields: [recordedByUserId], references: [id], onDelete: SetNull)
  createdAt         DateTime        @default(now())
  updatedAt         DateTime        @updatedAt

  @@index([taskId])
}
```

**Back-relations a agregar** (schema.prisma):
- En `ScheduledTask` (junto a `comments TaskComment[]`, ~line 874):
  `materialConsumptions TaskMaterialConsumption[]`
- En `RbacUser` (junto a `tasksInventoryReviewed`, ~line 1598):
  `materialsRecorded TaskMaterialConsumption[] @relation("TaskMaterialRecorder")`

> `ContractInstalledItem` NO cambia de schema. El "remove" es soft (`status='removed'`, columna ya existe schema.prisma:775). El `type?` editable es DTO, no columna.

### 1.3 Las 3 migraciones (timestamps > `20260604070000`)

Generadas con `prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datamodel ... --script` (NO `migrate dev`: no hay DB). Seeds de catálogo van DENTRO de la migración, idempotentes con `ON CONFLICT DO NOTHING`. Aditivas.

**a) `20260604080000_add_material_catalog/migration.sql`** — tabla + seed (mirror `20260604050000`):

```sql
-- CreateTable
CREATE TABLE "MaterialCatalog" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "unit" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MaterialCatalog_name_key" ON "MaterialCatalog"("name");

-- Seed: materiales base (idempotent — safe to replay)
INSERT INTO "MaterialCatalog" ("id","name","unit","active","sortOrder","createdAt","updatedAt")
VALUES
  (gen_random_uuid(),'CABLE_UTP',     'm',      true, 0, now(), now()),
  (gen_random_uuid(),'CABLE_FIBRA',   'm',      true, 1, now(), now()),
  (gen_random_uuid(),'CONECTOR_RJ45', 'unidad', true, 2, now(), now()),
  (gen_random_uuid(),'CONECTOR_FIBRA','unidad', true, 3, now(), now()),
  (gen_random_uuid(),'PRECINTO',      'unidad', true, 4, now(), now()),
  (gen_random_uuid(),'ROSETA',        'unidad', true, 5, now(), now()),
  (gen_random_uuid(),'OTRO',          'unidad', true, 6, now(), now())
ON CONFLICT (name) DO NOTHING;
```

> `OTRO` es el material protegido (no borrable), análogo a `OTROS` en device types (DeleteDeviceType.ts:11). Usado como fallback cuando `ConfirmInventorySuggestion` no encuentra match.

**b) `20260604090000_add_task_material_consumption/migration.sql`** — tabla + FKs + index (mirror `20260527110000_add_task_comments`):

```sql
-- CreateTable
CREATE TABLE "TaskMaterialConsumption" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "materialCatalogId" TEXT NOT NULL,
    "materialName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "notes" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskMaterialConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskMaterialConsumption_taskId_idx" ON "TaskMaterialConsumption"("taskId");

-- AddForeignKey
ALTER TABLE "TaskMaterialConsumption" ADD CONSTRAINT "TaskMaterialConsumption_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMaterialConsumption" ADD CONSTRAINT "TaskMaterialConsumption_materialCatalogId_fkey" FOREIGN KEY ("materialCatalogId") REFERENCES "MaterialCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMaterialConsumption" ADD CONSTRAINT "TaskMaterialConsumption_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

**c) `20260604100000_add_inventory_write_permission/migration.sql`** — RBAC (mirror `20260604060000` + `20260604010000`). Ver §5.

---

## 2. Domain — entities, ports, errors

### 2.1 Entities

**`src/domain/entities/material-catalog.ts`** (mirror `device-type-catalog.ts`):
```ts
export interface MaterialCatalog {
  id: string;
  name: string;       // canonical UPPERCASE
  label: string | null;
  unit: string | null;
  active: boolean;
  sortOrder: number;
}
```

**`src/domain/entities/task-material-consumption.ts`** (nuevo):
```ts
export interface TaskMaterialConsumption {
  id: string;
  taskId: string;
  materialCatalogId: string;
  materialName: string;        // snapshot
  quantity: number;
  unit: string | null;
  notes: string | null;
  recordedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### 2.2 Ports

**`src/domain/ports/MaterialCatalogRepository.ts`** (mirror `DeviceTypeCatalogRepository.ts` 1:1, con `unit`):
```ts
import { MaterialCatalog } from '../entities/material-catalog';

export interface MaterialCatalogRepository {
  list(): Promise<MaterialCatalog[]>;
  getById(id: string): Promise<MaterialCatalog | null>;
  getByName(name: string): Promise<MaterialCatalog | null>;
  create(data: { name: string; label?: string | null; unit?: string | null; active?: boolean; sortOrder?: number }): Promise<MaterialCatalog>;
  update(id: string, data: Partial<{ name: string; label: string | null; unit: string | null; active: boolean; sortOrder: number }>): Promise<MaterialCatalog | null>;
  delete(id: string): Promise<boolean>;
  /** How many TaskMaterialConsumption rows reference this material id (delete guard). */
  countInUse(materialId: string): Promise<number>;
  /** Active material NAMES (UPPERCASE) — the valid set for confirm/route validation. */
  listActiveNames(): Promise<string[]>;
}
```

> **Diferencia clave con DeviceType**: `countInUse` recibe el **id** (no el name), porque `TaskMaterialConsumption` referencia por FK `materialCatalogId` (no por string). Esto evita el problema de renombre que tiene DeviceType (que cuenta por `type` name).

**`src/domain/ports/TaskMaterialConsumptionRepository.ts`** (nuevo, mirror `TaskCommentRepository.ts`):
```ts
import { TaskMaterialConsumption } from '../entities/task-material-consumption';

export interface TaskMaterialConsumptionRepository {
  listByTask(taskId: string): Promise<TaskMaterialConsumption[]>;
  create(consumption: TaskMaterialConsumption): Promise<TaskMaterialConsumption>;
  delete(id: string): Promise<boolean>;
}
```

**`src/domain/ports/ContractInventoryRepository.ts`** (extender, line 1-7) — agregar `remove`:
```ts
export interface ContractInventoryRepository {
  listByContract(contractId: string): Promise<ContractInstalledItem[]>;
  getById(id: string): Promise<ContractInstalledItem | null>;   // NEW — needed by RemoveInstalledItem idempotency guard
  create(item: ContractInstalledItem): Promise<ContractInstalledItem>;
  update(id: string, patch: Partial<ContractInstalledItem>): Promise<ContractInstalledItem | null>;
  /** Soft-delete: status -> 'removed'. Returns the updated item, or null if not found. */
  remove(id: string): Promise<ContractInstalledItem | null>;
}
```

> **Decisión**: `remove` es un método propio (no `update(id,{status})`) para que la regla de negocio (idempotencia, no re-remover `removed`/`replaced`) viva en el use-case y el port exprese la intención. `getById` se agrega porque el guard de idempotencia necesita leer el estado actual antes de remover. Implementación Prisma de `remove` = `update({ status:'removed' })`; InMemory idéntico.

### 2.3 Errores nuevos — `src/domain/errors/inventory.ts` (append, mirror DeviceType* errors lines 24-50)

```ts
export class MaterialNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Material with id ${id} not found`, 'MATERIAL_NOT_FOUND');
    this.name = 'MaterialNotFoundError';
  }
}
export class MaterialNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A material named "${name}" already exists`, 'MATERIAL_NAME_CONFLICT');
    this.name = 'MaterialNameConflictError';
  }
}
export class MaterialInUseError extends DomainError {
  constructor(public readonly usageCount: number) {
    super(`Material is in use by ${usageCount} consumption record(s)`, 'MATERIAL_IN_USE');
    this.name = 'MaterialInUseError';
  }
}
export class MaterialProtectedError extends DomainError {
  constructor() {
    super('The OTRO material cannot be deleted', 'MATERIAL_PROTECTED');
    this.name = 'MaterialProtectedError';
  }
}
export class InstalledItemNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Installed item ${id} not found`, 'INSTALLED_ITEM_NOT_FOUND');
    this.name = 'InstalledItemNotFoundError';
  }
}
export class InstalledItemAlreadyRemovedError extends DomainError {
  constructor(id: string) {
    super(`Installed item ${id} is already removed/replaced`, 'INSTALLED_ITEM_ALREADY_REMOVED');
    this.name = 'InstalledItemAlreadyRemovedError';
  }
}
export class MaterialConsumptionNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Material consumption ${id} not found`, 'MATERIAL_CONSUMPTION_NOT_FOUND');
    this.name = 'MaterialConsumptionNotFoundError';
  }
}
```

> `InstalledItemNotFoundError` NO existía como clase — la ruta PATCH hoy responde 404 con string crudo (`contractInventory.routes.ts:107`). Lo formalizamos.

---

## 3. Application — use-cases, service, DTOs

### 3.1 MaterialCatalog CRUD (espeja device-type use-cases 1:1)

Un archivo por caso en `src/application/use-cases/`:
- `ListMaterial.ts` → `repo.list()` (mirror `ListDeviceType`)
- `GetMaterial.ts` → `repo.getById`, throw `MaterialNotFoundError`
- `CreateMaterial.ts` (mirror `CreateDeviceType.ts:1-13`): normaliza `name.trim().toUpperCase()`, chequea `getByName` → `MaterialNameConflictError`, default `unit = data.unit ?? 'unidad'`.
- `UpdateMaterial.ts` (mirror `UpdateDeviceType`): si cambia `name`, re-normaliza + chequea conflicto.
- `DeleteMaterial.ts` (mirror `DeleteDeviceType.ts:4-18`): orden de guard idéntico → (1) `getById` o `MaterialNotFoundError`; (2) `name === 'OTRO'` → `MaterialProtectedError`; (3) `countInUse(id) > 0` → `MaterialInUseError`; (4) `repo.delete(id)`.

**`src/application/services/MaterialCatalogService.ts`** (mirror `DeviceTypeCatalogService.ts` 1:1): cache `Set<string>` de nombres activos, `ensure()/invalidate()/isValid()`. Lo consume `ConfirmInventorySuggestion` y (opcional) validación de rutas.

### 3.2 DTOs — `src/application/dto/inventory.dto.ts` (append al archivo existente)

```ts
export const CreateMaterialSchema = z.object({
  name:      z.string().min(1),
  label:     z.string().nullish(),
  unit:      z.string().nullish(),
  active:    z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export const UpdateMaterialSchema = CreateMaterialSchema.partial();
export type CreateMaterialInput = z.infer<typeof CreateMaterialSchema>;
export type UpdateMaterialInput = z.infer<typeof UpdateMaterialSchema>;

export interface MaterialCatalogDto {
  id: string; name: string; label: string | null; unit: string | null;
  active: boolean; sortOrder: number; createdAt: string; updatedAt: string;
}
```

**`src/application/dto/MaterialConsumptionDto.ts`** (nuevo, mirror `InstalledItemDto.ts`): entidad + `recordedByUserName: string | null` resuelto desde `recordedByUserId`. `toMaterialConsumptionDto(entity, userName)`.

### 3.3 Material consumption use-cases (`src/application/use-cases/`)

- **`RecordMaterialConsumption.ts`** — input `{ taskId, materialCatalogId, quantity, unit?, notes?, recordedByUserId? }`. Resuelve el material (`materialRepo.getById` → `MaterialNotFoundError`), toma `materialName = material.name` (snapshot) y `unit = input.unit ?? material.unit`, crea via `consumptionRepo.create`.
- **`ListTaskMaterialConsumptions.ts`** — `consumptionRepo.listByTask(taskId)`, resuelve nombres de usuario via `RbacUserRepository.findById` (mirror `ListContractInstalledItems`), devuelve `MaterialConsumptionDto[]`.
- **`DeleteMaterialConsumption.ts`** — `consumptionRepo.delete(id)`; si `false` → `MaterialConsumptionNotFoundError`.

### 3.4 `RemoveInstalledItem.ts` (nuevo) — soft-delete idempotente

```ts
export class RemoveInstalledItem {
  constructor(private readonly inventory: ContractInventoryRepository) {}
  async execute(itemId: string): Promise<ContractInstalledItem> {
    const item = await this.inventory.getById(itemId);
    if (!item) throw new InstalledItemNotFoundError(itemId);
    if (item.status !== 'active') throw new InstalledItemAlreadyRemovedError(itemId); // idempotency guard
    const removed = await this.inventory.remove(itemId);
    if (!removed) throw new InstalledItemNotFoundError(itemId);
    return removed;
  }
}
```

> **Decisión soft vs hard**: SOFT (`status='removed'`). El proposal lo exige (preserva historial; `replace` futuro necesita el rastro). El guard `status !== 'active'` hace la operación idempotente y evita re-remover un `removed`/`replaced`.

### 3.5 `UpdateInstalledItem` gana `type?` (UpdateInstalledItem.ts:4-19)

Agregar `type?: string` a `UpdateInstalledItemInput`. La **validación contra el catálogo** vive en la RUTA (como ya hace POST, `contractInventory.routes.ts:86`), usando `DeviceTypeCatalogService.isValid` → 422 `INVALID_ITEM_TYPE`. El use-case solo pasa el patch. No se valida en el use-case para no acoplarlo al service de catálogo (DIP: el use-case no necesita saber del catálogo de tipos; la ruta es el borde de validación de input, igual que el POST hoy).

### 3.6 `ConfirmInventorySuggestion` ramifica por `kind` ⚠️ (toca el flujo de cierre en PROD)

Hoy (`ConfirmInventorySuggestion.ts:36-75`) SIEMPRE crea un `ContractInstalledItem`. Para `kind='MATERIAL'` eso tira `materialDesc/quantity/unit` y crea un device `OTROS` basura. Nuevo comportamiento:

**Constructor** — agregar dos deps:
```ts
constructor(
  private readonly suggestions: InventorySuggestionRepository,
  private readonly inventory: ContractInventoryRepository,
  private readonly scheduling: SchedulingRepository,
  private readonly users: RbacUserRepository,
  private readonly catalog: DeviceTypeCatalogRepository,
  private readonly materials: MaterialCatalogRepository,           // NEW
  private readonly consumptions: TaskMaterialConsumptionRepository, // NEW
) {}
```

**Output** — el caso devuelve hoy `InstalledItemDto`. Cambiar a una unión discriminada para que la ruta sepa qué confirmó:
```ts
export type ConfirmResult =
  | { kind: 'DEVICE'; item: InstalledItemDto }
  | { kind: 'MATERIAL'; consumption: MaterialConsumptionDto };
```

**Flujo** (preservar las precondiciones existentes: `SuggestionNotFoundError`, `SuggestionAlreadyConfirmedError`, `TaskHasNoContractError`):

1. Cargar suggestion + guards (igual que hoy, líneas 37-43). El guard `TaskHasNoContractError` aplica a AMBOS kinds (el consumo se ancla a la tarea, pero confirmar requiere que la tarea tenga contrato — mantiene la semántica "esto es inventario del servicio").
2. `if (suggestion.kind === 'DEVICE')` → **rama actual sin cambios** (líneas 45-74): `toType`, `inventory.create`, `setStatus('confirmed', item.id, persistedType)`, devolver `{ kind:'DEVICE', item }`.
3. `else (MATERIAL)` → **rama nueva**:
   - Resolver el material en el catálogo por nombre (`resolveMaterial`, ver §8 decisión create-if-missing):
     ```ts
     const desc = (suggestion.materialDesc ?? '').trim();
     const canonical = desc.toUpperCase();
     let material = desc ? await this.materials.getByName(canonical) : null;
     if (!material && desc) material = await this.materials.create({ name: canonical, unit: suggestion.unit });
     if (!material) material = await this.materials.getByName('OTRO');   // fallback
     ```
   - Crear el consumo:
     ```ts
     const consumption = await this.consumptions.create({
       id: randomUUID(),
       taskId: suggestion.taskId,
       materialCatalogId: material.id,
       materialName: suggestion.materialDesc ?? material.name,   // snapshot preserva el texto original de IClass
       quantity: suggestion.quantity ?? 1,
       unit: suggestion.unit ?? material.unit,
       notes: null,
       recordedByUserId: input.addedByUserId ?? null,
       createdAt: now, updatedAt: now,
     });
     ```
   - `await this.suggestions.setStatus(suggestion.id, 'confirmed', consumption.id);`
   - Resolver `recordedByUserName` y devolver `{ kind:'MATERIAL', consumption: toMaterialConsumptionDto(...) }`.

> El campo `confirmedItemId` de la suggestion (schema.prisma:755) ahora puede apuntar a un `ContractInstalledItem.id` O a un `TaskMaterialConsumption.id` según el kind. Es un string opaco; no hay FK, así que no rompe. El FE ya solo lo usa como "está resuelto" (truthy check).

---

## 4. HTTP routes

### 4.1 Material catalog CRUD — `src/infrastructure/http/routes/materialTypeCatalog.routes.ts`

Mirror EXACTO de `deviceTypeCatalog.routes.ts` (factory con `authProvider, requirePerm, list, get, create, update, del, service`). Rutas bajo `/material-types`:
- `GET /material-types` → `readPerm = requirePerm('inventory','read')`
- `GET /material-types/:id` → readPerm, 404 `MaterialNotFoundError`
- `POST /material-types` → `managePerm = requirePerm('inventory','manage')`, 409 `MaterialNameConflictError`, `service.invalidate()`
- `PUT /material-types/:id` → managePerm, 404/409
- `DELETE /material-types/:id` → managePerm, 404 `MaterialNotFoundError`, 409 `MaterialInUseError` / `MaterialProtectedError`

Montaje en `app.ts` junto al device-type router (~line 943):
```ts
app.use('/api/inventory', createMaterialTypeCatalogRouter(
  authAdapter, requirePerm,
  listMaterial, getMaterial, createMaterial, updateMaterial, deleteMaterial,
  materialCatalogService,
));
```
Resultado: `/api/inventory/material-types`.

### 4.2 Task material consumption — agregar al `createContractInventoryRouter`

Las rutas task-scoped de consumo van DENTRO del router de inventario existente (`contractInventory.routes.ts`), porque comparten el montaje `/api` antes del catch-all de scheduling (`app.ts:998`). Agregar al factory las 3 use-cases (`recordConsumption, listConsumptions, deleteConsumption`) y rutas:

```ts
// GET — lista el consumo de la tarea
router.get('/scheduling/:taskId/inventory/materials', auth, perms.taskRead, async (req,res,next) => {
  try { res.json(await listConsumptions.execute(req.params.taskId)); } catch(e){ next(e); }
});
// POST — registra consumo (valida materialCatalogId existe en el use-case)
router.post('/scheduling/:taskId/inventory/materials', auth, perms.materialWrite, async (req,res,next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const c = await recordConsumption.execute({
      taskId: req.params.taskId,
      materialCatalogId: b.materialCatalogId as string,
      quantity: Number(b.quantity),
      unit: (b.unit as string) ?? null,
      notes: (b.notes as string) ?? null,
      recordedByUserId: userId(req),
    });
    res.status(201).json(c);
  } catch(e){ next(e); }   // MaterialNotFoundError → mapear a 404 en errorHandler o catch local
});
// DELETE
router.delete('/scheduling/:taskId/inventory/materials/:id', auth, perms.materialWrite, async (req,res,next) => {
  try { await deleteConsumption.execute(req.params.id); res.status(204).send(); } catch(e){ next(e); }
});
```

> `perms.materialWrite = requirePerm('inventory','write')`. Validación de body (`materialCatalogId` requerido, `quantity` numérico) con un Zod schema en `inventory.dto.ts` (`RecordConsumptionSchema`) → 400 `VALIDATION_ERROR`.

### 4.3 Contract inventory: DELETE + migración de guards

**Nueva ruta** en `contractInventory.routes.ts` (después del PATCH, line 112):
```ts
router.delete('/contracts/:contractId/inventory/:itemId', auth, perms.contractWrite, async (req,res,next) => {
  try {
    const removed = await removeItem.execute(req.params.itemId);
    res.json(removed);          // 200 con el item soft-removido (status='removed')
  } catch(e){ next(e); }        // InstalledItemNotFoundError→404, InstalledItemAlreadyRemovedError→409
});
```
`removeItem: RemoveInstalledItem` se agrega al factory. Mapear errores: 404 `INSTALLED_ITEM_NOT_FOUND`, 409 `INSTALLED_ITEM_ALREADY_REMOVED` (catch local, como el PATCH; o vía errorHandler central).

**PATCH gana `type`** — en el handler PATCH (line 103-112) validar `body.type` contra `deviceTypes.isValid` (igual que el POST, líneas 85-88) si viene presente → 422 `INVALID_ITEM_TYPE`.

### 4.4 `InventoryRoutePerms` — migración `clients.* → inventory.*` (app.ts:1010-1015) ⚠️

Cambiar la interface y el wiring. La interface (`contractInventory.routes.ts:16-21`) gana dos campos para consumo de materiales:
```ts
export interface InventoryRoutePerms {
  taskRead: RequestHandler;       // scheduling.read  (suggestions — NO cambia)
  taskWrite: RequestHandler;      // scheduling.write (suggestions — NO cambia)
  contractRead: RequestHandler;   // inventory.read   (era clients.read)
  contractWrite: RequestHandler;  // inventory.write  (era clients.write)
  materialWrite: RequestHandler;  // inventory.write  (NEW)
}
```

Wiring en `app.ts` (líneas 1002-1017), cambios EXACTOS:
```ts
app.use('/api', createContractInventoryRouter(
  new ListTaskInventorySuggestions(inventorySuggestionRepo),
  new ConfirmInventorySuggestion(
    inventorySuggestionRepo, contractInventoryRepo, schedulingRepo, rbacUserRepo,
    deviceTypeCatalogRepo, materialCatalogRepo, taskMaterialConsumptionRepo,   // +2 deps
  ),
  new DiscardInventorySuggestion(inventorySuggestionRepo),
  new ListContractInstalledItems(contractInventoryRepo, rbacUserRepo),
  new AddInstalledItemManually(contractInventoryRepo),
  new UpdateInstalledItem(contractInventoryRepo),
  new RemoveInstalledItem(contractInventoryRepo),                              // NEW
  new RecordMaterialConsumption(taskMaterialConsumptionRepo, materialCatalogRepo), // NEW
  new ListTaskMaterialConsumptions(taskMaterialConsumptionRepo, rbacUserRepo),     // NEW
  new DeleteMaterialConsumption(taskMaterialConsumptionRepo),                       // NEW
  createAuthMiddleware(authAdapter, sessionRepo),
  {
    taskRead:      requirePerm('scheduling', 'read'),   // suggestions — sin cambio
    taskWrite:     requirePerm('scheduling', 'write'),  // suggestions — sin cambio
    contractRead:  requirePerm('inventory', 'read'),    // ← era 'clients','read'
    contractWrite: requirePerm('inventory', 'write'),   // ← era 'clients','write'
    materialWrite: requirePerm('inventory', 'write'),   // NEW
  },
  deviceTypeCatalogService,
));
```

Nuevos repos a instanciar arriba (junto a `contractInventoryRepo`, line 1001):
```ts
const materialCatalogRepo = new PrismaMaterialCatalogRepository();
const taskMaterialConsumptionRepo = new PrismaTaskMaterialConsumptionRepository();
const materialCatalogService = new MaterialCatalogService(materialCatalogRepo);
const listMaterial = new ListMaterial(materialCatalogRepo);
const getMaterial = new GetMaterial(materialCatalogRepo);
const createMaterial = new CreateMaterial(materialCatalogRepo);
const updateMaterial = new UpdateMaterial(materialCatalogRepo);
const deleteMaterial = new DeleteMaterial(materialCatalogRepo);
```

> **Las rutas de suggestions (`taskRead/taskWrite`) siguen en `scheduling.*`** — son otro flujo (el closure-loop), como dice el proposal. Solo migran las rutas de inventario del CONTRATO.

---

## 5. RBAC `inventory.write` — migración `20260604100000_add_inventory_write_permission`

Mirror de `20260604060000` (manage) + `20260604010000` (resend). Crea el permiso `inventory.write` y lo otorga a `tecnico` + `administrador` + `super_admin`. (`'write'` ∈ `KNOWN_ACTIONS`; el módulo `inventory` existe — rbac.ts:85. La fila probablemente YA existe del cross-join de la foundation migration, por eso el INSERT del permiso es safety-net idempotente. Lo crítico son los GRANTS.)

```sql
BEGIN;

-- 1. Crear el permiso inventory.write (idempotente — probablemente ya sembrado por la foundation).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'write'
FROM "RbacModule" m
WHERE m."code" = 'inventory'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 2. Otorgar inventory.read + inventory.write a tecnico, administrador, super_admin (idempotente).
--    Roles operativos del inventario. read incluido para que la migración clients.*→inventory.*
--    no deje sin LECTURA a quien hoy ve el inventario del contrato.
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('tecnico', 'administrador', 'super_admin')
  AND m."code" = 'inventory'
  AND p."action" IN ('read', 'write')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
```

Formas exactas de tabla (confirmadas en schema):
- `RbacPermission` — `@@unique([moduleId, action])` (schema.prisma:1567); `action @db.VarChar(64)`.
- `RbacRolePermission` — `@@id([roleId, permissionId])` (schema.prisma:1649), columna `createdAt`.
- `RbacModule.code @unique`, `RbacRole.code @unique`.

> **Riesgo (proposal §Riesgos)**: mover de `clients.*` a `inventory.*` puede dejar sin acceso a quien tenga `clients.write` pero no `inventory.write`. Esta migración otorga `inventory.read+write` a los 3 roles operativos. Revisar el SQL antes de pushear; deploy BE antes que FE.

---

## 6. Frontend (`ipnext-frontend`)

### 6.1 Catálogo de materiales (mirror device-types stack)

- **`src/types/materialType.ts`** (mirror `deviceType.ts`): `MaterialType { id, name, label, unit: string|null, active, sortOrder, createdAt, updatedAt }`.
- **`src/api/materialTypes.api.ts`** (mirror `deviceTypes.api.ts`): `BASE = '/inventory/material-types'`, `list/create/update/delete`.
- **`src/hooks/useMaterialTypes.ts`** (mirror `useDeviceTypes.ts`): `KEY = ['material-types']`, `useMaterialTypes/useCreate/useUpdate/useDeleteMaterialType`.
- **`src/pages/inventory/settings/MaterialsBody.tsx`** (mirror `DeviceTypesBody.tsx`): toolbar + tabla + modal. Columnas: Nombre, Etiqueta, **Unidad**, Activo, Orden. Modal con campo extra `unit` (input texto). Gates `<Can permission="inventory.manage">`. Manejo de errores 409: `MATERIAL_NAME_CONFLICT`, `MATERIAL_IN_USE`, `MATERIAL_PROTECTED`.
- **`InventorySettingsPage.tsx`** (líneas 6-8): agregar el tab:
  ```tsx
  const TABS = [
    { id: 'equipos', label: 'Equipos', content: <DeviceTypesBody /> },
    { id: 'materiales', label: 'Materiales', content: <MaterialsBody /> },
  ];
  ```

### 6.2 Equipos del contrato: editar + quitar (`ServiceInventorySection.tsx`)

- **Migrar el gate** `clients.write` → `inventory.write` (líneas 60). El gate de lectura de la sección lo controla el padre (la sección se renderiza si hay `inventory.read`).
- Agregar acciones por fila (columna nueva al final de la tabla, líneas 84-101):
  - **Editar** → modal con `type` (select de `useDeviceTypes` activos), `serialNumber`, `mac`, `model`, `notes`, `status`. Usa `useUpdateInstalledItem` (ya existe, useServiceInventory.ts:25). El body incluye `type` (el BE ahora lo acepta + valida).
  - **Quitar** → `useConfirm` + nuevo hook `useRemoveInstalledItem` → `DELETE /contracts/:id/inventory/:itemId`. Tras éxito, invalida `['service-inventory', serviceId]`. Mostrar filas `removed` atenuadas o filtrarlas (decisión §8).
- Ambas acciones gateadas por `<Can permission="inventory.write">`.

**`serviceInventory.api.ts`** — agregar:
```ts
export const removeInstalledItem = (contractId: string, itemId: string) =>
  axiosClient.delete(`/contracts/${contractId}/inventory/${itemId}`).then(r => r.data);
```
**`useServiceInventory.ts`** — `useRemoveInstalledItem(serviceId)` (mirror `useUpdateInstalledItem`).

### 6.3 Consumo de materiales en el tab de inventario de la tarea

Nuevo componente **`src/pages/scheduling/SchedulingTaskDetailPage/components/TaskMaterialConsumptions.tsx`** (hermano de `TaskInventorySuggestions.tsx`), montado en `TaskTabs.tsx` debajo de `<TaskInventorySuggestions taskId={taskId} />` (line 113):
- Lista el consumo (`GET /scheduling/:taskId/inventory/materials`) + form de alta (dropdown poblado con `useMaterialTypes` activos, input cantidad, unidad auto desde el material, notas).
- Hooks nuevos en `useServiceInventory.ts` (o un `useTaskMaterials.ts` dedicado): `useTaskMaterialConsumptions(taskId)`, `useRecordMaterialConsumption(taskId)`, `useDeleteMaterialConsumption(taskId)`. Key `['task-material-consumptions', taskId]`.
- API nueva en `serviceInventory.api.ts`: `listTaskMaterials/recordTaskMaterial/deleteTaskMaterial`.
- Gate de alta/borrado: `can('inventory.write')` (via `useMyPermissions`, igual que `TaskInventorySuggestions` usa `scheduling.write`).
- El `SuggestionCard` de confirmación para `kind='MATERIAL'` ahora resuelve a un consumo: tras `confirm.mutate`, invalidar TAMBIÉN `['task-material-consumptions', taskId]` (hoy invalida `['service-inventory']`, useServiceInventory.ts:50).

### 6.4 F4 — Reemplazar el `ComingSoonPanel` del CustomerSidebar (CustomerSidebar.tsx:80-89)

Reemplazar el tab `inventario` (placeholder líneas 83-88) por el inventario REAL del contrato, **read-only** en el sidebar (el CRUD vive en `ServiceInventorySection` y el tab de inventario de la tarea):

```tsx
{
  id: 'inventario',
  label: 'Inventario',
  content: contractId
    ? <ContractInventoryReadonly contractId={contractId} taskId={taskId} />
    : <ComingSoonPanel title="Inventario del cliente" description="Esta tarea no tiene contrato asociado." />,
}
```

Nuevo componente **`ContractInventoryReadonly.tsx`** (junto a CustomerSidebar):
- **Equipos instalados**: reusa `useServiceInstalledItems(contractId)` (useServiceInventory.ts:9 — el mismo hook que `ServiceInventorySection`, NO se reinventa el fetching). Tabla read-only (tipo, SN, MAC, estado).
- **Resumen de materiales consumidos**: `useTaskMaterialConsumptions(taskId)` (la tarea actual) — lista material + cantidad. (Agregación por contrato queda fuera; el sidebar muestra el consumo de ESTA tarea, que es lo que el operador necesita validar.)
- Gateado por `inventory.read` (si el user no lo tiene, el tab muestra un mensaje de permiso o se oculta). Sin acciones de escritura en el sidebar (decisión §8: read-only).

**Threading de `contractId`/`taskId`**: `CustomerSidebar` YA recibe `contractId` (prop, line 16). Falta `taskId` — agregarlo a `CustomerSidebarProps` y pasarlo desde `SchedulingTaskDetailPage.tsx` donde se monta el sidebar (el `taskId` ya está en scope ahí, es el de la página).

### 6.5 Formato de permisos (dot-format)

FE usa dot-format con `<Can permission="inventory.read|write|manage">` y `useMyPermissions().can('inventory.write')`. El BE expone los flat codes vía `ResolveUserPermissions` (app.ts:498) como `inventory.read/write/manage`. Consistente con el resto del sistema.

---

## 7. Testing strategy (Strict TDD: red → green → refactor)

### BE — adapters
- **`InMemoryMaterialCatalogRepository`** (mirror `InMemoryDeviceTypeCatalogRepository.ts`): array in-memory + seam `usageCounts: Record<string, number>` para `countInUse(id)`. Test del contrato del port.
- **`InMemoryTaskMaterialConsumptionRepository`** (mirror in-memory comment repo): Map por id, `listByTask` filtra por taskId.
- **`InMemoryContractInventoryRepository`** (extender, InMemoryContractInventoryRepository.ts): agregar `getById` + `remove` (= `update status='removed'`).

### BE — use-cases (con InMemory repos, NUNCA mock de Prisma)
- MaterialCatalog CRUD: espejar la suite de device-types (`__tests__/application/...DeviceType*`). Cubrir: create normaliza UPPERCASE + conflict; delete order-of-guards (`OTRO` protegido ANTES de in-use); update conflict.
- `RecordMaterialConsumption`: snapshot de `materialName`/`unit`; `MaterialNotFoundError` si el material no existe.
- `ListTaskMaterialConsumptions`: resuelve nombres de usuario.
- `DeleteMaterialConsumption`: `MaterialConsumptionNotFoundError`.
- `RemoveInstalledItem`: happy path (active→removed); idempotencia (`removed`→`InstalledItemAlreadyRemovedError`); not-found.
- **`ConfirmInventorySuggestion`** (⚠️ regresión): la suite existente es la RED. Tests nuevos: `kind='DEVICE'` sigue creando item (sin cambios); `kind='MATERIAL'` crea consumption + resuelve material existente; `kind='MATERIAL'` crea material si no existe (create-if-missing); fallback a `OTRO` si `materialDesc` vacío; `TaskHasNoContractError` para ambos kinds; preserva `materialDesc/quantity/unit` en el consumo.

### BE — routes (supertest, repos in-memory inyectados)
- `material-types` CRUD: 200/201/204, 400 validation, 404, 409 (conflict/in-use/protected), guards `inventory.read` vs `inventory.manage` (403 sin permiso).
- `/scheduling/:taskId/inventory/materials` GET/POST/DELETE bajo `inventory.write`.
- `DELETE /contracts/:contractId/inventory/:itemId`: 200 soft-remove, 404, 409 already-removed, guard `inventory.write`.
- Migración de guards: confirmar que las rutas de contrato ahora exigen `inventory.*` (no `clients.*`).

### FE — vitest + RTL
- `MaterialsBody.test.tsx` (mirror `__tests__/inventory/DeviceTypesBody.test.tsx`): render, alta, edición, borrado, errores 409, columna unidad.
- `ServiceInventorySection`: acciones editar/quitar visibles solo con `inventory.write`; confirm de quitar.
- `TaskMaterialConsumptions`: alta y borrado de consumo.
- `ContractInventoryReadonly`: render read-only; sin acciones de escritura.
- `SuggestionCard.test.tsx` (existe): mantener verde; el confirm de `MATERIAL` no rompe.

---

## 8. Decisiones abiertas (resueltas con rationale)

1. **Soft-delete vs hard-delete de equipos** → **SOFT** (`status='removed'`). El proposal lo exige (historial + base para `replace` futuro). `RemoveInstalledItem` con guard `status !== 'active'` lo hace idempotente.

2. **`ConfirmInventorySuggestion` MATERIAL: create-if-missing vs require-existing** → **CREATE-IF-MISSING**. La suggestion viene de IClass con `materialDesc` arbitrario (free-text); exigir que el operador pre-cargue cada material en el catálogo antes de confirmar bloquearía el flujo de cierre (ya en prod). Se resuelve por nombre canónico (UPPERCASE); si no existe, se crea con el `unit` de la suggestion; si `materialDesc` viene vacío, fallback a `OTRO`. El `materialName` del consumo guarda el texto ORIGINAL de IClass (snapshot), no el canónico, para no perder el detalle. **Trade-off**: puede ensuciar el catálogo con materiales auto-creados; mitigación → el catálogo es editable (ABM F2) y `MaterialsBody` permite desactivar/renombrar.

3. **`countInUse` por id vs por name** → **por id** (FK `materialCatalogId`). A diferencia de DeviceType (que cuenta por `type` string y sufre si renombrás), el consumo referencia el material por FK, así que el guard de borrado es exacto y robusto a renombres.

4. **Sidebar inventario: read-only vs editable** → **READ-ONLY**. El proposal F4 lo dice explícito ("read-only en el sidebar; el CRUD completo vive en ServiceInventorySection/el tab de inventario"). Evita duplicar lógica de mutación y mantener dos surfaces de escritura sincronizadas. El sidebar es la VISTA del estado del contrato.

5. **Material protegido** → **`OTRO`** (análogo a `OTROS` en device types). No borrable; fallback de `ConfirmInventorySuggestion`.

6. **Output de `ConfirmInventorySuggestion`** → **unión discriminada** `{kind:'DEVICE',item} | {kind:'MATERIAL',consumption}`. La ruta de confirm hoy responde `201 json(item)`; con la unión responde el item o el consumo según el kind, y el FE invalida la query correcta. Alternativa descartada: siempre devolver `InstalledItemDto` (mentiría para materiales).

7. **`unit` nullable en columna, default en use-case** → la columna `unit String?` es nullable para no romper fixtures/migración aditiva sin DB; el default real ("unidad") lo pone `CreateMaterial` y el seed de la migración. Consistente con el patrón `projectId` opcional del CLAUDE.md.

8. **Rutas de consumo dentro de `createContractInventoryRouter` vs router nuevo** → **dentro del router existente**. Comparten el montaje `/api` antes del catch-all de scheduling (app.ts:998) y la dependencia de auth; un router nuevo duplicaría el wiring de montaje delicado. El factory crece pero el orden de montaje queda garantizado.

---

## 9. Orden de implementación sugerido (para tasks)

1. **Schema + 3 migraciones** (MaterialCatalog, TaskMaterialConsumption, inventory.write RBAC) — base.
2. **Domain**: entities, ports (`MaterialCatalogRepository`, `TaskMaterialConsumptionRepository`, extender `ContractInventoryRepository`), errores.
3. **Adapters**: Prisma + InMemory de los 2 nuevos ports + extensión del de contrato.
4. **Use-cases MaterialCatalog** (5) + `MaterialCatalogService` + DTOs (TDD con InMemory).
5. **Use-cases consumo** (`Record/List/Delete`) + `RemoveInstalledItem` + `UpdateInstalledItem.type` (TDD).
6. **`ConfirmInventorySuggestion` ramifica por kind** ⚠️ (TDD, suite existente como red) — el batch más delicado, aislado.
7. **Routes** (material-types router + extensión del contract-inventory router) + wiring `app.ts` (DI + migración de guards `clients→inventory`).
8. **FE catálogo** (types/api/hook/MaterialsBody/tab).
9. **FE equipos** (editar/quitar en ServiceInventorySection + gate migration).
10. **FE consumo** (TaskMaterialConsumptions + hooks/api).
11. **FE F4** (ContractInventoryReadonly en CustomerSidebar + threading taskId).
12. Verificación cruzada de permisos (FE `<Can>` ↔ BE `requirePerm`).
