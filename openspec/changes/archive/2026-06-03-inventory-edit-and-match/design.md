<!-- generated from engram topic_key: sdd/inventory-edit-and-match/design -->
## Design — inventory-edit-and-match

> Refinamiento del #8 (`service-inventory-management`, ya en prod). Multi-repo (BE hexagonal + FE React). Strict TDD. Aditivo: sin migración de schema. Surge del caso real de la tarea 4691 (ONU confirmado que era ANTENA).

Este documento traduce el `proposal.md` a decisiones técnicas concretas con `path:line`. Cubre dos features independientes que comparten superficie:

- **F1** — Editar el tipo de un equipo ya confirmado (admin) sincronizando los DOS registros (sugerencia + ítem del contrato).
- **F2** — Enriquecer el listado de sugerencias con un `match` derivado contra el inventario activo del contrato.

---

## Contexto del código actual (lo que ya existe)

- `src/application/use-cases/ConfirmInventorySuggestion.ts:88` — al confirmar con override, persiste el tipo elegido en la sugerencia vía `this.suggestions.setStatus(suggestion.id, 'confirmed', item.id, persistedType)`. El `confirmedItemId` queda apuntando al `ContractInstalledItem` creado (DEVICE) o al `TaskMaterialConsumption` (MATERIAL).
- `src/application/use-cases/ListTaskInventorySuggestions.ts:8` — hoy es un passthrough puro: `return this.suggestions.listByTask(taskId)`. Devuelve entidades de dominio crudas (la route las serializa tal cual en `contractInventory.routes.ts:72`).
- `src/domain/entities/task-inventory-suggestion.ts:9` — `TaskInventorySuggestion` tiene `deviceType`, `serialNumber`, `mac`, `kind`, `status`, `confirmedItemId`.
- `src/domain/ports/InventorySuggestionRepository.ts:11` — `setStatus(id, status, confirmedItemId?, deviceType?)` ya acepta un `deviceType` opcional que el in-memory aplica con `deviceType ?? s.deviceType` (`InMemoryInventorySuggestionRepository.ts:57`).
- `src/domain/ports/ContractInventoryRepository.ts:7` — `update(id, patch: Partial<ContractInstalledItem>)` y `getById(id)`. El in-memory (`InMemoryContractInventoryRepository.ts:21`) hace merge y refresca `updatedAt`.
- `src/domain/ports/SchedulingRepository.ts:33` — `getTask(id)` devuelve `ScheduledTask | null` con `.contractId` (igual que usa `ConfirmInventorySuggestion.ts:51-52`).
- `src/infrastructure/http/routes/contractInventory.routes.ts` — el router de toda la superficie. Patrón de validación de tipo: `deviceTypes.isValid(...)` → `422 INVALID_ITEM_TYPE` en la route (líneas 79, 158, 180). El `DeviceTypeCatalogService.isValid` (`services/DeviceTypeCatalogService.ts:14`) normaliza a UPPERCASE y cachea.
- `src/infrastructure/http/app.ts:1028-1053` — DI del router. `InventoryRoutePerms` se arma con `requirePerm(module, action)`. Hoy: `contractRead/contractWrite → inventory.read/write`, `taskRead/taskWrite → scheduling.read/write`.
- FE `SuggestionCard.tsx:68-70` — variante resuelta muestra el tipo como texto estático (`<span>{s.deviceType ?? FALLBACK_TYPE}</span>`).
- FE `useServiceInventory.ts` — `itemsKey(serviceId) = ['service-inventory', serviceId]`; `suggestionsKey(taskId) = ['task-inventory-suggestions', taskId]`. `useConfirmSuggestion` ya invalida ambas.
- FE `Can.tsx:34` (`<Can permission="...">`) y `useMyPermissions.ts` (`can('inventory.manage')`) — el gating granular ya está disponible.

---

## F1 — Corregir el tipo de un equipo confirmado, sincronizado

### AD-1. Use-case nuevo: `CorrectConfirmedDeviceType`

