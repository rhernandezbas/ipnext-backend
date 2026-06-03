<!-- generated from engram topic_key: sdd/inventory-confirm-dedup-replace/design -->
## Design — inventory-confirm-dedup-replace

> Refinamiento de código en prod (`inventory-edit-and-match`). El match deja de ser un badge informativo y pasa a ser **acción**: el confirm frena duplicados (409), permite vincular a un ítem existente, y aparece un endpoint separado de **replace** que retira el ítem viejo y crea el nuevo enlazado. Hexagonal estricta, Strict TDD, 1 migración aditiva. BE primero, FE degrada.

### 0. Mapa de cambios (qué se toca y dónde)

| Capa | Archivo | Cambio |
|------|---------|--------|
| domain/entity | `src/domain/entities/contract-installed-item.ts:9` | + campo `replacesItemId: string \| null` |
| domain/error | `src/domain/errors/inventory.ts` | + `DuplicateInstalledItemError` (`DUPLICATE_INSTALLED_ITEM`) |
| application/service (NUEVO) | `src/application/services/matchInstalledItem.ts` | extrae `computeMatch` + normalización SN/MAC. Helper puro. |
| application/use-case | `src/application/use-cases/ListTaskInventorySuggestions.ts:14-56` | borra normalización + `computeMatch` locales, importa del helper. SIN cambio de comportamiento. |
| application/use-case | `src/application/use-cases/ConfirmInventorySuggestion.ts` | input gana `resolution`; rama DEVICE recalcula match y aplica la tabla; rechaza `replace`. |
| infra/http/route | `src/infrastructure/http/routes/contractInventory.routes.ts` | confirm acepta `resolution` add\|link_existing; NUEVA ruta `.../replace` gated `inventory.write`. |
| infra/http/wiring | `src/infrastructure/http/app.ts:1032-1057` | sin cambio de firma de DI (misma instancia de `confirm` cablea ambas rutas). |
| infra/adapter/prisma | `src/infrastructure/adapters/prisma/PrismaContractInventoryRepository.ts` | `create` y `toEntity` mapean `replacesItemId`; `update` ya soporta `status:'replaced'`. |
| infra/error map | `src/infrastructure/http/middleware/errorHandler.ts:36-44` | + `DUPLICATE_INSTALLED_ITEM: 409`. |
| prisma | `prisma/schema.prisma:796` + nueva migración | + columna `replacesItemId String?` self-relation opcional. |
| FE api | `ipnext-frontend/src/api/serviceInventory.api.ts` | `confirm` acepta `resolution`; + `replaceInventorySuggestion`. |
| FE hook | `ipnext-frontend/src/hooks/useServiceInventory.ts` | `useConfirmSuggestion` acepta `resolution`; + `useReplaceSuggestion`. |
| FE comp | `ipnext-frontend/src/pages/scheduling/SchedulingTaskDetailPage/components/SuggestionCard.tsx` | botones según `match`. |
| FE comp | `.../TaskInventorySuggestions.tsx:49-58` | cablea las nuevas acciones + contractId al replace. |

Direcciones de dependencia respetadas: el helper vive en `application/services/` (puro, sin infra), los use cases dependen del port `ContractInventoryRepository`, la ruta es el límite de validación/permisos. **No** se importa Prisma ni Express desde domain/application.

---

### 1. F1 — Matcher compartido (`matchInstalledItem.ts`)

**Problema**: la lógica de match vive HOY dentro de `ListTaskInventorySuggestions` (`ListTaskInventorySuggestions.ts:14-56`): `normSn`, `normMac`, `computeMatch`. El confirm necesita EXACTAMENTE la misma lógica para recalcular server-side. Duplicarla = drift garantizado. Hay que extraerla a un helper puro y que ambos lo consuman.

**Decisión**: nuevo módulo `src/application/services/matchInstalledItem.ts`, sin estado, sin dependencias de infra. Exporta las normalizaciones + la función de match.

