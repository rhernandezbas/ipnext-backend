# Design: PPPoE — seleccionar TODO el filtro para el bulk cambio de plan (v2)

## Contexto

El tab **PPPoE de Gestión de Red** (`PppoeManagementTab.tsx`) lista los servicios PPPoE globales vía `ListAllPppoeServices` → `PppoeServiceRepository.listAllPaginated` (`GET /api/pppoe`, gate `pppoe.read`, 25/pág). El change padre `pppoe-search-bulk-plan` (EN PROD) agregó: búsqueda por IP/MAC, columna MAC, selección por checkboxes de página, toolbar contextual, y el bulk `POST /api/pppoe/bulk/change-plan` (best-effort, tope 200, `{ ok, failed }`).

**Lo que YA existe y se reusa (verificado, file:line en main):**

- **Filtros del listado** (`pppoe.routes.ts:326-353`, `GET /pppoe`): parsea de `req.query` → `search`, `status`, `nasId`, `page`, `limit`, `includeUnassigned` → `ListAllPppoeServices.execute(filter)`. Gate `canRead = requirePerm('pppoe','read')` (`:161`).
- **Normalización de `status`** (`ListAllPppoeServices.ts:48-49`): el `status` llega en vocabulario de NEGOCIO; `isDisplayStatus(filters.status)` lo valida (fail-open: valor desconocido → sin filtro) y se pasa al repo como `displayStatus` (`:55`).
- **Construcción del WHERE** (`PrismaPppoeServiceRepository.ts:206-243`, INLINE dentro de `listAllPaginated`): arma un `AND` de fragmentos — `contractId` (según `includeUnassigned`), `nasId`, el `OR` del search (username / cliente / `remoteAddress` / variantes de `callerId` si `looksLikeMac`), y `displayStatusWhere(displayStatus)`. El **mismo `where`** alimenta `findMany` **y** `count` (`:245-270`) — ya es la fuente de verdad de data+total DENTRO del método.
- **Bulk** (`BulkChangePppoePlan.ts`): `MAX_BULK_IDS=200` (`:41`); dedup + tope + fail-fast de plan + best-effort agrupado por `nasId`; devuelve `{ ok: string[], failed: { id, username, error }[] }`. Ruta `POST /pppoe/bulk/change-plan` (`:889-925`), gate `canManage` (`:162`), body `{ ids, profile, reason }`, errores 422 `{ code, error }`, `next(err)` para lo inesperado.
- **FE selección** (`PppoeManagementTab.tsx`): `selected: Set<string>` (`:737`); `overSelectionCap = selected.size > BULK_SELECTION_CAP` (`:740`, `BULK_SELECTION_CAP=200` `:43`); toolbar con "N seleccionados" + botón "Cambiar plan" `aria-disabled` cuando `overSelectionCap` (`:974-1005`); checkbox de header "Seleccionar todos de esta página" que marca SOLO `currentPageIds` (`:1013-1022`, `handleTogglePage` `:799-815`).
- **FE limpiar-al-filtrar** (`:781-783`): `handleSearch`/`handleNas`/`handleStatus` hacen `setPage(1)` **Y** `setSelected(new Set())` — cualquier cambio de filtro **limpia la selección**. Este es el invariante que hace seguro el congelamiento.
- **FE data + hook** (`useInternetServices.ts:22,31-38`): `useAllPppoe(filter)` con `listKey(filter) = ['pppoe','list', filter]`; el FE SIEMPRE manda `includeUnassigned: true` (`PppoeManagementTab.tsx:747`). Hook `useBulkChangePppoePlan` (`usePppoe.ts:370-382`) invalida `GLOBAL_LIST_KEY=['pppoe','list']`.
- **FE api** (`pppoe.api.ts:329-334`): `bulkChangePlan(ids, profile, reason?)` → `POST /pppoe/bulk/change-plan` → `{ ok, failed }`.

---

## Decisión 1 — Endpoint de ids: **método nuevo del port `listAllIds`** que **reusa un WHERE-builder compartido** (NO flag del existente, NO barrer filas enteras)