**Decisión**: caso de uso nuevo (un archivo, un caso), NO ampliar `ConfirmInventorySuggestion`. Confirmar y corregir son acciones distintas (permiso distinto: `scheduling.write` vs `inventory.manage`; precondición distinta: pending vs confirmed). Mezclarlas viola SRP.

**Ubicación**: `src/application/use-cases/CorrectConfirmedDeviceType.ts`

**Firma**:
```ts
export interface CorrectConfirmedDeviceTypeInput {
  suggestionId: string;
  newType: string; // ya validado contra el catálogo en la route → UPPERCASE canónico
}

export class CorrectConfirmedDeviceType {
  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly inventory: ContractInventoryRepository,
  ) {}

  async execute(input: CorrectConfirmedDeviceTypeInput): Promise<InstalledItemDto> { ... }
}
```

**Deps**: solo `InventorySuggestionRepository` + `ContractInventoryRepository`. NO necesita `SchedulingRepository` (el contrato ya está resuelto: el ítem se localiza por `suggestion.confirmedItemId`, no por taskId→contractId). NO necesita `RbacUserRepository` (el DTO de salida no resuelve aprobador acá — ver AD-3).

**Flujo (guardas en orden, fail-fast)**:
1. `const s = await this.suggestions.get(input.suggestionId)` → si `null` → `throw new SuggestionNotFoundError(id)` (reusa el error existente, `errors/inventory.ts:3`).
2. Si `s.kind !== 'DEVICE'` → `throw new NotADeviceError(id)` (error nuevo, ver AD-4). Corregir tipo solo aplica a equipos físicos; los materiales no tienen "tipo de equipo".
3. Si `s.status !== 'confirmed'` → `throw new SuggestionNotConfirmedError(id)` (error nuevo). No se corrige el tipo de algo que todavía está pending (eso es el flujo de confirm) ni descartado.
4. Si `s.confirmedItemId == null` → `throw new SuggestionNotConfirmedError(id)` (defensivo: una sugerencia confirmed DEVICE siempre debería tener `confirmedItemId`, pero si por dato sucio no lo tiene, no hay ítem que sincronizar). Reusar el mismo error es suficiente (mismo significado de cara al usuario: "no hay un ítem confirmado que corregir").
5. Sincronizar AMBOS registros:
   - `const item = await this.inventory.update(s.confirmedItemId, { type: input.newType })` → si `null` → `throw new InstalledItemNotFoundError(s.confirmedItemId)` (reusa `errors/inventory.ts:80`). El ítem fue borrado/replaced fuera de banda.
   - `await this.suggestions.setStatus(s.id, 'confirmed', s.confirmedItemId, input.newType)` → reaprovecha el param `deviceType` de `setStatus` para escribir el tipo en la sugerencia, conservando status y confirmedItemId.
6. `return toInstalledItemDto(item, null)` (ver AD-3).

> **Nota MATERIAL**: para una sugerencia MATERIAL, `confirmedItemId` apunta a un `TaskMaterialConsumption`, NO a un `ContractInstalledItem`. La guarda del paso 2 (`kind !== 'DEVICE'`) corta antes de tocar `inventory.update`, así que nunca se intenta updatear un consumo como si fuera un ítem. Esto resuelve la decisión abierta "qué pasa si confirmedItemId apunta a un MATERIAL": F1 solo aplica a DEVICE, garantizado por la guarda.

### AD-2. Reusar `setStatus` vs nuevo método de repo

**Decisión**: REUSAR `InventorySuggestionRepository.setStatus(id, 'confirmed', confirmedItemId, deviceType)`. NO agregar `updateDeviceType`.