```ts
// src/application/services/matchInstalledItem.ts
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { SuggestionMatch } from '@application/dto/TaskInventorySuggestionDto';

/** SN: trim + uppercase. '' → null. */
export const normSn = (v: string | null | undefined): string | null =>
  v == null ? null : v.trim().toUpperCase() || null;

/** MAC: trim + uppercase + strip ':' '-'. '' → null. */
export const normMac = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const s = v.trim().toUpperCase().replace(/[:\-]/g, '');
  return s || null;
};

/**
 * Resultado tipado del match: el status Y el ítem matcheado (no solo el id),
 * porque el confirm necesita la entidad para retirarla en replace.
 */
export interface MatchResult {
  status: 'same_device' | 'same_type' | null;
  item: ContractInstalledItem | null;
}

/**
 * Computa el match entre una sugerencia y los ítems instalados ACTIVOS del contrato.
 * Precedencia: same_device (SN o MAC coincide) > same_type (mismo tipo, identidad distinta).
 * Solo participan sugerencias DEVICE; MATERIAL siempre { status: null, item: null }.
 * El llamador es responsable de pasar SOLO ítems activos (status !== 'removed'/'replaced').
 */
export function matchInstalledItem(
  s: TaskInventorySuggestion,
  activeItems: ContractInstalledItem[],
): MatchResult {
  if (s.kind !== 'DEVICE') return { status: null, item: null };

  const sn = normSn(s.serialNumber);
  const mac = normMac(s.mac);
  const type = normSn(s.deviceType); // misma norm que SN: trim + upper

  const byIdentity = activeItems.find(
    (i) => (sn != null && normSn(i.serialNumber) === sn) ||
           (mac != null && normMac(i.mac) === mac),
  );
  if (byIdentity) return { status: 'same_device', item: byIdentity };

  const byType = type != null ? activeItems.find((i) => normSn(i.type) === type) : undefined;
  if (byType) return { status: 'same_type', item: byType };

  return { status: null, item: null };
}

/** Adaptador para el DTO de listado: mapea MatchResult → SuggestionMatch | null. */
export function toSuggestionMatch(r: MatchResult): SuggestionMatch | null {
  if (r.status == null || r.item == null) return null;
  return { status: r.status, itemId: r.item.id, serial: r.item.serialNumber };
}
```

**Por qué `MatchResult` devuelve `item` y no solo `itemId`** (a diferencia del `SuggestionMatch` actual que devuelve `{ itemId, serial }`): el confirm en `replace` necesita la entidad completa del ítem matcheado para retirarla (`update(item.id, { status:'replaced' })`) sin un round-trip extra a `getById`. El listado solo necesita `itemId`+`serial` para el badge, así que `toSuggestionMatch` reduce `MatchResult → SuggestionMatch`. El `SuggestionMatch` (DTO) **no cambia** → el wire format del listado queda idéntico → el FE no rompe.

**Refactor de `ListTaskInventorySuggestions`** (sin cambio de comportamiento):

```ts
// ListTaskInventorySuggestions.ts — borra normSn/normMac/computeMatch locales (líneas 12-56)
import { matchInstalledItem, toSuggestionMatch } from '@application/services/matchInstalledItem';
// ...
const items = (await this.inventory.listByContract(contractId))
  .filter((i) => i.status === 'active'); // ver nota "active-only" abajo
return list.map((s) => toTaskInventorySuggestionDto(s, toSuggestionMatch(matchInstalledItem(s, items))));
```

**Nota active-only**: el filtro actual en `ListTaskInventorySuggestions.ts:77` es `i.status !== 'removed'`. Esto incluye `'replaced'`. Con el nuevo flujo, un ítem `'replaced'` NO debe matchear (ya fue reemplazado, es historia). **Decisión**: cambiar ambos llamadores a `i.status === 'active'` (whitelist, no blacklist). Esto es técnicamente un cambio de comportamiento del listado, pero solo afecta a ítems en estado `'replaced'` que HOY no existen en prod (nadie reemplaza todavía) → en la práctica es no-op para los datos vivos, y es el comportamiento correcto. Se documenta como SCEN explícito y se cubre con test.

**Precedencia documentada** (la misma que hoy, ahora centralizada): `same_device` gana sobre `same_type`. Un equipo cuyo SN ya está instalado se reporta como `same_device` aunque también haya otro del mismo tipo. El primer ítem activo que matchea por identidad/tipo es el elegido (orden de `listByContract` = `createdAt asc` en Prisma).

---

### 2. F2 — `ConfirmInventorySuggestion` con `resolution`

**Input nuevo**:

```ts
export type SuggestionResolution = 'add' | 'replace' | 'link_existing';

export interface ConfirmInventorySuggestionInput {
  suggestionId: string;
  addedByUserId?: string | null;
  typeOverride?: string | null;
  resolution?: SuggestionResolution; // default 'add' — retrocompatible
}
```

`resolution` default `'add'` → todos los callers existentes (cierre operator-driven sin resolución, tests viejos que llaman `confirm.execute({ suggestionId })`) siguen funcionando idénticamente cuando no hay match. **Esto es lo que hace la migración del código segura: el path por defecto NO cambia salvo cuando hay match same_device.**

**Lógica de la rama DEVICE** (reemplaza `ConfirmInventorySuggestion.ts:61-90`). MATERIAL (`handleMaterial`) queda intacto.