**El problema central (el riesgo #1 del change):** el conjunto que el operador SELECCIONA debe ser IDÉNTICO al que VE listado. Si el endpoint de ids arma su `where` por separado, driftea (un `OR` de más, un `displayStatus` traducido distinto) → el operador muta servicios que no vio, o se pierde alguno.

**Opciones evaluadas:**

| Opción | Descripción | Tradeoff |
|--------|-------------|----------|
| **A. Flag en `listAllPaginated`** (`{ ...params, idsOnly: true }`) | El mismo método, sin `skip/take`, devolviendo solo ids | Mezcla DOS shapes de retorno en un método; `page/pageSize` quedan sin sentido; la firma se vuelve ambigua. **Descartada.** |
| **B. Barrer `listAllPaginated` sin paginar y mapear a ids en el use case** | El use case pide todas las páginas y hace `.map(s => s.id)` | Trae la proyección PESADA (JOIN cliente + todos los campos) para CIENTOS/miles de filas solo para tirarlas. Desperdicio de I/O y memoria. **Descartada.** |
| **C. Método nuevo `listAllIds` + WHERE-builder compartido** ✅ | Extraer `buildListAllWhere(params)` (hoy inline `:206-243`); `listAllPaginated` lo reusa; `listAllIds` = `findMany({ where, select:{id:true}, orderBy })` + `count({ where })` | El WHERE es UNO SOLO por construcción (no puede driftear). Payload liviano (`select { id }`). Requiere un método más en el port + espejo in-memory. **Elegida.** |

**Elegida: Opción C.** Es la única que garantiza paridad **por construcción** (mismo `buildListAllWhere`) y no desperdicia I/O. La firma:

```ts
// port PppoeServiceRepository
listAllIds(params: {
  search?: string;
  displayStatus?: PppoeDisplayStatus;
  nasId?: string;
  includeUnassigned?: boolean;
}): Promise<{ ids: string[]; total: number }>;
```

- **Prisma:** `const where = buildListAllWhere(params); const [rows, total] = await Promise.all([ model().findMany({ where, orderBy:{username:'asc'}, select:{ id:true } }), model().count({ where }) ]); return { ids: rows.map(r => r.id), total };`
- **In-memory:** aplica EXACTAMENTE el mismo filtrado que `listAllPaginated` (mismo helper `macSearch` + mismo `displayStatus` + mismo `contractId`/`nasId`), devuelve `{ ids, total }` sin paginar.
- **`ids.length === total`** siempre (no hay paginación). Se devuelve `total` explícito igual para simetría de contrato con el listado y como sanity value barato. El **parity test** afirma `ids.length === total` Y `total(/ids) === total(GET /pppoe)` para el mismo filtro.

> **Guardrail de drift (doble):** (1) `buildListAllWhere` compartido en el adapter Prisma; (2) la normalización `status`→`displayStatus` compartida entre `ListAllPppoeServices` y `ListAllPppoeServiceIds` (extraer un helper `normalizePppoeListFilters` o replicar `isDisplayStatus` con parity test que lo cubra). El parity test recorre cada filtro y combinación con el MISMO seed.

### Decisión 1b — Use case liviano `ListAllPppoeServiceIds`

`ListAllPppoeServices` hace enriquecimiento pesado (`resolveCreatedBy` + `resolveNasInfo`, `:60-63`) que el endpoint de ids NO necesita. Por eso un use case **separado** y liviano:

```ts
class ListAllPppoeServiceIds {
  constructor(private readonly pppoeRepo: PppoeServiceRepository) {}
  async execute(filters: { search?, status?, nasId?, includeUnassigned? }): Promise<{ ids: string[]; total: number }> {
    const displayStatus = isDisplayStatus(filters.status) ? filters.status : undefined; // MISMA lógica que ListAllPppoeServices
    return this.pppoeRepo.listAllIds({
      ...(filters.search ? { search: filters.search } : {}),
      ...(displayStatus ? { displayStatus } : {}),
      ...(filters.nasId ? { nasId: filters.nasId } : {}),
      ...(filters.includeUnassigned ? { includeUnassigned: true } : {}),
    });
  }
}
```

Solo depende de `PppoeServiceRepository` (DIP). Sin `eventRepo`/`catalogRepo`/`nasRepo`.

### Decisión 2 — Sin filtro activo → **400 `FILTER_REQUIRED`** (no vacío, no 422)

El endpoint existe para **selección filtrada**, NUNCA para "seleccionar todos los servicios del sistema". La precondición: **al menos uno** de `{ search, status, nasId }` presente. `includeUnassigned` **NO** cuenta como filtro de narrowing (es un toggle de scope; el FE lo manda siempre en `true`).

- **Sin filtro → 400** con código `FILTER_REQUIRED`. Se resuelve en la RUTA (conoce el query crudo), ANTES de invocar el use case.
- **Por qué 400 y no vacío:** devolver `{ ids: [], total: 0 }` sería silenciosamente engañoso (el operador creería que no hay nada). 400 es la señal honesta: "narrow con al menos un filtro".
- **Por qué 400 y no 422** (tensión documentada): el resto de `pppoe.routes.ts` usa **422 `VALIDATION_ERROR`** para fallos de Zod. Pero esto NO es un fallo de schema del body — es una **precondición semántica** de un GET con query params. `400 Bad Request` es el status honesto para "la request es sintácticamente válida pero le falta un filtro obligatorio". **Decisión del usuario: 400.** Si el review adversarial exige consistencia estricta con el 422 del archivo, es un cambio de una línea (ver `open_questions`).
- **Defensa en profundidad:** además del check de ruta, el use case puede lanzar un error de dominio si llega sin ningún filtro (para callers directos), mapeado a 400. No obligatorio; la ruta es la frontera real.

### Decisión 3 — Gate `pppoe.manage` (NO `pppoe.read`)

El listado (`GET /pppoe`) es `pppoe.read`. El endpoint de ids es **`pppoe.manage`** porque existe **exclusivamente** para alimentar la mutación bulk (que es `pppoe.manage`). Gatearlo en `read` filtraría una afordancia de bulk-selection a usuarios read-only. `403` sin `pppoe.manage`. Consistente con "el botón aparece solo con `pppoe.manage`".

---

## Decisión 4 — Congelamiento del set en el FE (anti-TOCTOU)

**El invariante que ya existe:** cambiar cualquier filtro **limpia** la selección (`:781-783`, `setSelected(new Set())`). Esto es la base del congelamiento.

**El flujo:**
1. El operador tiene un filtro activo (ej. `nasId=NE8000-1`). El listado muestra 25/pág, `total=340`.
2. Aparece el botón **"Seleccionar los N del filtro"** (N = `total` del listado, ya disponible).
3. Al clic → `pppoeApi.listIds({ search, nasId, status, includeUnassigned: true })` → `{ ids: [340 ids], total: 340 }`.
4. **Congelar:** `setSelected(new Set(ids))`. Esos 340 ids SON los que se mutan. El toolbar muestra "340 seleccionados".
5. Si el operador **cambia el filtro** después → `handleNas`/`handleSearch`/`handleStatus` disparan `setSelected(new Set())` → la selección congelada se **LIMPIA**.

**Por qué LIMPIA y no "persiste":** es **consistente** con el comportamiento actual (limpiar-al-filtrar). Persistir una selección hecha bajo un filtro viejo, mientras la tabla muestra otro filtro, es confuso y peligroso (el operador vería "340 seleccionados" con filas que no matchean). Limpiar es la opción honesta y ya implementada.

**Anti-TOCTOU explícito:** el bulk se ejecuta con `Array.from(selected)` — ids LITERALES capturados en el paso 3. El BE **NUNCA** re-resuelve el filtro al ejecutar. Si entre seleccionar y confirmar alguien dio de baja un servicio, ese id caerá en `failed` con `PPPOE_NOT_FOUND` (best-effort del bulk existente) — nunca se toca un servicio fuera del snapshot.

**API/hook del fetch de ids:** on-demand (NO `useQuery` cacheado). `useMutation` (o llamada imperativa) para tener `isPending`/`isError` en el botón mientras trae cientos de ids. `pppoeApi.listIds(filter)` mapea filtros vacíos fuera del query (mismo patrón que `pppoeApi.list`).

---

## Decisión 5 — Chunking de 200 secuencial + agregación + política de fallo de lote

**El BE del bulk NO se toca:** `MAX_BULK_IDS=200` sigue siendo un guard **por request**. El FE garantiza cada request ≤200 partiendo en chunks.

**Helper puro (testeable en aislamiento):**
```ts
function chunk<T>(arr: T[], size: number): T[][]  // chunk([...340], 200) → [[200], [140]]
```

**Envío SECUENCIAL (no paralelo):**
```
lotes = chunk(ids, 200)                     // ej. 340 → [200, 140]
agg = { ok: [], failed: [] }
for (i, lote) in lotes:
  progreso("lote {i+1}/{lotes.length} — {ids.length} servicios")
  try:
    res = await bulkChangePlan(lote, profile, reason)   // reusa el bulk tal cual
    agg.ok.push(...res.ok); agg.failed.push(...res.failed)
  catch (err):                              // ← RECHAZO de lote ENTERO (red/500), NO ítems failed
    cortar; mostrar agg PARCIAL + error claro ("Se cortó en el lote {i+1}/{n}. Se aplicaron {agg.ok.length}, ...")
    return
mostrar resumen agregado { ok, failed }
```

- **Secuencial, no paralelo:** no castigar al RADIUS. Cada lote ya agrupa por router con throttle dentro del BE; encadenarlos evita 2+ olas simultáneas.
- **Agregación cross-lote:** un ÚNICO resumen `{ ok, failed }` sumando todos los lotes. Los `failed` (ítem por ítem: router caído, `PPPOE_NOT_FOUND`) de todos los lotes se concatenan.
- **Política de fallo de lote ENTERO** (el `bulkChangePlan` rechaza: red caída, 500, 401): **CORTAR** los lotes restantes y mostrar el agregado **PARCIAL** + error claro. **Por qué cortar y no seguir:** un rechazo de lote entero (no ítems `failed`) señala un problema sistémico (BE caído, sesión expirada) — seguir mandando lotes solo acumula fallos y castiga un sistema ya en problemas. Cortar + reportar lo ya aplicado es honesto y deja al operador reintentar el resto. Distinción clave: **ítems `failed` NO cortan** (best-effort del bulk, esperado); **rechazo de lote entero SÍ corta**.
- **Progreso por lote:** "lote 2/3 — 340 servicios" visible durante el envío (el operador ve que N>200 tarda).

---

## Decisión 6 — Rediseño del cap W1 + confirmación N>200

**Antes (change padre):** `overSelectionCap = selected.size > 200` → botón "Cambiar plan" `aria-disabled` + mensaje "máximo 200. Reducí la selección". >200 estaba **bloqueado**.

**Ahora:** >200 **ya NO bloquea** — el envío en lotes lo resuelve. El toolbar **informa**:
- N≤200: "N seleccionados" + botón habilitado (idéntico a hoy).
- N>200: "N seleccionados — se enviará en X lotes de 200" (`X = Math.ceil(N/200)`) + botón habilitado.

**Confirmación:**
- N≤200: flujo actual INTACTO (dropdown de plan + reason + confirmar). Sin checkbox extra.
- N>200: **checkbox obligatorio** "Entiendo que voy a cambiar el plan de N servicios" que **gatea** el botón de confirm (deshabilitado hasta tildar). Es la fricción proporcional al blast radius (cientos de clientes reales en el RADIUS).

**Reescritura HONESTA de los tests W1** (`PppoeManagementTab.bulk.test.tsx:370-413`): los tests "201 → aria-disabled + máximo 200" y "200 → habilitado" **codifican el comportamiento viejo**. El comportamiento cambia de spec:
- El test "201 → disabled" se **reemplaza** por "201 → habilitado + 'se enviará en 2 lotes' + checkbox de confirmación requerido".
- NO se debilitan (ej. borrar el assert) — se **reescriben** para afirmar el comportamiento nuevo. El diff debe mostrar el cambio de expectativa, no una relajación silenciosa.

---

## Contrato BE↔FE (resumen; el detalle campo-por-campo va en el spec)

**Nuevo endpoint:** `GET /api/pppoe/ids?search=&status=&nasId=&includeUnassigned=true` (gate `pppoe.manage`).
- **Query:** MISMOS params que `GET /api/pppoe` (menos `page`/`limit`). Precondición: ≥1 de `{search, status, nasId}`.
- **200:** `{ "ids": ["id1", "id2", ...], "total": 340 }` (con `ids.length === total`).
- **400** `{ code: "FILTER_REQUIRED", error: "..." }` (sin filtro activo) · **403** (sin `pppoe.manage`) · **401** (sin sesión).

**FE api:** `pppoeApi.listIds(filter: PppoeServiceListFilter): Promise<{ ids: string[]; total: number }>`.

**Bulk (reusado, sin cambios):** `POST /api/pppoe/bulk/change-plan` body `{ ids: string[] (≤200), profile, reason? }` → `{ ok, failed }`. El FE lo llama **una vez por lote**.

**Agregación FE (no viaja por el wire — es estado local):** `{ ok: string[], failed: { id, username, error }[] }` sumado de todos los lotes; más un estado de "corte" `{ cutAtBatch, totalBatches }` cuando un lote entero rechaza.

---

## Hexagonal / DIP

- `ListAllPppoeServiceIds` vive en `application` y depende **solo** de `PppoeServiceRepository` (port). Ningún import de Prisma/Express/axios.
- `buildListAllWhere` es un privado del **adapter Prisma** (infra) — es Prisma-specific (`Record<string,any>` de fragmentos). NO sube al dominio. Su espejo in-memory replica la semántica, no el código.
- El helper `macSearch` (dominio, puro, del change padre) se reusa tal cual en `listAllIds` in-memory.
- Tests TDD con `InMemory*` repos (red → green → refactor). El **parity test** compara `listAllPaginated` (barrido de todas las páginas) vs `listAllIds` con el mismo seed.
- **FE:** `chunk` es una función PURA (sin React, sin api) — test unitario aislado. El orquestador secuencial se testea con un `bulkChangePlan` fake que devuelve/rechaza por lote.

---

## Coordinación con `pppoe-move-nas` (sesión paralela — NO tocar)

| Archivo | `pppoe-bulk-select-filter` (este) | `pppoe-move-nas` (paralelo) |
|---------|-----------------------------------|-----------------------------|
| `PppoeManagementTab.tsx` | botón "Seleccionar los N del filtro" + congelamiento + rediseño del cap + checkbox N>200 | el MODAL "Mover NAS" + tab "Movimientos NAS" |
| `app.ts` | wiring de `ListAllPppoeServiceIds` en el router pppoe | wiring de `MovePppoeToNas` + watcher |

**Regla:** este change **NO** toca el modal Mover NAS, `MovePppoeToNas`, ni la page de auditoría. Worktrees dedicados; rebase ordenado; sin conflicto semántico (secciones distintas del mismo archivo). Si hay conflicto de líneas, se resuelve manteniendo AMBAS features.

---

## Reglas del proyecto que este diseño respeta

- **Contrato BE↔FE campo-por-campo en el spec** (lección W6: BE y FE en paralelo driftean). El shape `{ ids, total }` + el 400/403 congelados.
- **Test de seam completo por param** (lección #28): ruta `GET /pppoe/ids` → use case REAL → repo in-memory; NO mockear el use case. Un test por filtro + combinaciones + el 400 + el 403.
- **Parity test** list↔ids: el guardrail contra el drift (riesgo #1).
- **Wiring de `app.ts` verificado** con composition test (lección W6: feature muerta por hook no inyectado).
- **Handlers async con catch explícito** → `next(err)` (no hay `express-async-errors`).
- **Permisos en las DOS capas:** FE (el botón solo con `pppoe.manage` via `useMyPermissions().can`) + BE (`requirePerm('pppoe','manage')` en la ruta de ids Y en el bulk).
- **DTOs sin password** (el endpoint de ids solo devuelve ids — trivial, pero el `select { id }` lo garantiza).
- **FE ui-ux-pro-max obligatoria** para la UI nueva (botón, aviso de lotes, checkbox de confirmación, progreso por lote); CSS Modules + tokens `var(--color-*)`; accesibilidad (contraste ≥4.5:1, touch ≥44px, focus visible, el checkbox de confirmación con label asociada).
- **TDD estricto:** cada task de código arranca por el test que falla.
- **Worktrees dedicados BE+FE + review adversarial** (mínimo 2 revisores — foco 1: chunking/agregación/fallo parcial de lote; foco 2: paridad list↔ids + contrato/UX). El bulk muta planes de clientes REALES en el RADIUS en caliente.