**Rationale**:
- `setStatus` YA acepta `deviceType?` con la semántica exacta que necesitamos ("persistir el tipo elegido en la sugerencia") — ver el JSDoc del port (`InventorySuggestionRepository.ts:14-17`) y el uso real en `ConfirmInventorySuggestion.ts:88`. El in-memory ya lo aplica (`InMemoryInventorySuggestionRepository.ts:57`) y el Prisma también (es el mismo path que confirm con override, ya en prod).
- Pasamos `status='confirmed'` y el `confirmedItemId` actual (no lo cambiamos) → no muta nada salvo `deviceType`. Es idempotente respecto del estado.
- Agregar `updateDeviceType` obligaría a tocar el port + 2 adapters (Prisma + in-memory) + el Prisma repo en prod, sin ganancia semántica. El costo no se justifica.

**Contra-argumento considerado y descartado**: "reusar setStatus para un cambio que no es de status es confuso". Mitigado porque el método YA documenta y ejercita ese uso. Si en el futuro hubiera más operaciones de edición sobre la sugerencia, ahí sí conviene un método dedicado; hoy es YAGNI.

### AD-3. Forma de retorno: `InstalledItemDto`

**Decisión**: devolver el `InstalledItemDto` del ítem actualizado (no la sugerencia).

**Rationale**: el FE, tras corregir, invalida `['service-inventory', contractId]` y `['task-inventory-suggestions', taskId]` (refetch). El valor de retorno es para feedback inmediato/optimista; el ítem del contrato es lo más útil (es lo que se ve en el sidebar). `addedByUserName` se devuelve `null` — esta corrección no cambia el aprobador y resolverlo requeriría inyectar `RbacUserRepository` sin beneficio (el refetch de `['service-inventory']` trae el nombre real resuelto por `ListContractInstalledItems`). El FE NO debe depender de `addedByUserName` en esta respuesta.

### AD-4. Errores nuevos

En `src/domain/errors/inventory.ts`, siguiendo el patrón `DomainError` existente:

```ts
export class SuggestionNotConfirmedError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} is not confirmed`, 'SUGGESTION_NOT_CONFIRMED');
    this.name = 'SuggestionNotConfirmedError';
  }
}