```ts
// ── DEVICE branch ─────────────────────────────────────────────────────────
const resolution = input.resolution ?? 'add';

// El confirm NO ejecuta replace. replace es destructivo → endpoint separado, gate declarativo.
if (resolution === 'replace') {
  throw new ReplaceNotAllowedOnConfirmError(suggestion.id); // ver punto 4 (decisión)
}

const activeItems = (await this.inventory.listByContract(contractId))
  .filter((i) => i.status === 'active');
const match = matchInstalledItem(suggestion, activeItems);

// same_device: identidad física ya instalada
if (match.status === 'same_device') {
  if (resolution === 'add') {
    // BLOQUEA: no se crea un duplicado físico.
    throw new DuplicateInstalledItemError(suggestion.id, match.item!.id);
  }
  // resolution === 'link_existing': vincula sin crear, devuelve el ítem existente.
  await this.suggestions.setStatus(suggestion.id, 'confirmed', match.item!.id);
  const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
  return { kind: 'DEVICE', item: toInstalledItemDto(match.item!, user?.name ?? null) };
}

// same_type con resolution 'link_existing' no tiene sentido (no es el mismo equipo):
// tratamos link_existing como add cuando NO es same_device → o lo rechazamos.
// Decisión: link_existing solo es válido sobre same_device (ver "open decisions").
if (resolution === 'link_existing') {
  throw new LinkRequiresSameDeviceError(suggestion.id); // o degradar a add — ver decisión
}

// resolution === 'add' con same_type o sin match → crea (comportamiento actual, intacto)
const valid = new Set(await this.catalog.listActiveNames());
const toType = (t: string | null): string => (t && valid.has(t.toUpperCase()) ? t.toUpperCase() : 'OTROS');
const effectiveType = toType(input.typeOverride ?? suggestion.deviceType);
const item = await this.inventory.create({
  id: randomUUID(), contractId, type: effectiveType,
  serialNumber: suggestion.serialNumber, mac: suggestion.mac, model: null,
  source: suggestion.source === 'OCR' ? 'OCR' : 'ICLASS',
  sourceTaskId: suggestion.taskId, addedByUserId: input.addedByUserId ?? null,
  confirmedAt: now, status: 'active', notes: null,
  replacesItemId: null, // ← add nunca reemplaza
  createdAt: now, updatedAt: now,
});
const persistedType = input.typeOverride != null ? effectiveType : undefined;
await this.suggestions.setStatus(suggestion.id, 'confirmed', item.id, persistedType);
const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
return { kind: 'DEVICE', item: toInstalledItemDto(item, user?.name ?? null) };
```

**`replace` como método dedicado del MISMO use case** (invocado por la ruta `.../replace`). Mantener un único use case (no crear `ReplaceInventorySuggestion`) porque comparte el 90% de la maquinaria (resolución de contrato, catálogo, setStatus, DTO). El gate de permiso vive en la ruta, no acá.

```ts
async replace(input: { suggestionId: string; addedByUserId?: string | null; typeOverride?: string | null }): Promise<ConfirmResult> {
  const suggestion = await this.suggestions.get(input.suggestionId);
  if (!suggestion) throw new SuggestionNotFoundError(input.suggestionId);
  if (suggestion.status === 'confirmed') throw new SuggestionAlreadyConfirmedError(input.suggestionId);
  if (suggestion.kind !== 'DEVICE') throw new NotADeviceError(input.suggestionId);

  const task = await this.scheduling.getTask(suggestion.taskId);
  const contractId = task?.contractId ?? null;
  if (!contractId) throw new TaskHasNoContractError(suggestion.taskId);

  const activeItems = (await this.inventory.listByContract(contractId)).filter((i) => i.status === 'active');
  const match = matchInstalledItem(suggestion, activeItems);

  // replace exige un same_type al cual reemplazar (no same_device — ese se bloquea/linkea).
  if (match.status !== 'same_type') throw new NoReplaceTargetError(input.suggestionId);

  const now = new Date().toISOString();
  // 1) retira el viejo
  await this.inventory.update(match.item!.id, { status: 'replaced' });
  // 2) crea el nuevo, apuntando al que retiró
  const valid = new Set(await this.catalog.listActiveNames());
  const toType = (t: string | null): string => (t && valid.has(t.toUpperCase()) ? t.toUpperCase() : 'OTROS');
  const effectiveType = toType(input.typeOverride ?? suggestion.deviceType);
  const item = await this.inventory.create({
    id: randomUUID(), contractId, type: effectiveType,
    serialNumber: suggestion.serialNumber, mac: suggestion.mac, model: null,
    source: suggestion.source === 'OCR' ? 'OCR' : 'ICLASS',
    sourceTaskId: suggestion.taskId, addedByUserId: input.addedByUserId ?? null,
    confirmedAt: now, status: 'active', notes: null,
    replacesItemId: match.item!.id, // ← link al retirado
    createdAt: now, updatedAt: now,
  });
  const persistedType = input.typeOverride != null ? effectiveType : undefined;
  await this.suggestions.setStatus(suggestion.id, 'confirmed', item.id, persistedType);
  const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
  return { kind: 'DEVICE', item: toInstalledItemDto(item, user?.name ?? null) };
}
```

