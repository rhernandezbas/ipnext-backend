# Proposal: PPPoE — seleccionar TODO el filtro para el bulk cambio de plan (v2)

## Intent

Evolución v2 del change **`pppoe-search-bulk-plan`** (EN PROD desde hoy). El bulk cambio de plan hoy solo permite seleccionar por checkboxes de la **página actual** (25 filas). El operador necesita cambiarle el plan a **TODO un NAS** (cientos de servicios). Este change agrega:

1. **Botón "Seleccionar los N del filtro"** en el tab PPPoE de Gestión de Red (`PppoeManagementTab`), visible **SOLO** cuando hay un filtro activo (`nasId`, `search` o `status` — al menos uno) **Y** el usuario tiene `pppoe.manage`. Al hacer clic, el FE resuelve los ids que matchean el filtro EN ESE MOMENTO y los **congela** en la selección.

2. **Endpoint BE nuevo `GET /api/pppoe/ids`** (gate `pppoe.manage`) que acepta **los mismos filtros** que `GET /api/pppoe` y devuelve un payload liviano `{ ids: string[], total: number }`. La semántica del `where` es **IDÉNTICA** a la del listado (mismo builder de WHERE + parity test), para que lo que el operador VE listado sea EXACTAMENTE lo que se selecciona.

3. **Envío en CHUNKS de 200 secuenciales** reutilizando `POST /api/pppoe/bulk/change-plan` **tal cual está** (el tope de 200 por request NO se toca). El FE parte la selección en lotes de ≤200, los manda **de a uno** (no en paralelo — no castigar al RADIUS), muestra progreso por lote y **agrega** el resultado `{ ok, failed }` de todos los lotes en un resumen único.

4. **Rediseño del aviso de tope** (fix W1 del change padre): >200 seleccionados **ya no bloquea** el botón — informa "N seleccionados — se enviará en X lotes de 200". Para N>200 se exige un **checkbox de confirmación** obligatorio. Para N≤200 el flujo actual queda intacto.

## Why

- **Caso real:** el operador filtró por un NAS, tocó "seleccionar todos" y el checkbox de header le seleccionó **25** (la página). Necesita los **~cientos** del NAS para una recategorización masiva. Hoy tendría que paginar 20 veces marcando de a 25 — inviable.
- **El dato ya existe:** el listado ya resuelve el `where` filtrado (`listAllPaginated`). Falta un endpoint hermano que devuelva **solo los ids** de ese mismo `where`, sin la proyección pesada (JOIN cliente + enriquecimiento `createdBy`/`nasName`). Costo BAJO: reusar la construcción del WHERE + un `select { id }`.
- **La mutación ya existe y está probada:** `POST /api/pppoe/bulk/change-plan` (best-effort agrupado por router, tope 200, `{ ok, failed }`) está EN PROD. Este change **compone lo que ya hay** del lado FE (chunking + agregación) y agrega **una sola** superficie BE nueva (el endpoint de ids). NO reinventa el bulk ni toca su guard de 200.

## Scope

### In Scope

**BE — endpoint de ids del filtro:**
- Port `PppoeServiceRepository`: método nuevo `listAllIds(params)` que acepta los MISMOS filtros que `listAllPaginated` (`search`, `displayStatus`, `nasId`, `includeUnassigned`) SIN paginación, y devuelve `{ ids: string[], total: number }`. La construcción del `where` se **comparte** con `listAllPaginated` (ver `design.md` Decisión 1).
- Impls **Prisma** (`select { id }` + `count` con el MISMO where) e **in-memory** (espejo exacto), en sincronía.
- Use case nuevo `ListAllPppoeServiceIds` (liviano): normaliza el `status` de negocio a `displayStatus` con la MISMA lógica que `ListAllPppoeServices`, invoca `listAllIds`, devuelve `{ ids, total }`. NO enriquece (sin `createdBy`/`nasName`).
- Ruta `GET /api/pppoe/ids` (gate `pppoe.manage`): precondición **al menos un filtro** de `{search, status, nasId}` presente → si no, **400** `FILTER_REQUIRED` (el endpoint existe para selección filtrada, no para "todo el sistema"). Catch async explícito. Wiring en `app.ts` + composition test.

