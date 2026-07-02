# Tasks: PPPoE — búsqueda por IP/MAC + bulk cambio de plan

> TDD estricto (test primero, red → green → refactor). Apply en **worktree** BE (`feat/pppoe-search-bulk-plan`) + worktree FE coordinado.
> Orden de dependencias: **BE search → BE refactor compartido → BE bulk → FE → verificación → push gated por OK del usuario**.
> ⚠️ NO push sin OK. El bulk MUTA planes de clientes REALES en el RADIUS en caliente → review adversarial obligatorio.
> ⚠️ **NO tocar** el modal "Mover NAS", `MovePppoeServiceToRouter`/`MovePppoeToNas`, ni la page de auditoría (change paralelo `pppoe-move-nas`). Coordinar el merge de `PppoeManagementTab.tsx` + `app.ts` (zonas disjuntas).

## 1. BE — Parte 1: búsqueda por IP y MAC (TDD, seam completo)

- [ ] 1.1 **(test primero)** Helper de dominio puro `src/domain/services/macSearch.ts`: `looksLikeMac(search)` + `macSearchVariants(search)` → `['raw', 'aa:bb:...', 'aa-bb-...', 'aabb...']` (lowercase, tras quitar separadores `[:.\-\s]`). Test unitario puro de los 3 formatos + parcial + no-MAC.
- [ ] 1.2 **(test primero)** `PppoeServiceRepository.listAllPaginated` — extender el contrato del `search`: además de username/cliente, matchea `remoteAddress` (contains) y `callerId` (variantes de MAC en OR). Actualizar el JSDoc del port (`PppoeServiceRepository.ts:80-105`).
- [ ] 1.3 **(green)** `PrismaPppoeServiceRepository.listAllPaginated` (`:215-221`): sumar al `OR` del search `{ remoteAddress: { contains, mode:'insensitive' } }` incondicional + (si `looksLikeMac`) un `{ callerId: { contains: variante, mode:'insensitive' } }` por cada variante. Mantener el `AND` de fragmentos intacto (no colisionar con `displayStatus`/`contractId`).
- [ ] 1.4 **(green)** `InMemoryPppoeServiceRepository.listAllPaginated` (`:177-232`): espejo EXACTO — matchea `remoteAddress` + `callerId` normalizado con el MISMO helper `macSearch`. Test de paridad Prisma↔in-memory (misma semántica).
- [ ] 1.5 **(test primero)** `PppoeServiceListItemDto` (`pppoe.dto.ts`) + `callerId: string | null`; `ListAllPppoeServices.toDto` (`:132-155`) incluye `callerId` (el repo ya lo selecciona en `:246`). Confirmar que el DTO sigue sin `password`.
- [ ] 1.6 **(test de seam)** Test ruta→use case REAL→repo in-memory (`GET /api/pppoe?search=`): IP exacta, IP parcial, MAC en los 3 formatos, MAC parcial, `callerId=null` no matchea, regresión username, regresión cliente. NO mockear el use case (lección #28).

## 2. BE — Parte 2a: refactor compartido `ChangePppoePlanService` (TDD, contrato PATCH intacto)

- [ ] 2.1 **(test primero)** `src/application/services/ChangePppoePlanService.ts` (capa APPLICATION — orquesta ports, el dominio queda puro; decisión del orquestador 2026-07-01): `changePlan({ service, nas, profile, reason, actorId, actorName })` — rutea por `nas.type` (orchestrator `changePlan` con `applyInSession:true` / `router.updateSecret`), upsert DB, evento `'modified'` best-effort con `<old> → <new>`. Ports por constructor (DIP). Tests con InMemory + fake gateway, modo orchestrator Y router.
- [ ] 2.2 **(green + regresión)** Refactor `UpdatePppoeService` (`:56-101`) para delegar el sub-caso `profile` a `ChangePppoePlanService`, SIN cambiar el comportamiento observable del PATCH. **Tests de regresión del PATCH** (mismo ruteo, mismo `applyInSession`, mismo evento). Si la extracción resulta no-separable → fallback Opción A (bulk invoca `UpdatePppoeService` per-item) y documentar en `apply-progress` (design Decisión 5).
- [ ] 2.3 Verificar wiring de `UpdatePppoeService` en `app.ts` (~`:2215`) tras el refactor: si `ChangePppoePlanService` se inyecta, cablearlo con los mismos repos/gateways; si se instancia interno, no romper la firma.

## 3. BE — Parte 2b: `BulkChangePppoePlan` (TDD)

- [ ] 3.1 **(test primero)** `BulkChangePlanBodySchema` (Zod, `pppoe.dto.ts`): `{ ids: z.array(z.string().min(1)).min(1), profile: z.string().min(1), reason: z.string().nullish() }`. + `BulkChangePlanResultDto` `{ ok: string[], failed: { id, username, error }[] }`.
- [ ] 3.2 **(test primero)** `src/application/use-cases/BulkChangePppoePlan.ts`: dedup `ids`; tope >200 → error de dominio (`BulkTooLargeError`); `PlanRepository.findByCode(profile)` fail-fast → `PlanNotFoundError` (cero mutación); resolver filas (id inexistente → `failed` `PPPOE_NOT_FOUND`); agrupar por `nasId`; `mapWithConcurrency` con carriles seriales + throttle; invocar `ChangePppoePlanService` por ítem; best-effort → `{ ok, failed }`. Ports por constructor (DIP).
- [ ] 3.3 **(tests del use case)** bulk feliz, ítem que falla (lote sigue), id inexistente, plan inexistente (fail-fast cero mutación), bulk vacío (error dominio), tope excedido, evento `'modified'` por ítem OK, ítem sin contrato no registra evento. InMemory + fake gateway.

## 4. BE — Parte 2c: HTTP + wiring

- [ ] 4.1 **(test primero)** Ruta `POST /pppoe/bulk/change-plan` en `pppoe.routes.ts` (gate `canManage = requirePerm('pppoe','manage')`): Zod `safeParse` → 400/422; **catch async EXPLÍCITO** (no hay express-async-errors); mapeo `PlanNotFoundError`→422, `BulkTooLargeError`→422; body-inválido→400/422; respuesta 200 `{ ok, failed }`. Actor vía `actorOf(req)`.
- [ ] 4.2 **(test de seam)** Test ruta→use case REAL→repos in-memory: feliz, ítem falla, plan inexistente (422), sin permiso (403), vacío (400). NO mockear el use case.
- [ ] 4.3 Wiring en `app.ts` (⚠️ **God Object**): construir `BulkChangePppoePlan` (con `pppoeRepo`, `PrismaPlanRepository`, `ChangePppoePlanService`) e inyectarlo en `createPppoeRouter`. + **composition test** (anti "feature muerta", lección W6): la ruta vive, el use case cableado con repos reales, responde (no 404 de ruta).

## 5. FE (`ipnext-frontend`, worktree coordinado) — skill ui-ux-pro-max OBLIGATORIA

- [ ] 5.0 **ARRANCAR POR AQUÍ (en el repo FE):** correr `python .claude/skills/ui-ux-pro-max/scripts/search.py "networking data table row multi-select bulk action toolbar confirmation modal plan dropdown" --design-system` y aplicar el design system devuelto (CSS Modules + tokens `var(--color-*)`; accesibilidad: contraste ≥4.5:1, touch ≥44px, focus visible). NADA de UI nueva antes de este paso.
- [ ] 5.1 **Search:** `PppoeManagementTab.tsx` — cambiar SOLO el placeholder del input (`:639-644`) a `"Buscar usuario, cliente, IP, MAC…"`. El `?search=` + debounce 300ms quedan intactos.
- [ ] 5.2 **Tipos + API:** `types/internetService.ts` `PppoeServiceListItem` + `callerId?: string | null`. `pppoe.api.ts` + `bulkChangePlan(ids, profile, reason?)` → `POST /pppoe/bulk/change-plan`, retorno `{ ok, failed }`.
- [ ] 5.2b **Columna MAC (decisión del usuario 2026-07-01):** columna "MAC" en la tabla mostrando `callerId` (compacta, mismo tratamiento tipográfico que la columna IP); `null` → "—" accesible (patrón NoData, `aria-label="Sin dato"`), nunca string vacío.
- [ ] 5.3 **(test primero)** Hook `useBulkChangePppoePlan` en `usePppoe.ts`: `useMutation` que llama `pppoeApi.bulkChangePlan` e invalida `['pppoe','list']` (`GLOBAL_LIST_KEY`).
- [ ] 5.4 **Selección múltiple (patrón NUEVO):** en `PppoeManagementTab.tsx` — `useState<Set<string>>` para ids seleccionados; checkbox por fila (1ª columna nueva) + checkbox de header "seleccionar página" (marca/desmarca los ids de la página actual); **todo gateado por `canManage`** (no aparece sin `pppoe.manage`). Crear componente `Checkbox` accesible (no existe en atoms) — o `<input type="checkbox">` con label accesible.
- [ ] 5.5 **Toolbar contextual:** aparece cuando `selected.size > 0`: "N seleccionados — Cambiar plan | Limpiar". Gate `canManage`.
- [ ] 5.6 **Modal bulk (copiar patrón `EditPppoeModal` inline):** dropdown de planes (reusa `usePlans` + filtro `p.status==='enabled' && p.category!=='Corte'`, `:557`) + input `reason` opcional + confirmación. Error INLINE (patrón `styles.partialAlert`, role=alert), NO toast. Al confirmar → `useBulkChangePppoePlan`.
- [ ] 5.7 **Resumen del resultado:** tras el bulk, mostrar `ok` (N exitosos) y `failed` (lista con `username` + `error` por fila). Limpiar la selección de los OK.
- [ ] 5.8 **(tests FE, Vitest):** placeholder actualizado; columna MAC (con valor y con `null` → "—"); selección/deselección + "seleccionar página"; toolbar aparece/desaparece; modal → confirmación → hook llamado con el body correcto; render del resumen ok/failed; gate (sin `pppoe.manage` no hay checkboxes ni toolbar). + typecheck.

## 6. Verificación

- [ ] 6.1 `npm test` verde (BE) + `tsc --noEmit` limpio. Suite FE verde + typecheck.
- [ ] 6.2 **DIP:** `ChangePppoePlanService`, `BulkChangePppoePlan`, `macSearch` dependen de ports / son puros; `application/` y `domain/` no importan Prisma/axios/Express.
- [ ] 6.3 **Contrato BE↔FE:** confirmar campo-por-campo el shape `{ ok, failed }` + `callerId` en el DTO/tipo (lección W6). Congelado en el spec.
- [ ] 6.4 **Review adversarial** (judgment-day / opus) — **mínimo 2 revisores** con focos distintos:
  - **R1 — mutación / bulk-semantics:** best-effort correcto (un fallo no aborta), fail-fast del plan (cero mutación), CoA `applyInSession` (no dropea sesión), throttle/agrupación por router, evento de historial por ítem, tope de ids.
  - **R2 — contrato / wiring:** wiring vivo en `app.ts` (composition test), catch async explícito, permisos en las dos capas, DTO sin password, drift BE↔FE, refactor de `UpdatePppoeService` sin romper el PATCH.

## 7. Salida de fase — push gated

- [ ] 7.1 **PRE-DEPLOY:** confirmar que el refactor de `UpdatePppoeService` no cambió el comportamiento del `PATCH /api/pppoe/:id` (regresión verde) y que `pppoe.manage` gatea el bulk en las dos capas.
- [ ] 7.2 **Coordinación merge con `pppoe-move-nas`:** rebasar ordenado; resolver conflictos de `PppoeManagementTab.tsx` + `app.ts` manteniendo AMBAS features (zonas disjuntas).
- [ ] 7.3 Merge BE+FE coordinado a `main` + push (= prod). **Requiere OK explícito del usuario.** Deploy verde (sin migración de schema — `callerId` ya existe).
- [ ] 7.4 Validación LIVE acotada: buscar por IP/MAC real; bulk sobre 2-3 servicios de PRUEBA (no un lote grande de clientes reales en la primera pasada).
- [ ] 7.5 Actualizar BACKLOG + engram (`sdd/pppoe-search-bulk-plan/*`) con el resultado en prod. `sdd-archive` del change.