**Atomicidad (retire + create)**: el port `ContractInventoryRepository` es de dos métodos (`update` + `create`), no expone transacción. Orden elegido: **retirar primero, crear después**. Si el `create` falla, queda un ítem `'replaced'` sin reemplazo activo — estado recuperable (el operador re-confirma y crea, o un futuro "deshacer reemplazo" lo revierte) y NUNCA un duplicado activo. El orden inverso (crear primero) dejaría dos activos si el update falla — peor. No se introduce `transaction` en el port en esta iteración (alcance mínimo); se documenta como deuda. El Prisma adapter podría envolver ambas ops en `prisma.$transaction` en una mejora futura sin tocar el use case.

**Errores nuevos** (`src/domain/errors/inventory.ts`):

```ts
export class DuplicateInstalledItemError extends DomainError {
  constructor(suggestionId: string, public readonly existingItemId: string) {
    super(`Suggestion ${suggestionId} matches an already-installed device (${existingItemId})`, 'DUPLICATE_INSTALLED_ITEM');
    this.name = 'DuplicateInstalledItemError';
  }
}
export class NoReplaceTargetError extends DomainError {
  constructor(suggestionId: string) {
    super(`Suggestion ${suggestionId} has no same-type active item to replace`, 'NO_REPLACE_TARGET');
    this.name = 'NoReplaceTargetError';
  }
}
```

`ReplaceNotAllowedOnConfirmError` / `LinkRequiresSameDeviceError` → ver decisiones en punto 7 (puede que no hagan falta si la ruta no permite enviar `resolution=replace` al confirm). Recomendación: **el confirm NO declara `replace` en su schema de body** → no necesita lanzar `ReplaceNotAllowedOnConfirmError` (la validación zod lo corta antes con 400). Mantener el guard interno igual como defensa en profundidad es opcional.

---

### 3. F3 — Migración: `replacesItemId`

**Schema** (`prisma/schema.prisma:796`). Decisión: **self-relation nullable** (no columna plana suelta). Razón: integridad referencial (un `replacesItemId` siempre apunta a un `ContractInstalledItem` real del mismo contrato), y habilita queries de historial ("¿qué reemplazó a X?") sin joins manuales. Costo: una self-relation en Prisma exige declarar ambos lados.

```prisma
model ContractInstalledItem {
  id            String    @id @default(uuid())
  contractId    String
  contract      Contract  @relation(fields: [contractId], references: [id], onDelete: Cascade)
  type          String
  serialNumber  String?
  mac           String?
  model         String?
  source        String
  sourceTaskId  String?
  addedByUserId String?
  confirmedAt   DateTime?
  status        String    @default("active") // active | removed | replaced

  // ── NUEVO: link al ítem que este reemplazó ──
  replacesItemId String?
  replaces       ContractInstalledItem?  @relation("ItemReplacement", fields: [replacesItemId], references: [id], onDelete: SetNull)
  replacedBy     ContractInstalledItem[] @relation("ItemReplacement")

  notes     String?  @db.Text
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([contractId])
  @@index([serialNumber])
  @@index([replacesItemId])
}
```

`onDelete: SetNull` — si el ítem viejo se borrara duro (no pasa hoy, los retiros son soft), el nuevo no queda colgado. Como los retiros son soft (`status='replaced'`), la FK casi nunca se rompe.

**Generación de la migración** (regla del proyecto: jamás SQL a mano para el schema; usar Prisma). Nombre/timestamp: el último directorio es `20260604100000_add_inventory_write_permission`, así que la nueva debe ser **mayor**: `20260604110000_add_installed_item_replaces`.

```bash
npm run prisma:migrate -- --name add_installed_item_replaces
```

Esto genera SQL aditivo: `ALTER TABLE "ContractInstalledItem" ADD COLUMN "replacesItemId" TEXT;` + el índice + la FK self. Es **aditivo y nullable** → seguro sobre datos en prod, sin backfill. (Si se prefiere control del nombre exacto sin tocar la DB local, `prisma migrate diff --from-schema-datamodel ... --to-schema-datamodel prisma/schema.prisma --script` y guardar el SQL en el directorio con ese timestamp — pero la vía estándar del proyecto es `prisma:migrate`.)

