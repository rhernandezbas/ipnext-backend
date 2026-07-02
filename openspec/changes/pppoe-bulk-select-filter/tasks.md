# Tasks: PPPoE — seleccionar TODO el filtro para el bulk cambio de plan (v2)

> TDD estricto (test primero, red → green → refactor). Apply en **worktree** BE (`feat/pppoe-bulk-select-filter`) + worktree FE coordinado, ambos desde `main` actual.
> Orden de dependencias: **BE endpoint de ids → FE fetch/congelamiento → FE chunking/agregación → FE rediseño del cap + confirmación → verificación → push gated por OK del usuario**.
> ⚠️ NO push sin OK. El bulk MUTA planes de clientes REALES en el RADIUS en caliente → review adversarial obligatorio (2 revisores).
> ⚠️ **NO tocar** el BE del bulk (`BulkChangePppoePlan`, `MAX_BULK_IDS=200`, `POST /pppoe/bulk/change-plan`) — se reusa tal cual. **NO tocar** el modal "Mover NAS", `MovePppoeToNas`, ni la page de auditoría (change paralelo `pppoe-move-nas`). Coordinar el merge de `PppoeManagementTab.tsx` + `app.ts` (zonas disjuntas).

## 1. BE — endpoint de ids del filtro (TDD, seam completo)