export class NotADeviceError extends DomainError {
  constructor(id: string) {
    super(`Inventory suggestion ${id} is not a DEVICE`, 'SUGGESTION_NOT_A_DEVICE');
    this.name = 'NotADeviceError';
  }
}
```

`SuggestionNotFoundError` e `InstalledItemNotFoundError` ya existen y se reusan.

### AD-5. Route nueva

**Endpoint**: `PATCH /scheduling/:taskId/inventory/suggestions/:suggestionId/type`
**Body**: `{ type: string }`
**Guard**: `auth` + `perms.manage` (nuevo handler en `InventoryRoutePerms`, mapeado a `requirePerm('inventory', 'manage')`).

**Decisión de path**: bajo `/scheduling/:taskId/...` (consistente con confirm/discard, aunque el use-case no use el taskId). El `:taskId` queda como contexto de URL; el use-case opera por `suggestionId`. Mantener el prefijo evita inventar una superficie nueva y conserva el agrupamiento "todo lo de la tarea cuelga de /scheduling/:taskId".

**Decisión de verbo/permiso**: `PATCH` (edición parcial). Permiso `inventory.manage`, NO `scheduling.write` ni `inventory.write` — corregir un tipo YA confirmado es acción de administración (decisión confirmada en el proposal). Esto requiere agregar `manage` al `InventoryRoutePerms`.

**Handler** (en `contractInventory.routes.ts`, junto a confirm/discard, ~línea 96), siguiendo el patrón de validación de tipo de las líneas 79-82 y el manejo de errores de dominio de las líneas 122-130:
```ts
router.patch(
  '/scheduling/:taskId/inventory/suggestions/:suggestionId/type',
  auth, perms.manage,
  async (req, res, next) => {
    try {
      const rawType = (req.body as { type?: unknown } | undefined)?.type;
      if (!(await deviceTypes.isValid(rawType as string))) {
        res.status(422).json({ error: 'Invalid item type', code: 'INVALID_ITEM_TYPE' });
        return;
      }
      const item = await correctType.execute({
        suggestionId: req.params.suggestionId,
        newType: (rawType as string).toUpperCase(),
      });
      res.json(item);
    } catch (e) {
      if (e instanceof SuggestionNotConfirmedError || e instanceof NotADeviceError) {
        res.status(409).json({ error: e.message, code: e.code });
        return;
      }
      if (e instanceof SuggestionNotFoundError || e instanceof InstalledItemNotFoundError) {
        res.status(404).json({ error: e.message, code: e.code });
        return;
      }
      next(e);
    }
  },
);
```

> **`newType` normalizado**: la route ya valida con `deviceTypes.isValid` (case-insensitive, UPPERCASE) y pasa `.toUpperCase()` al use-case, igual que `ConfirmInventorySuggestion` guarda el tipo canónico. Así la sugerencia y el ítem quedan con el mismo string canónico (ANTENA, no "Antena").

> **Status codes**: 422 tipo inválido (consistente con confirm/POST/PATCH existentes). 404 sugerencia o ítem inexistente. 409 conflicto de estado (no confirmada / no es DEVICE) — el recurso existe pero su estado no permite la operación. La route es el "validation boundary" (DIP), igual que el comentario de la línea 178.

### AD-6. DI wiring

En `contractInventory.routes.ts`:
- Agregar `correctType: CorrectConfirmedDeviceType` como parámetro de `createContractInventoryRouter` (al final, antes de `auth`, para no romper el orden posicional de los existentes — o, mejor, justo después de `discard` que es su vecino semántico; **decisión: agregarlo después de `discard` y actualizar TODOS los call-sites** — hay 2: `app.ts` y el test de routes).
- Extender `InventoryRoutePerms` (`contractInventory.routes.ts:27`) con `manage: RequestHandler`.
- Importar los nuevos errores (`SuggestionNotConfirmedError`, `NotADeviceError`) y el use-case.

En `app.ts:1030-1053`:
- Instanciar `new CorrectConfirmedDeviceType(inventorySuggestionRepo, contractInventoryRepo)` y pasarlo en su posición.
- Agregar `manage: requirePerm('inventory', 'manage')` al objeto de perms (línea ~1051).

> **RBAC**: `inventory.manage` debe existir como permiso. Verificar en el seed/catálogo de permisos; si `inventory` ya tiene `read`/`write`, agregar `manage` es aditivo (el proposal asume que `inventory.manage` ya existe — confirmar contra el seed de RBAC antes de aplicar; si falta, es una línea en el seed, sin migración de datos).

---

## F2 — Match contra el inventario del contrato

### AD-7. Enriquecer `ListTaskInventorySuggestions` vs use-case nuevo

**Decisión**: ENRIQUECER `ListTaskInventorySuggestions` (inyectar `ContractInventoryRepository` + `SchedulingRepository`). NO crear `ListTaskInventorySuggestionsWithMatch`.

**Rationale**:
- Hay UN solo consumidor del listado (la route GET de la línea 70 → el tab de inventario de la tarea). El match es información que ese consumidor SIEMPRE quiere. Partir en dos use-cases dejaría el viejo sin uso (YAGNI) o duplicaría la lógica de listado.
- El costo es 2 deps nuevas y resolver el contrato 1 vez por request (no por sugerencia). Aceptable.
- El use-case pasa de retornar `TaskInventorySuggestion[]` a `TaskInventorySuggestionDto[]` (ver AD-8) — esto SÍ cambia la firma y la forma de respuesta. Se documenta el impacto FE en AD-10.

**Nueva firma**:
```ts
export class ListTaskInventorySuggestions {
  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly inventory: ContractInventoryRepository,
    private readonly scheduling: SchedulingRepository,
  ) {}

  async execute(taskId: string): Promise<TaskInventorySuggestionDto[]> { ... }
}
```

**Flujo**:
1. `const list = await this.suggestions.listByTask(taskId)`.
2. Resolver el contrato: `const task = await this.scheduling.getTask(taskId); const contractId = task?.contractId ?? null;`
3. Si `contractId` es null → devolver todas con `match: null` (sin contrato no hay con qué cruzar; no es error — la tarea puede no tener contrato aún).
4. `const items = (await this.inventory.listByContract(contractId)).filter(i => i.status === 'active')` — solo ítems ACTIVOS (no `removed`/`replaced`; un equipo dado de baja no cuenta como "ya instalado").
5. Para cada sugerencia → `toTaskInventorySuggestionDto(s, computeMatch(s, items))`.

### AD-8. DTO nuevo: `TaskInventorySuggestionDto`

**Ubicación**: `src/application/dto/TaskInventorySuggestionDto.ts`

```ts
export type MatchStatus = 'same_device' | 'same_type';