**Adapter Prisma** (`PrismaContractInventoryRepository.ts`): agregar `replacesItemId` al `Row` type (línea 5-9), al `toEntity` (línea 11-20), y al `create.data` (línea 35-41). El `update` (línea 46-60) NO necesita aceptar `replacesItemId` en el patch (solo se setea al crear). El soft-retire vía `update(id, { status:'replaced' })` ya está soportado (línea 52).

**Entity** (`contract-installed-item.ts:9`): + `replacesItemId: string | null;`. **In-memory adapter** ya hace spread genérico (`{ ...item }` en create, `{ ...existing, ...patch }` en update) → no requiere cambios. **DTO** `InstalledItemDto` extiende la entidad → arrastra `replacesItemId` automáticamente al wire.

---

### 4. F4 — Rutas + permisos

**Decisión: endpoint SEPARADO para replace** (recomendado por el proposal, confirmado acá).

| Acción | Endpoint | Guard | Body |
|--------|----------|-------|------|
| add / link_existing | `POST /scheduling/:taskId/inventory/suggestions/:suggestionId/confirm` | `perms.taskWrite` (`scheduling.write`) | `{ type?, resolution?: 'add'\|'link_existing' }` |
| replace | `POST /scheduling/:taskId/inventory/suggestions/:suggestionId/replace` | **`perms.contractWrite`** (`inventory.write`) | `{ type? }` |

**Por qué separado y no check in-handler**: el patrón de TODO el router es guard declarativo por middleware (`auth, perms.X`). Un `replace` es destructivo (retira un ítem del contrato) → debe vivir bajo `inventory.write`, igual que el resto de las mutaciones de inventario del contrato (`POST/PATCH/DELETE /contracts/:id/inventory` ya usan `contractWrite`). Meter un `if (perm)` dentro del handler de confirm rompería la uniformidad y haría el gate invisible para una auditoría del router. Con ruta separada, leer el router te dice exactamente qué permiso protege qué.

**Confirm** — acepta `resolution` add|link_existing, rechaza replace por schema (zod), no por excepción:

```ts
const ConfirmSchema = z.object({
  type: z.string().optional(),
  resolution: z.enum(['add', 'link_existing']).optional(), // 'replace' NO está → 400 si lo mandan
});

router.post('/scheduling/:taskId/inventory/suggestions/:suggestionId/confirm', auth, perms.taskWrite, async (req, res, next) => {
  try {
    const parsed = ConfirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues }); return; }
    const rawType = parsed.data.type;
    if (rawType !== undefined && !(await deviceTypes.isValid(rawType))) {
      res.status(422).json({ error: 'Invalid item type override', code: 'INVALID_ITEM_TYPE' }); return;
    }
    const result = await confirm.execute({
      suggestionId: req.params.suggestionId,
      addedByUserId: userId(req),
      typeOverride: rawType ?? null,
      resolution: parsed.data.resolution ?? 'add',
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});
```

`DuplicateInstalledItemError` (same_device + add) NO se captura in-handler: viaja al `next(e)` → `errorHandler` lo mapea a 409 vía `DUPLICATE_INSTALLED_ITEM` en el `statusMap` (`errorHandler.ts:36`). Mismo patrón que `SUGGESTION_ALREADY_CONFIRMED`. **link_existing** devuelve 201 con el ítem existente (DTO).

**Replace** — nueva ruta, gate `inventory.write`:

```ts
const ReplaceSchema = z.object({ type: z.string().optional() });

router.post('/scheduling/:taskId/inventory/suggestions/:suggestionId/replace', auth, perms.contractWrite, async (req, res, next) => {
  try {
    const parsed = ReplaceSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues }); return; }
    const rawType = parsed.data.type;
    if (rawType !== undefined && !(await deviceTypes.isValid(rawType))) {
      res.status(422).json({ error: 'Invalid item type override', code: 'INVALID_ITEM_TYPE' }); return;
    }
    const result = await confirm.replace({
      suggestionId: req.params.suggestionId,
      addedByUserId: userId(req),
      typeOverride: rawType ?? null,
    });
    res.status(201).json(result);
  } catch (e) { next(e); } // NoReplaceTargetError → 409, etc.
});
```

**Permiso para replace**: reutilizamos `perms.contractWrite` (`inventory.write`) — la interfaz `InventoryRoutePerms` (`contractInventory.routes.ts:33-40`) YA tiene ese handler cableado en `app.ts:1052`. **No hace falta agregar nada al wiring ni a la interfaz** — `replace` cuelga del mismo `inventory.write` que ya existe. (Alternativa: agregar un campo `replace: RequestHandler` a la interfaz si en el futuro se quisiera un permiso distinto; hoy no se justifica.)