**FE (`ipnext-frontend`, worktree coordinado) — skill ui-ux-pro-max OBLIGATORIA:**
- **Botón "Seleccionar los N del filtro"**: visible solo con filtro activo (`search || nasId || status`) Y `pppoe.manage`. Al clic → fetch `GET /api/pppoe/ids` con los filtros vigentes → **congela** los ids en la selección (`setSelected(new Set(ids))`). Estado de carga/errores en el botón.
- **Helper puro de chunking** (`chunk(ids, 200)`) + **envío secuencial** de lotes reutilizando `bulkChangePlan` por lote, con **progreso por lote** ("lote 2/3 — 340 servicios") y **agregación** `{ ok, failed }` cross-lote en un resumen único.
- **Política de fallo de lote entero** (rechazo de red/500, NO ítems `failed`): **cortar** los lotes restantes y mostrar el agregado **parcial** + error claro.
- **Rediseño del cap W1**: >200 ya no bloquea; informa "N seleccionados — se enviará en X lotes de 200". Para N>200, **checkbox obligatorio** "Entiendo que voy a cambiar el plan de N servicios" que gatea el confirm. N≤200 sin cambios.
- Api client `pppoeApi.listIds(filter)` + hook para el fetch on-demand de ids.

### Out of Scope

- **NO se toca el BE del bulk** (`POST /api/pppoe/bulk/change-plan`, `BulkChangePppoePlan`, `MAX_BULK_IDS=200`). El tope de 200 sigue siendo un guard **por request**; el FE lo respeta partiendo en chunks.
- **NO selección global sin filtro** — el endpoint de ids REQUIERE al menos un filtro (`400` si no hay). Nunca "seleccionar todos los del sistema".
- **NO resolver el filtro server-side al ejecutar** (anti-TOCTOU): el set se **congela** en el FE al seleccionar. El bulk muta EXACTAMENTE los ids capturados, nunca re-resuelve el filtro al confirmar (no tocar servicios que el operador nunca vio).
- **NO se toca el modal "Mover NAS" ni `MovePppoeToNas`** — es del change paralelo `pppoe-move-nas`. Comparten `PppoeManagementTab.tsx` y `app.ts` en zonas disjuntas (ver `design.md` Coordinación).
- **NO se toca la búsqueda por IP/MAC ni la columna MAC** — ya landearon en el change padre. Este change las reusa tal cual.
- **Bulk async poleable** (job persistido): fuera de scope; el envío sigue siendo síncrono por lote.

## Capabilities

### New Capabilities

- `pppoe-bulk-select-filter`: seleccionar TODOS los servicios PPPoE que matchean un filtro activo (endpoint de ids congelable) y aplicarles el cambio de plan masivo en lotes de 200 secuenciales, con progreso y resumen agregado.

### Modified Capabilities

- `pppoe-management`: la lista global gana un endpoint hermano `GET /api/pppoe/ids` (mismos filtros, payload liviano). Aditivo — el listado paginado no cambia.
- `pppoe-search-bulk-plan`: el aviso de tope (>200 → bloqueado) se **reemplaza** por el envío en lotes. El comportamiento observable del cap cambia de spec (el operador ya PUEDE ejecutar >200).

## Approach