export interface SuggestionMatch {
  status: MatchStatus;
  /** id del ContractInstalledItem coincidente (referencia). */
  itemId: string;
  /** serial del ítem coincidente, para mostrar en el badge. */
  serial: string | null;
}

export interface TaskInventorySuggestionDto extends TaskInventorySuggestion {
  /** Cruce contra el inventario activo del contrato. null = sin coincidencia. */
  match: SuggestionMatch | null;
}

export function toTaskInventorySuggestionDto(
  s: TaskInventorySuggestion,
  match: SuggestionMatch | null,
): TaskInventorySuggestionDto {
  return { ...s, match };
}
```

> Extiende la entidad (igual que `InstalledItemDto extends ContractInstalledItem`, `dto/InstalledItemDto.ts:8`) → el campo `match` es PURAMENTE derivado, no persiste. Cumple la regla "nunca devolver entidad cruda desde la route": ahora la route serializa el DTO.

### AD-9. Lógica de match (`computeMatch`)

Función pura dentro del use-case (o helper exportado para testear aislado). Para una sugerencia:

```ts
const norm = (v: string | null): string | null =>
  v == null ? null : v.trim().toUpperCase() || null; // '' → null tras trim

function computeMatch(s: TaskInventorySuggestion, items: ContractInstalledItem[]): SuggestionMatch | null {
  if (s.kind !== 'DEVICE') return null; // solo equipos físicos (decisión del proposal)

  const sn = norm(s.serialNumber);
  const mac = norm(s.mac);
  const type = norm(s.deviceType);

  // 1) same_device: mismo aparato físico (SN o MAC coincide). Prioridad máxima.
  const byIdentity = items.find(i =>
    (sn != null && norm(i.serialNumber) === sn) ||
    (mac != null && norm(i.mac) === mac),
  );
  if (byIdentity) {
    return { status: 'same_device', itemId: byIdentity.id, serial: byIdentity.serialNumber };
  }

  // 2) same_type: mismo tipo, distinto SN/MAC (posible reemplazo).
  const byType = type != null ? items.find(i => norm(i.type) === type) : undefined;
  if (byType) {
    return { status: 'same_type', itemId: byType.id, serial: byType.serialNumber };
  }

  return null;
}
```

**Reglas de normalización** (decisión confirmada en proposal): `trim` + `toUpperCase`, case-insensitive. SN/MAC vacíos tras trim → `null` → no matchean (no se considera "" como coincidencia). El criterio de "mismo aparato físico" es SN **o** MAC (cualquiera de los dos identifica el equipo). `same_device` tiene prioridad sobre `same_type` (si el SN coincide, no importa que además sea del mismo tipo: es EL mismo equipo).

**Edge cases cubiertos por tests** (AD-12): sugerencia sin SN ni MAC pero mismo tipo → `same_type`; sugerencia MATERIAL → siempre `null`; ítem `removed` → ignorado (no entra en `items`); contrato sin ítems → `null`; SN igual con distinta capitalización/espacios → `same_device`.

### AD-10. Impacto en la forma de respuesta (FE)

La route `GET /scheduling/:taskId/inventory/suggestions` (`contractInventory.routes.ts:70-74`) hoy devuelve `TaskInventorySuggestion[]`. Tras F2 devuelve `TaskInventorySuggestionDto[]` — **mismo shape + un campo nuevo `match`**. Es un cambio ADITIVO y retrocompatible: el FE viejo ignora `match`; el FE nuevo lo lee. No rompe el contrato existente (no se quita ni renombra ningún campo). Orden de deploy: BE antes que FE (el FE degrada sin badge si `match` no viene).

---

## FE — Cambios

### AD-11. Editor de tipo (F1) + badge de match (F2) en `SuggestionCard`

**Tipos** (`src/types/serviceInventory.ts:58`): agregar a `TaskInventorySuggestion`:
```ts
match?: {
  status: 'same_device' | 'same_type';
  itemId: string;
  serial: string | null;
} | null;
```
Opcional (`?`) para degradar si el BE no lo manda.

**API** (`src/api/serviceInventory.api.ts`): nueva fn
```ts
export const correctSuggestionType = (taskId: string, suggestionId: string, type: string) =>
  axiosClient
    .patch<ServiceInstalledItem>(`/scheduling/${taskId}/inventory/suggestions/${suggestionId}/type`, { type })
    .then(r => r.data);