**DI en `app.ts`**: la misma instancia de `ConfirmInventorySuggestion` (`app.ts:1034-1037`) sirve ambas rutas — `confirm.execute()` y `confirm.replace()`. **Cero cambios en la firma de `createContractInventoryRouter`** (la instancia `confirm` ya se pasa). Lo único que cambia en app.ts es nada estructural — la ruta nueva se añade dentro del router usando el `confirm` y `perms.contractWrite` ya disponibles.

**`errorHandler.ts`** — agregar al `statusMap`:
```ts
DUPLICATE_INSTALLED_ITEM: 409,
NO_REPLACE_TARGET: 409,
```

---

### 5. F5 — FE: botones según el match

**Tipos** (`types/serviceInventory.ts`): `resolution` en la llamada de confirm; `match.status` ya existe (`'same_device' | 'same_type'`, opcional para degradar — `serviceInventory.ts:75`).

**api** (`serviceInventory.api.ts`):
```ts
export const confirmInventorySuggestion = (
  taskId: string, suggestionId: string,
  opts?: { type?: InstalledItemType; resolution?: 'add' | 'link_existing' },
) => axiosClient.post<ConfirmSuggestionResult>(
  `/scheduling/${taskId}/inventory/suggestions/${suggestionId}/confirm`,
  { ...(opts?.type ? { type: opts.type } : {}), ...(opts?.resolution ? { resolution: opts.resolution } : {}) },
).then(r => r.data);

export const replaceInventorySuggestion = (
  taskId: string, suggestionId: string, type?: InstalledItemType,
) => axiosClient.post<ConfirmSuggestionResult>(
  `/scheduling/${taskId}/inventory/suggestions/${suggestionId}/replace`,
  type ? { type } : {},
).then(r => r.data);
```

**hooks** (`useServiceInventory.ts`): `useConfirmSuggestion` gana `resolution` opcional en su `mutationFn`; nuevo `useReplaceSuggestion`. Ambos invalidan `suggestionsKey(taskId)` + `itemsKey(contractId)` (inventario del contrato) — el replace SÍ cambia el inventario (retira+crea), el link_existing no crea pero igual conviene refrescar.

```ts
export function useConfirmSuggestion(taskId: string, contractId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ suggestionId, type, resolution }: { suggestionId: string; type?: InstalledItemType; resolution?: 'add' | 'link_existing' }) =>
      api.confirmInventorySuggestion(taskId, suggestionId, { type, resolution }),
    onSuccess: (result) => { /* misma invalidación actual (suggestions + items/contract) */ },
  });
}

export function useReplaceSuggestion(taskId: string, contractId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ suggestionId, type }: { suggestionId: string; type?: InstalledItemType }) =>
      api.replaceInventorySuggestion(taskId, suggestionId, type),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: suggestionsKey(taskId) });
      if (contractId) void qc.invalidateQueries({ queryKey: itemsKey(contractId) });
      else void qc.invalidateQueries({ queryKey: ['service-inventory'] });
    },
  });
}
```

**`SuggestionCard.tsx`** — la zona de acciones (hoy `SuggestionCard.tsx:222-231`, el bloque `canWrite ? <div.actions>`) pasa a depender de `s.match?.status` en la variante pending DEVICE. Nuevas props: `onLinkExisting(id)`, `onReplace(id, type)` (además del `onConfirm(id, type)` existente que ahora significa "add").

| `match.status` | Botones (pending DEVICE) |
|----------------|--------------------------|
| `'same_device'` | **"Marcar como ya instalado"** → `onLinkExisting(s.id)` (confirm `link_existing`) + **Descartar**. NO se muestra "Confirmar" (duplicaría). |
| `'same_type'` | **"Agregar"** → `onConfirm(s.id, type)` (add) + **"Reemplazar la actual"** envuelto en `<Can permission="inventory.write">` → `onReplace(s.id, type)` + **Descartar**. |
| `undefined`/null (sin match) | **"Confirmar"** → `onConfirm(s.id, type)` (add) + **Descartar** (igual que hoy). |

```tsx
// dentro de la rama pending (resolved === false), DEVICE:
const matchStatus = isDevice ? s.match?.status : undefined;
// ...
) : canWrite ? (
  <div className={styles.actions}>
    {matchStatus === 'same_device' ? (
      <button type="button" className={styles.confirmBtn} disabled={isPending}
        onClick={() => onLinkExisting?.(s.id)}>
        Marcar como ya instalado
      </button>
    ) : matchStatus === 'same_type' ? (
      <>
        <button type="button" className={styles.confirmBtn} disabled={isPending}
          onClick={() => onConfirm(s.id, type)}>Agregar</button>
        <Can permission="inventory.write">
          <button type="button" className={styles.confirmBtn} disabled={isPending}
            onClick={() => onReplace?.(s.id, type)}>Reemplazar la actual</button>
        </Can>
      </>
    ) : (
      <button type="button" className={styles.confirmBtn} disabled={isPending}
        onClick={() => onConfirm(s.id, type)}>Confirmar</button>
    )}
    <button type="button" className={styles.discardBtn} disabled={isPending}
      onClick={() => onDiscard(s.id)}>Descartar</button>
  </div>
) : null
```