1. **BE ids (TDD, seam completo):** extraer el builder de WHERE de `listAllPaginated` a un privado compartido; agregar `listAllIds` (Prisma + in-memory) que lo reusa. Use case `ListAllPppoeServiceIds` con la MISMA normalización de status. Ruta `GET /pppoe/ids` (gate `pppoe.manage`, precondición de filtro → 400). **Parity test:** mismo seed → el conjunto de ids del listado (sin paginar) === el conjunto que devuelve `/ids`, por cada filtro y combinación.
2. **FE fetch de ids:** `pppoeApi.listIds` + hook on-demand; botón "Seleccionar los N del filtro" que congela el set.
3. **FE chunking + envío secuencial:** helper puro `chunk` + orquestador secuencial que agrega `{ ok, failed }` y corta ante fallo de lote entero; progreso por lote.
4. **FE rediseño del cap + confirmación:** el toolbar informa lotes en vez de bloquear; checkbox obligatorio para N>200.
5. **Verificación:** `npm test` BE verde + `tsc --noEmit` limpio; suite FE + typecheck (incl. **reescritura honesta** de los tests W1 201→disabled); review adversarial 2 revisores (foco 1: chunking/agregación/fallo parcial de lote — foco 2: paridad list↔ids + contrato/UX); push gated por OK del usuario.

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/domain/ports/PppoeServiceRepository.ts` | Modified | Método nuevo `listAllIds(params)`: mismos filtros que `listAllPaginated` sin paginación → `{ ids, total }`. JSDoc del WHERE compartido. |
| `src/infrastructure/adapters/prisma/PrismaPppoeServiceRepository.ts` | Modified | Extraer `buildListAllWhere(params)` (hoy inline `:206-243`); `listAllPaginated` lo reusa; `listAllIds` = `findMany({ where, select:{id:true}, orderBy })` + `count({ where })`. |
| `src/infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository.ts` | Modified | Espejo exacto de `listAllIds` con el MISMO filtrado que `listAllPaginated` (mismo helper `macSearch` + status). |
| `src/application/use-cases/ListAllPppoeServiceIds.ts` | New | Use case liviano: normaliza `status`→`displayStatus` (misma lógica que `ListAllPppoeServices`), invoca `listAllIds`, devuelve `{ ids, total }`. Sin enriquecimiento. |
| `src/infrastructure/http/routes/pppoe.routes.ts` | Modified | `GET /pppoe/ids` (gate `pppoe.manage`, precondición ≥1 filtro → 400 `FILTER_REQUIRED`, catch async explícito). |
| `src/infrastructure/http/app.ts` | Modified | ⚠️ **God Object** — wiring de `ListAllPppoeServiceIds` en el router pppoe + composition test. |
| `ipnext-frontend` (`PppoeManagementTab.tsx`) | Modified | Botón "Seleccionar los N del filtro" + congelamiento + rediseño del cap (lotes en vez de bloqueo) + checkbox de confirmación N>200. **NO el modal Mover NAS.** |
| `ipnext-frontend` (`pppoe.api.ts`, `usePppoe.ts`) | Modified | `listIds(filter)` → `GET /pppoe/ids`; hook on-demand de ids. |
| `ipnext-frontend` (helper de chunking + envío secuencial) | New | `chunk(ids, size)` puro + orquestación secuencial con agregación `{ ok, failed }` y corte por fallo de lote. |
| `ipnext-frontend` (`PppoeManagementTab.bulk.test.tsx`) | Modified | **Reescritura honesta** de los tests W1 (201→disabled): ahora 201→habilitado + "2 lotes" + checkbox de confirmación. |

> **Splynx:** este cambio NO agrega dependencias de Splynx (constraint respetado).

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| **Drift list↔ids**: el operador selecciona un conjunto distinto al que ve listado | Alta | WHERE **compartido** por `listAllPaginated` + `listAllIds` (un solo `buildListAllWhere`); normalización de `status` compartida; **parity test** por cada filtro y combinación (mismo seed → mismo conjunto) |
| **TOCTOU**: entre seleccionar y ejecutar, el filtro cambia y se mutan servicios que el operador no vio | Media | Set **congelado** en el FE al seleccionar; el bulk manda ids literales; el filtro NO se re-resuelve al ejecutar. Cambiar el filtro tras seleccionar **limpia** la selección (comportamiento actual) |
| **Castigar al RADIUS** con envíos paralelos de cientos | Media | Envío **secuencial** de lotes (uno por vez); cada lote reusa el bulk que ya agrupa por router con throttle; tope de 200 por request intacto |
| **Fallo de lote entero** deja el resto sin ejecutar y sin feedback | Media | Política explícita: rechazo de lote entero (red/500) → **cortar** los lotes restantes + mostrar agregado **parcial** + error claro (ver `design.md` Decisión 5) |
| **Feature muerta** por hook/wiring no inyectado (lección W6) | Media | Composition test del `GET /pppoe/ids` en `app.ts` (ruta viva, use case cableado, no 404) |
| **Regresión del cap W1**: los tests 201→disabled quedan obsoletos y se "debilitan" en vez de reescribirse | Media | Reescritura **honesta**: el comportamiento cambia de spec; los tests nuevos afirman 201→habilitado + lotes + checkbox, NO se borran silenciosamente |
| **Endpoint de ids sin gate correcto** filtra afordancia de bulk a read-only | Baja | Gate `pppoe.manage` (NO `pppoe.read`): el endpoint existe solo para alimentar la mutación `pppoe.manage`; 403 sin permiso |
| Conflicto de merge con `pppoe-move-nas` en `PppoeManagementTab.tsx` / `app.ts` | Media | Zonas disjuntas (Coordinación en `design.md`); rebase ordenado; worktrees dedicados |
| Handler async sin catch cuelga la request (no hay express-async-errors) | Baja | Catch explícito → `next(err)` en `GET /pppoe/ids` (patrón del resto de `pppoe.routes.ts`) |

## Rollback

- **BE:** todo aditivo. `git revert` del use case `ListAllPppoeServiceIds` + la ruta `GET /pppoe/ids` + `listAllIds` en ambos adapters + el wiring. La extracción de `buildListAllWhere` se revierte re-inline en `listAllPaginated` (comportamiento idéntico). Sin migración de schema.
- **FE:** `git revert` del botón + chunking + rediseño del cap. El toolbar vuelve al bloqueo >200 del change padre.
- **Sin estado persistido nuevo:** no hay tabla ni columna → rollback limpio.

## Dependencies

- Change padre `pppoe-search-bulk-plan` EN PROD (endpoint `POST /pppoe/bulk/change-plan`, `MAX_BULK_IDS=200`, DTO `{ ok, failed }`). Este change lo reusa **sin tocarlo**.
- `pppoe.manage` en el catálogo RBAC (ya existe).
- Coordinación con `pppoe-move-nas` (sesión paralela) para el merge de `PppoeManagementTab.tsx` + `app.ts`.

## Success Criteria

- [ ] `GET /api/pppoe/ids` devuelve `{ ids, total }` para cada filtro (`search`, `status`, `nasId`) y sus combinaciones.
- [ ] **Paridad list↔ids:** mismo seed → el conjunto de ids del listado (todas las páginas) === el conjunto de `/ids`, por cada filtro.
- [ ] **Sin filtro activo:** `GET /pppoe/ids` sin `search`/`status`/`nasId` → **400** `FILTER_REQUIRED`, cero resultados.
- [ ] **Gate:** `GET /pppoe/ids` sin `pppoe.manage` → **403**.
- [ ] **FE botón:** "Seleccionar los N del filtro" aparece SOLO con filtro activo + `pppoe.manage`; congela el set.
- [ ] **Congelamiento:** cambiar el filtro después de seleccionar **limpia** la selección (no muta servicios no vistos).
- [ ] **Chunking:** 340 seleccionados → **2 lotes** (200 + 140) secuenciales; agregación `{ ok, failed }` cross-lote en un resumen único.
- [ ] **Fallo de lote entero:** rechazo de red/500 en un lote → corta los restantes, muestra agregado parcial + error.
- [ ] **Confirmación N>200:** checkbox obligatorio "Entiendo que voy a cambiar el plan de N servicios" gatea el confirm.
- [ ] **N≤200:** flujo actual intacto (un solo request, sin checkbox extra).
- [ ] **Aviso de lotes:** >200 informa "N seleccionados — se enviará en X lotes de 200" (NO bloquea).
- [ ] Test de **seam completo** (ruta→use case real→repo in-memory) del endpoint de ids + **parity test**. `npm test` verde + `tsc --noEmit` limpio.
- [ ] **Wiring** de `app.ts` verificado con composition test. **DIP preservado.**
- [ ] Contrato **BE↔FE campo-por-campo** en el spec, congelado.
- [ ] Tests W1 **reescritos honestamente** (no debilitados).