```

**Hook** (`src/hooks/useServiceInventory.ts`): nuevo `useCorrectSuggestionType(taskId, contractId?)` espejando `useConfirmSuggestion` (líneas 51-74):
```ts
export function useCorrectSuggestionType(taskId: string, contractId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ suggestionId, type }: { suggestionId: string; type: string }) =>
      api.correctSuggestionType(taskId, suggestionId, type),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: suggestionsKey(taskId) });
      if (contractId) void qc.invalidateQueries({ queryKey: itemsKey(contractId) });
      else void qc.invalidateQueries({ queryKey: ['service-inventory'] });
    },
  });
}
```
Invalida `['task-inventory-suggestions', taskId]` (refresca la card resuelta) **y** `['service-inventory', contractId]` (refresca el sidebar — el bug del caso real era justamente esta desincronización).

**`SuggestionCard.tsx`**: en la variante resuelta DEVICE (hoy `SuggestionCard.tsx:68-70`, el `<span>` estático):
- Envolver un editor de tipo en `<Can permission="inventory.manage">`. Fuera del `Can` (o como fallback), seguir mostrando el `<span>` estático actual → un operador sin `inventory.manage` ve el tipo como hoy, sin botón.
- El editor: dropdown reutilizando `activeTypes` (ya computado en `SuggestionCard.tsx:31-33`) inicializado en `s.deviceType`, + botón "Guardar" que llama `onCorrectType(s.id, selectedType)`. Patrón de edición inline (toggle a modo edición) para no romper el layout de la card resuelta.
- **Badge de match** (F2): cuando `s.match != null`, render de un badge cerca del tipo/meta:
  - `same_device` → "⚠️ Ya instalado: el mismo equipo" (+ `s.match.serial` si existe).
  - `same_type` → "Ya hay un/a {tipo} (posible reemplazo)".
  El badge se muestra tanto en pending como en resuelto (avisa al operador antes de confirmar y deja la traza después). Es solo-lectura (`inventory.read`), sin gating extra.

**Props nuevas en `SuggestionCard`**: `onCorrectType?: (id: string, type: string) => void` y `isCorrecting?: boolean`. La card NO llama hooks de permiso directamente para el editor — usa `<Can>` (consistente con el patrón del proyecto, `Can.tsx`).

### AD-12bis. Threading del contractId al tab (necesario para invalidar el sidebar)

Hoy `TaskInventorySuggestions` recibe solo `taskId` (`TaskInventorySuggestions.tsx:21`) y `useConfirmSuggestion(taskId)` se llama SIN contractId (`TaskInventorySuggestions.tsx:23`) → al confirmar/corregir NO invalida `['service-inventory', contractId]` con la key correcta (cae al fallback `['service-inventory']`). Para que F1 sincronice el sidebar de forma precisa:
- `InventoryPanel`/`TaskTabs` (`TaskTabs.tsx:39-45, 71, 114`) deben recibir y propagar el `contractId` de la tarea (disponible aguas arriba — el sidebar ya lo usa en `CustomerSidebar.tsx`/`ContractInventoryReadonly.tsx`).
- `TaskInventorySuggestions` pasa ese `contractId` a `useConfirmSuggestion` y al nuevo `useCorrectSuggestionType`.

> Es un cambio chico pero necesario; sin él la corrección refresca la card pero no el sidebar (reproduciendo a medias el bug original). Documentado como parte de F1.

---

## Testing strategy (Strict TDD: red → green → refactor)

> Test runner del proyecto: `npm test` (Jest + ts-jest, BE) / Vitest (FE). Empezar SIEMPRE por el test que falla.

### BE — Use-case unit (InMemory repos, sin Prisma)

Nuevo `src/__tests__/application/CorrectConfirmedDeviceType.test.ts` (espeja el `setup()` de `ServiceInventory.test.ts:29-46`, reutilizando `InMemoryInventorySuggestionRepository` + `InMemoryContractInventoryRepository`):
- **Happy path sync**: confirmar una sugerencia DEVICE (ONU) → corregir a ANTENA → assert que `suggestions.get(id).deviceType === 'ANTENA'` **Y** `inventory.getById(confirmedItemId).type === 'ANTENA'`. Verifica los DOS registros (la esencia del fix).
- **Guarda not found**: `suggestionId` inexistente → `SUGGESTION_NOT_FOUND`.
- **Guarda not confirmed**: sugerencia pending → `SUGGESTION_NOT_CONFIRMED`.
- **Guarda not a device**: sugerencia MATERIAL confirmada → `SUGGESTION_NOT_A_DEVICE` (y assert que NO se tocó ningún consumo).
- **Guarda confirmedItemId null**: confirmed pero sin confirmedItemId (dato sucio) → `SUGGESTION_NOT_CONFIRMED`.
- **Guarda item inexistente**: `confirmedItemId` apunta a un ítem borrado → `INSTALLED_ITEM_NOT_FOUND`.
- **Normalización**: corregir con `'antena'` (lowercase) — pero como la route normaliza, el use-case recibe ya UPPERCASE; el test del use-case pasa `'ANTENA'`. La normalización lowercase→UPPERCASE se cubre en el test de route.

Match en `ListTaskInventorySuggestions` — extender/crear `src/__tests__/application/ListTaskInventorySuggestionsMatch.test.ts`:
- `same_device` por SN coincidente (con espacios/capitalización distinta → normalización).
- `same_device` por MAC coincidente (SN distinto).
- `same_type` (mismo tipo, SN/MAC distintos).
- `null` (sin coincidencia).
- MATERIAL → siempre `null`.
- ítem `removed`/`replaced` ignorado → `null` aunque el SN coincida.
- contrato sin ítems / tarea sin contractId → todas `null`.
- prioridad: SN coincide y tipo coincide → `same_device` (no `same_type`).

### BE — Route supertest

Extender `src/__tests__/infrastructure/serviceInventory.routes.test.ts` (`buildApp()` ya monta el router con perms `pass`; agregar `manage: pass` al objeto de perms de la línea 81, e instanciar `CorrectConfirmedDeviceType`):
- `PATCH .../type` con tipo válido → 200 + el ítem actualizado + assert sync en ambos repos (vía los repos expuestos por `buildApp`).
- tipo inválido (`{ type: 'SUBMARINO' }`) → 422 `INVALID_ITEM_TYPE`.
- tipo lowercase válido (`{ type: 'antena' }`) → 200 y persiste `ANTENA` (normalización en route).
- sugerencia pending → 409 `SUGGESTION_NOT_CONFIRMED`.
- sugerencia MATERIAL confirmada → 409 `SUGGESTION_NOT_A_DEVICE`.
- guard `inventory.manage`: un segundo `buildApp` con `manage: deny` → 403 (espeja el patrón `deny` de la línea 67).
- GET suggestions ahora incluye `match` en cada item (al menos un caso `same_device`).

### FE — Vitest

- `SuggestionCard`: con `inventory.manage` (mock de `useMyPermissions`/`Can`) → renderiza el editor de tipo en la card resuelta; sin el permiso → solo el `<span>` estático (sin botón). Mockear el patrón ya usado en `__tests__/components/auth/Can.test.tsx`.
- `SuggestionCard`: con `s.match.status === 'same_device'` → badge "Ya instalado"; `same_type` → badge "posible reemplazo"; `match == null` → sin badge.
- `useCorrectSuggestionType`: onSuccess invalida `['task-inventory-suggestions', taskId]` y `['service-inventory', contractId]` (espeja el test de `useConfirmSuggestion` si existe; si no, test de mutación con un `QueryClient` espía).

---

## Decisiones abiertas — resueltas

| Decisión | Resolución | Dónde |
|----------|-----------|-------|
| `setStatus`-reuse vs nuevo método de repo | **Reusar `setStatus(id,'confirmed',confirmedItemId,deviceType)`** — el param `deviceType` ya existe con esa semántica. | AD-2 |
| Enriquecer `ListTaskInventorySuggestions` vs use-case nuevo | **Enriquecer** el existente (único consumidor, match siempre deseado). Cambia la firma a `TaskInventorySuggestionDto[]`. | AD-7 |
| `confirmedItemId` null | Guarda → `SUGGESTION_NOT_CONFIRMED` (no hay ítem que sincronizar). | AD-1 paso 4 |
| `confirmedItemId` apunta a MATERIAL (consumo) | La guarda `kind !== 'DEVICE'` corta ANTES de tocar `inventory.update`. F1 solo aplica a DEVICE. | AD-1 paso 2 |
| Permiso de edición | `inventory.manage` (admin) — agrega `manage` a `InventoryRoutePerms` + `requirePerm('inventory','manage')` en app.ts. | AD-5, AD-6 |
| Status code de "no confirmada / no device" | **409** (conflicto de estado, el recurso existe). 422 reservado para tipo inválido. | AD-5 |
| Forma de retorno de F1 | `InstalledItemDto` (con `addedByUserName: null`); el FE refetchea para el nombre real. | AD-3 |

---

## Resumen de archivos tocados

**BE**
- `src/application/use-cases/CorrectConfirmedDeviceType.ts` — NUEVO.
- `src/application/use-cases/ListTaskInventorySuggestions.ts` — +2 deps, retorna DTO con match.
- `src/application/dto/TaskInventorySuggestionDto.ts` — NUEVO.
- `src/domain/errors/inventory.ts` — +`SuggestionNotConfirmedError`, +`NotADeviceError`.
- `src/infrastructure/http/routes/contractInventory.routes.ts` — +PATCH `.../type`, +`manage` en `InventoryRoutePerms`, +param `correctType`, import errores.
- `src/infrastructure/http/app.ts` — instanciar `CorrectConfirmedDeviceType`, +`manage: requirePerm('inventory','manage')`, actualizar args de `ListTaskInventorySuggestions`.
- (RBAC seed) — confirmar/agregar permiso `inventory.manage`.
- Tests: `CorrectConfirmedDeviceType.test.ts` (nuevo), `ListTaskInventorySuggestionsMatch.test.ts` (nuevo o extensión de `ServiceInventory.test.ts`), `serviceInventory.routes.test.ts` (extensión).

**FE**
- `src/types/serviceInventory.ts` — +`match` en `TaskInventorySuggestion`.
- `src/api/serviceInventory.api.ts` — +`correctSuggestionType`.
- `src/hooks/useServiceInventory.ts` — +`useCorrectSuggestionType`.
- `src/pages/scheduling/SchedulingTaskDetailPage/components/SuggestionCard.tsx` — editor de tipo gated `inventory.manage` + badge de match.
- `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskInventorySuggestions.tsx` — recibe + propaga `contractId`, usa el nuevo hook.
- `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskTabs.tsx` — propaga `contractId` al `InventoryPanel`/`TaskInventorySuggestions`.
- Tests: `SuggestionCard.test.tsx` (editor gated + badge), `useServiceInventory` (invalidaciones).