**Degradación graceful**: si el BE viejo no manda `match` (campo opcional), `matchStatus` es `undefined` → cae en el branch "Confirmar" normal (= comportamiento actual). El FE no rompe si se deploya antes que el BE. El badge de `inventory.write` usa el `<Can>` ya existente (`Can.tsx`) — si el usuario no tiene el permiso, no ve "Reemplazar" (y aunque lo viera, el BE devuelve 403).

**`TaskInventorySuggestions.tsx`** (`:49-58`): cablear las nuevas acciones en el `.map(pending)`:
```tsx
onConfirm={(id, type) => confirm.mutate({ suggestionId: id, type, resolution: 'add' })}
onLinkExisting={(id) => confirm.mutate({ suggestionId: id, resolution: 'link_existing' })}
onReplace={(id, type) => replace.mutate({ suggestionId: id, type })}
onDiscard={id => discard.mutate(id)}
```
donde `const replace = useReplaceSuggestion(taskId, contractId);`. `isPending` pasa a `confirm.isPending || discard.isPending || replace.isPending`.

---

### 6. Testing strategy (Strict TDD: red → green → refactor)

Orden de ataque: helper → confirm use case → ruta → FE. Cada bloque empieza por el test que falla.

**6.1 `matchInstalledItem` (unit, puro)** — `src/__tests__/application/matchInstalledItem.test.ts` (NUEVO):
- normSn: `' r1 '` → `'R1'`; `''`/`null` → `null`.
- normMac: `'aa:bb-cc'` → `'AABBCC'`; `''` → `null`.
- MATERIAL → `{ status:null, item:null }`.
- same_device por SN; por MAC; precedencia same_device > same_type (sembrar uno que matchea por SN y otro por tipo → debe ganar SN).
- same_type cuando SN distinto pero tipo igual.
- sin match → null.
- active-only: un ítem `'replaced'` o `'removed'` NO matchea (el helper recibe ya filtrado, pero se testea que el llamador filtra — cubierto también en List).
- `toSuggestionMatch`: `{status:null}` → null; con item → `{status, itemId, serial}`.

**6.2 `ListTaskInventorySuggestions` (unit, InMemory)** — extender el test existente: verificar que el refactor NO cambia el wire (mismos `match` que antes) y que `'replaced'` deja de matchear (SCEN nuevo del filtro `=== 'active'`).

**6.3 `ConfirmInventorySuggestion` (unit, InMemory)** — extender `src/__tests__/application/ServiceInventory.test.ts`. Matriz resolution × match:

| caso | seed | acción | assert |
|------|------|--------|--------|
| same_device + add | ítem activo SN=R1; sug SN=R1 | `execute({resolution:'add'})` | rejects `DUPLICATE_INSTALLED_ITEM`; **inventory sigue con 1 ítem** |
| same_device + link_existing | idem | `execute({resolution:'link_existing'})` | NO crea (inventory=1); `setStatus(confirmed, existing.id)`; devuelve el ítem existente |
| same_type + add | ítem ROUTER SN=R1; sug ROUTER SN=R2 | `execute({resolution:'add'})` | crea 2º ítem activo; ambos coexisten; `replacesItemId=null` |
| same_type + replace | idem | `replace(...)` | viejo → `status:'replaced'`; nuevo `active` con `replacesItemId=viejo.id`; suggestion confirmed→nuevo.id |
| sin match + add | inventory vacío | `execute({})` | crea (comportamiento actual) |
| sin match (default, sin resolution) | vacío | `execute({suggestionId})` | crea (retrocompat: tests viejos pasan sin tocar) |
| replace sin same_type | inventory vacío o solo same_device | `replace(...)` | rejects `NO_REPLACE_TARGET` |
| typeOverride en replace | — | `replace({typeOverride:'ANTENA'})` | nuevo ítem type=ANTENA, suggestion deviceType persistido |
| MATERIAL | sug MATERIAL | `execute({})` | inalterado (consumption) |