- [ ] 1.1 **(refactor primero, sin cambio de comportamiento)** Extraer el WHERE-builder inline de `PrismaPppoeServiceRepository.listAllPaginated` (`:206-243`) a un privado `buildListAllWhere(params: { search?, displayStatus?, nasId?, includeUnassigned? })`. `listAllPaginated` lo invoca para `findMany` + `count` (comportamiento IDÉNTICO). Los tests existentes de `listAllPaginated` deben seguir verdes (regresión).
- [ ] 1.2 **(test primero)** `PppoeServiceRepository.listAllIds(params)` en el port: mismos filtros que `listAllPaginated` SIN paginación → `{ ids: string[]; total: number }`. JSDoc: el WHERE es el MISMO que `listAllPaginated` (paridad garantizada por `buildListAllWhere`), orden estable `username asc`, `ids.length === total`.
- [ ] 1.3 **(green)** `PrismaPppoeServiceRepository.listAllIds`: `const where = buildListAllWhere(params); Promise.all([ findMany({ where, orderBy:{username:'asc'}, select:{ id:true } }), count({ where }) ])` → `{ ids: rows.map(r=>r.id), total }`.
- [ ] 1.4 **(green)** `InMemoryPppoeServiceRepository.listAllIds`: espejo EXACTO del filtrado de `listAllPaginated` (mismo helper `macSearch`, mismo `displayStatus`, mismo `contractId`/`nasId`), sin paginar → `{ ids, total }`.
- [ ] 1.5 **(PARITY TEST — el guardrail contra el drift, riesgo #1)** Mismo seed: barrer `listAllPaginated` por TODAS las páginas y juntar los ids → comparar como CONJUNTO con `listAllIds` para: sin filtro (solo `includeUnassigned`), por `search` (username/cliente/IP/MAC), por `nasId`, por `displayStatus`, y combinaciones (`search+nasId`, `nasId+status`, `search+status+nasId`). El conjunto debe ser idéntico y `total` debe coincidir. Correr contra Prisma-shape (in-memory) Y afirmar paridad Prisma↔in-memory.
- [ ] 1.6 **(test primero)** Use case `src/application/use-cases/ListAllPppoeServiceIds.ts`: normaliza `status`→`displayStatus` con la MISMA `isDisplayStatus` que `ListAllPppoeServices` (extraer helper compartido `normalizePppoeListFilters` O replicar con test que lo cubra); invoca `listAllIds`; devuelve `{ ids, total }`. Depende SOLO de `PppoeServiceRepository` (DIP). Tests: cada filtro, combinación, status desconocido→sin filtro (fail-open, igual que el listado).

## 2. BE — HTTP + wiring

- [ ] 2.1 **(test primero)** Ruta `GET /pppoe/ids` en `pppoe.routes.ts` (gate `canManage = requirePerm('pppoe','manage')`): parsea `search`/`status`/`nasId`/`includeUnassigned` de `req.query` (mismo patrón que `GET /pppoe` `:332-349`). **Precondición:** si NO hay ninguno de `{search, status, nasId}` → **400** `{ code:'FILTER_REQUIRED', error }` (ANTES de invocar el use case; `includeUnassigned` NO cuenta como filtro). Catch async EXPLÍCITO → `next(err)`. 200 → `{ ids, total }`.
- [ ] 2.2 **(test de seam)** Test ruta→use case REAL→repo in-memory (`GET /api/pppoe/ids`): por `nasId`, por `search` (IP/MAC/username), por `status`, combinaciones, **paridad con `GET /pppoe`** (mismo filtro → mismos ids que barrer el listado), sin filtro→400, sin permiso→403. NO mockear el use case (lección #28).
- [ ] 2.3 Wiring en `app.ts` (⚠️ **God Object**): construir `ListAllPppoeServiceIds` (con `pppoeRepo`) e inyectarlo en `createPppoeRouter`. + **composition test** (anti "feature muerta", lección W6): la ruta `GET /pppoe/ids` vive, el use case cableado con el repo real, responde (no 404 de ruta).

## 3. FE — fetch de ids + congelamiento del set (worktree coordinado)

- [ ] 3.0 **ARRANCAR POR AQUÍ (en el repo FE):** correr `python .claude/skills/ui-ux-pro-max/scripts/search.py "data table select-all-filtered bulk action batch progress confirmation checkbox destructive toolbar" --design-system` y aplicar el design system devuelto (CSS Modules + tokens `var(--color-*)`; accesibilidad: contraste ≥4.5:1, touch ≥44px, focus visible). NADA de UI nueva antes de este paso.
- [ ] 3.1 **(test primero)** `pppoeApi.listIds(filter: PppoeServiceListFilter): Promise<{ ids: string[]; total: number }>` en `pppoe.api.ts` → `GET /pppoe/ids`, mapeando filtros vacíos fuera del query (mismo patrón que `pppoeApi.list`, incl. `includeUnassigned`).
- [ ] 3.2 **(test primero)** Hook on-demand para el fetch de ids en `usePppoe.ts` (`useMutation` o equivalente imperativo, NO `useQuery` cacheado): expone `isPending`/`isError` para el botón. Al éxito devuelve `{ ids, total }` al caller (no invalida nada — es una lectura).
- [ ] 3.3 **Botón "Seleccionar los N del filtro":** en `PppoeManagementTab.tsx` — visible SOLO cuando `canManage && (search || nasId || status)` (filtro activo). Label con `N = total` del listado. Al clic → fetch ids → `setSelected(new Set(ids))` (congela). Spinner/disabled mientras `isPending`; error inline si falla.
- [ ] 3.4 **(verificar el invariante de congelamiento)** Confirmar que `handleSearch`/`handleNas`/`handleStatus` (`:781-783`) siguen haciendo `setSelected(new Set())` → cambiar cualquier filtro tras seleccionar LIMPIA la selección congelada. NO agregar persistencia de selección cross-filtro.

## 4. FE — chunking + envío secuencial + agregación

- [ ] 4.1 **(test primero, helper PURO)** `chunk<T>(arr: T[], size: number): T[][]` (util puro, sin React): `chunk([...340], 200)` → `[[200],[140]]`; borde vacío, exacto múltiplo, size≥len (un solo lote). Test unitario aislado.
- [ ] 4.2 **(test primero)** Orquestador secuencial del bulk (reemplaza el `handleBulkConfirm` de un solo request): parte `Array.from(selected)` en lotes de 200; los manda **de a uno** (`await` por lote) reusando `bulkChangePlan(lote, profile, reason)`; **agrega** `{ ok, failed }` cross-lote; **progreso** "lote i/n — N servicios". Test con `bulkChangePlan` fake: 340→2 lotes, agregación correcta, ítems `failed` de ambos lotes concatenados.
- [ ] 4.3 **(test primero)** Política de **fallo de lote entero**: si `bulkChangePlan` de un lote RECHAZA (red/500) → cortar los lotes restantes, exponer el agregado PARCIAL + un estado de corte `{ cutAtBatch, totalBatches }`. Test: 3 lotes, el 2º rechaza → ok/failed del lote 1 presentes, lotes 2-3 NO se mandan, mensaje de corte visible. Distinguir de ítems `failed` (que NO cortan).
- [ ] 4.4 **Resumen agregado:** tras el envío (completo o cortado), mostrar `ok` (total exitosos) + `failed` (lista `username`+`error`) + (si hubo corte) el aviso de lote cortado. Limpiar de la selección los ids OK (patrón actual `:826-832`, aplicado al agregado).

## 5. FE — rediseño del cap W1 + confirmación N>200

- [ ] 5.1 **Rediseño del toolbar:** quitar el bloqueo `overSelectionCap` (`:740`, `:985-992`). N>200 ya NO deshabilita el botón. El toolbar informa: N≤200 → "N seleccionados"; N>200 → "N seleccionados — se enviará en X lotes de 200" (`X = Math.ceil(N/200)`). Botón habilitado en ambos casos.
- [ ] 5.2 **Checkbox de confirmación N>200:** en el modal bulk, cuando `selected.size > 200`, checkbox obligatorio "Entiendo que voy a cambiar el plan de N servicios" que **gatea** el botón confirmar (disabled hasta tildar). N≤200 → sin checkbox (flujo intacto). Label asociada al input (accesibilidad).
- [ ] 5.3 **(REESCRITURA HONESTA de los tests W1)** `PppoeManagementTab.bulk.test.tsx:370-413`: reemplazar "201 → aria-disabled + máximo 200" por "201 → botón habilitado + 'se enviará en 2 lotes' + checkbox de confirmación requerido para confirmar". Reescribir "200 → habilitado" a la variante nueva (sin checkbox). NO borrar asserts silenciosamente — el diff muestra el cambio de expectativa de spec.
- [ ] 5.4 **(tests FE, Vitest)** botón "Seleccionar los N del filtro": aparece solo con filtro activo + `pppoe.manage`, invisible sin filtro o sin permiso; clic → congela el set (hook llamado con los filtros vigentes, `selected` = ids devueltos); cambiar filtro tras seleccionar → selección limpia; aviso de lotes >200; checkbox N>200 gatea confirm; chunking 340→2 lotes (mock del api); agregación ok/failed; corte por fallo de lote. + typecheck.

## 6. Verificación

- [ ] 6.1 `npm test` verde (BE) + `tsc --noEmit` limpio. Suite FE verde + typecheck.
- [ ] 6.2 **DIP:** `ListAllPppoeServiceIds` depende del port; `application/` y `domain/` no importan Prisma/axios/Express. `buildListAllWhere` queda en el adapter (infra).
- [ ] 6.3 **Paridad list↔ids:** el parity test verde por cada filtro y combinación (mismo seed → mismo conjunto). Congelado en el spec.
- [ ] 6.4 **Contrato BE↔FE:** confirmar campo-por-campo el shape `{ ids, total }` + el 400 `FILTER_REQUIRED` + el 403 (lección W6). Congelado en el spec.
- [ ] 6.5 **Review adversarial** (judgment-day / opus) — **mínimo 2 revisores**, escala de mutación mayor (el bulk muta cientos de clientes reales):
  - **R1 — chunking / agregación / fallo parcial de lote:** envío secuencial (no paralelo), agregación `{ ok, failed }` cross-lote correcta, corte por rechazo de lote entero (vs ítems `failed` que no cortan), progreso por lote, checkbox N>200 gatea confirm, tope de 200 por request respetado.
  - **R2 — paridad list↔ids + contrato/UX:** WHERE compartido (no drift), normalización de status compartida, parity test real, gate `pppoe.manage` en las dos capas, 400 sin filtro, congelamiento anti-TOCTOU, wiring vivo en `app.ts` (composition test), tests W1 reescritos honestamente.

## 7. Salida de fase — push gated

- [ ] 7.1 **PRE-DEPLOY:** confirmar que `buildListAllWhere` no cambió el comportamiento de `listAllPaginated` (regresión verde del listado) y que `pppoe.manage` gatea el endpoint de ids en las dos capas.
- [ ] 7.2 **Coordinación merge con `pppoe-move-nas`:** rebasar ordenado; resolver conflictos de `PppoeManagementTab.tsx` + `app.ts` manteniendo AMBAS features (zonas disjuntas).
- [ ] 7.3 Merge BE+FE coordinado a `main` + push (= prod). **Requiere OK explícito del usuario.** Deploy verde (sin migración de schema).
- [ ] 7.4 Validación LIVE acotada: filtrar por un NAS chico, "Seleccionar los N del filtro", verificar N = total; ejecutar un bulk >200 sobre un NAS de PRUEBA (o pocos servicios reales) y confirmar el envío en lotes + agregación. NO un NAS grande de clientes reales en la primera pasada.
- [ ] 7.5 Actualizar BACKLOG + engram (`sdd/pppoe-bulk-select-filter/*`) con el resultado en prod. `sdd-archive` del change.