**6.4 Rutas (supertest)** — extender `src/__tests__/infrastructure/serviceInventory.routes.test.ts`. Como `buildApp()` usa `pass` para todos los perms, agregar un helper que permita inyectar `deny` selectivamente (para el test de 403 del replace):
- `POST .../confirm` resolution add → 201, crea.
- `POST .../confirm` resolution link_existing sobre same_device → 201, devuelve ítem existente, no crea.
- `POST .../confirm` sobre same_device con add (o default) → **409 `DUPLICATE_INSTALLED_ITEM`**.
- `POST .../confirm` con `resolution:'replace'` en body → **400 VALIDATION_ERROR** (zod lo rechaza).
- `POST .../replace` con `contractWrite=deny` → **403** (gate declarativo). Construir app con `{ ...pass, contractWrite: deny }`.
- `POST .../replace` con `contractWrite=pass` sobre same_type → **201**, viejo replaced, nuevo con replacesItemId.
- `POST .../replace` sin same_type → **409 `NO_REPLACE_TARGET`**.

**6.5 FE (vitest)** — extender `SuggestionCard.test.tsx` + `useServiceInventory` tests:
- pending same_device → render "Marcar como ya instalado" + Descartar; **NO** "Confirmar". Click → `onLinkExisting(id)`.
- pending same_type → "Agregar" + "Reemplazar la actual" (con `inventory.write`) + Descartar. Click Agregar → `onConfirm`; click Reemplazar → `onReplace`.
- pending same_type SIN `inventory.write` (mock `useMyPermissions` → can=false para inventory.write) → "Reemplazar la actual" NO se renderiza; "Agregar" sí.
- pending sin match (match undefined) → "Confirmar" normal (degradación).
- hooks: `useConfirmSuggestion` con resolution invalida suggestions+items; `useReplaceSuggestion` invalida suggestions+items.

---

### 7. Open decisions (con rationale)

1. **Ruta separada vs check in-handler para replace** → **SEPARADA** (`POST .../replace`, gate `inventory.write`). Rationale: uniformidad con el patrón declarativo del router; gate auditable leyendo el router; replace es destructivo y semánticamente distinto de confirm. Descartado el in-handler porque esconde el permiso y rompe el patrón.

2. **`replacesItemId`: columna plana vs self-relation** → **SELF-RELATION nullable** (`@relation("ItemReplacement")`, `onDelete: SetNull`). Rationale: integridad referencial + historial consultable. Costo: declarar ambos lados (`replaces`/`replacedBy`). El proposal aceptaba el mínimo (columna plana); elegimos la self-relation porque el costo extra es trivial (Prisma lo maneja) y la integridad vale. Si el reviewer prefiere mínimo absoluto, degradar a `replacesItemId String?` sin relación es un cambio de una línea en el schema.

3. **Qué devuelve `link_existing`** → el **DTO del ítem existente** (`{ kind:'DEVICE', item: <existente> }`, 201). Rationale: el FE espera un `ConfirmSuggestionResult`; devolver el ítem ya instalado es coherente y permite que la UI muestre "confirmado → este ítem" sin un caso especial. No se crea nada; `setStatus(confirmed, existing.id)` limpia la sugerencia.

4. **`link_existing` sobre same_type o sin match** → **rechazar** (`LinkRequiresSameDeviceError` o, más simple, el FE solo ofrece "Marcar como ya instalado" en same_device, así que el caso no debería llegar). Decisión pragmática: el FE nunca emite `link_existing` salvo en same_device; el BE valida defensivamente. Alternativa (degradar a add) descartada: sería confuso (el operador pidió "vincular" y obtendría una creación).

5. **`resolution=replace` enviado al confirm** → **400 por zod** (el enum del confirm solo acepta `add|link_existing`). No se lanza excepción de dominio; la validación de borde lo corta. Más limpio que un error de dominio para un input que el FE nunca debería mandar.

6. **Múltiples ítems same_type** → v1 reemplaza **el primero activo del tipo** (el que devuelve `matchInstalledItem`, orden `createdAt asc`). Elegir cuál entre varios = fuera de alcance (proposal). Documentado como limitación conocida.

7. **Atomicidad replace** → secuencial (retire→create), sin transacción en el port. Rationale: el port no expone tx; el orden elegido nunca produce duplicado activo. Deuda documentada: el Prisma adapter podría envolver en `$transaction` a futuro sin tocar el use case.

8. **Filtro `=== 'active'` vs `!== 'removed'`** → cambiar a whitelist `=== 'active'` en ambos llamadores. Excluye `'replaced'` del match (correcto: un ítem reemplazado es historia, no debe matchear). No-op sobre datos vivos actuales (nadie tiene `'replaced'` todavía).

### Orden de deploy
BE (migración aditiva + rutas) → FE. El FE degrada sin los botones nuevos si llega antes (campo `match` opcional, branch "Confirmar"). El 409 de same_device es seguro porque el confirm es SIEMPRE operator-driven (el cron de cierre solo crea sugerencias `pending`, nunca auto-confirma — verificado en #8).
