# Proposal: PPPoE — búsqueda por IP/MAC + bulk cambio de plan (selección por checkboxes)

## Intent

Dos mejoras al tab **PPPoE de Gestión de Red** (`PppoeManagementTab`), pedido del usuario, que comparten página y hook de datos:

1. **Búsqueda por IP y por MAC** en el mismo input de búsqueda existente. Hoy el `search` matchea solo **username + nombre del cliente**. Se extiende a **`remoteAddress` (IP)** y **`callerId` (MAC del CPE, que sobrevive a la desconexión)** — sin agregar tabs ni cambiar la UX del input: el operador escribe una IP o una MAC y el sistema la encuentra.

2. **Cambio de plan MASIVO** sobre filas **explícitamente seleccionadas** (checkboxes por fila + "seleccionar página"), NO "todos los del filtro" (decisión del usuario). Un endpoint nuevo `POST /api/pppoe/bulk/change-plan` cambia el plan de N servicios reusando la lógica de cambio de plan de `UpdatePppoeService` (ruteo por `nas.type` → orchestrator `changePlan` con CoA caliente / `router.updateSecret`), con ejecución best-effort agrupada por router (patrón `RunBulkEnforcement`) y respuesta por-ítem `{ ok, failed }`.

## Why

- **Búsqueda por IP/MAC — caso real:** el operador ve una IP en un log/ticket o una MAC en el ACS/antena y necesita llegar al cliente. Hoy el único camino es username/nombre → si no los tiene, no lo encuentra. La MAC (`callerId`) ya está persistida en `PppoeService` (sobrevive a la desconexión) y la IP (`remoteAddress`) también — **el dato ya existe, solo falta buscarlo**. Costo BAJO: extender un `OR` que ya está en el WHERE.
- **Bulk cambio de plan — caso real:** subir/bajar de plan a un grupo de clientes (promo, recategorización de un nodo, corrección masiva) hoy es fila-por-fila con el modal de editar → tedioso y propenso a error. La lógica de cambio de plan **ya existe y está probada** en `UpdatePppoeService` (CoA caliente vía orchestrator, evento de historial con actor+reason). El patrón de ejecución masiva **también existe** en `RunBulkEnforcement` (agrupar por router, carriles seriales, N routers en paralelo, throttle, best-effort). Este change **compone lo que ya hay**, no inventa infraestructura.

## Scope

### In Scope

**BE — Parte 1 (search IP/MAC):**
- Extender el `search` de `ListAllPppoeServices` / `PppoeServiceRepository.listAllPaginated` para matchear también **`remoteAddress`** (IP, parcial) y **`callerId`** (MAC, en los 3 formatos de entrada: `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff`, `aabbccddeeff`). Impls Prisma **y** in-memory, en sincronía.
- Exponer **`callerId`** en `PppoeServiceListItemDto` (para que el FE muestre la MAC que matcheó — sin exponer nunca el password).

**BE — Parte 2 (bulk change-plan):**
- Caso de uso nuevo `BulkChangePppoePlan` que reusa la lógica de cambio de plan de `UpdatePppoeService` (extraída a un servicio de dominio compartido — ver `design.md` Decisión 5).
- Endpoint `POST /api/pppoe/bulk/change-plan` (gate `pppoe.manage`), body `{ ids: string[], profile: string, reason?: string }`.
- Validación **fail-fast**: el `profile` debe existir en el catálogo `Plan` **antes** de arrancar (si no existe → 422, cero mutación); `ids` no vacío (400); tope de `ids` por request (ver `design.md` Decisión 4).
- Ejecución best-effort agrupada por `nasId` (patrón `RunBulkEnforcement`): carriles seriales por router, N routers en paralelo, throttle. Respuesta síncrona `{ ok: string[], failed: { id, username, error }[] }`.
- Evento de historial `'modified'` por ítem exitoso (actor + reason + `old→new` plan), como ya hace `UpdatePppoeService`.

**FE (`ipnext-frontend`, worktree coordinado) — skill ui-ux-pro-max OBLIGATORIA:**
- **Search:** solo actualizar el placeholder del input existente a `"Buscar usuario, cliente, IP, MAC…"`. El mismo `?search=` ya viaja al BE (debounce 300ms intacto).
- **Selección múltiple (patrón NUEVO en la app):** checkbox por fila + checkbox de header "seleccionar página" + toolbar contextual (aparece con N seleccionados: "N seleccionados — Cambiar plan | Limpiar") + modal de confirmación con dropdown de planes (reusa `usePlans` + el filtro de planes elegibles del `EditPppoeModal`) + input `reason` opcional + resumen del resultado (ok / fallidos con el error por fila).
- **Gate `pppoe.manage`:** los checkboxes y la toolbar **NI aparecen** sin ese permiso (`useMyPermissions().can('pppoe.manage')` / `<Can>`).

### Out of Scope

- **NO se toca el modal "Mover NAS" ni `MovePppoeServiceToRouter` / `MovePppoeToNas`** — es del change paralelo `pppoe-move-nas` (ver `design.md` Coordinación). Este change y aquel comparten `PppoeManagementTab.tsx` y `app.ts` en zonas distintas.
- **NO "cambiar plan a todos los del filtro"** — decisión explícita del usuario: solo filas seleccionadas.
- **Bulk async con progreso poleable** (job persistido tipo `ServiceCutBatch`): se descarta para este change; la respuesta es síncrona (ver `design.md` Decisión 3). Si el volumen lo exige a futuro, se migra al patrón de batch poleable.
- **Búsqueda con tabs/toggle por tipo** (Usuario / IP / MAC): descartada — un solo input que resuelve el tipo por heurística (decisión del usuario: misma UX).
- **Otros campos en el bulk** (password, IP, status): fuera de scope; el bulk es SOLO cambio de plan.

## Capabilities

### New Capabilities

- `pppoe-search-bulk-plan`: búsqueda de servicios PPPoE por IP y por MAC (además de username/cliente) + cambio de plan masivo sobre una selección explícita de servicios, best-effort, con historial por ítem.

### Modified Capabilities

- `pppoe-management`: el `search` de la lista global gana matcheo por `remoteAddress` y `callerId`; el DTO de lista gana `callerId`. Aditivo — el matcheo por username/cliente actual no cambia.

## Approach

1. **BE search (TDD, seam completo):** extender `listAllPaginated` (Prisma + in-memory) para matchear `remoteAddress` y `callerId` normalizado. Test de seam ruta→use case→repo por cada formato de MAC + IP exacta/parcial + regresión username/cliente. Exponer `callerId` en el DTO.
2. **BE refactor compartido (TDD):** extraer la lógica de cambio de plan de `UpdatePppoeService` a un servicio de dominio `ChangePppoePlanService` (ruteo por `nas.type` + evento de historial), SIN romper el contrato de `PATCH /api/pppoe/:id`. `UpdatePppoeService` pasa a invocarlo.
3. **BE bulk (TDD):** `BulkChangePppoePlan` — valida plan (fail-fast) + `ids` (no vacío, tope) → agrupa por `nasId` → carriles seriales/paralelos (patrón `RunBulkEnforcement`) invocando `ChangePppoePlanService` por ítem → `{ ok, failed }`. Ruta + gate `pppoe.manage` + catch async explícito + mapeo de errores. Wiring en `app.ts` verificado con composition test.
4. **FE:** placeholder del search + patrón de selección múltiple + modal bulk (ui-ux-pro-max) + hook `useBulkChangePppoePlan` que invalida `['pppoe','list']`. Tests FE del flujo.
5. **Verificación:** `npm test` verde BE + `tsc --noEmit` limpio; suite FE + typecheck; review adversarial (2 revisores: mutación/bulk-semantics + contrato/wiring); push gated por OK del usuario.

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/domain/ports/PppoeServiceRepository.ts` | Modified | Doc del `search` de `listAllPaginated`: ahora matchea también `remoteAddress` + `callerId` |
| `src/infrastructure/adapters/prisma/PrismaPppoeServiceRepository.ts` | Modified | `listAllPaginated`: OR extendido con `remoteAddress` + variantes normalizadas de MAC sobre `callerId` |
| `src/infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository.ts` | Modified | Espejo del search extendido (IP + MAC normalizada) |
| `src/application/dto/pppoe.dto.ts` | Modified | `PppoeServiceListItemDto` + `callerId`; nuevo `BulkChangePlanBodySchema` + `BulkChangePlanResultDto` |
| `src/application/use-cases/ListAllPppoeServices.ts` | Modified | `toDto` incluye `callerId` (el repo ya lo selecciona) |
| `src/application/services/ChangePppoePlanService.ts` | New | Lógica compartida de cambio de plan (extraída de `UpdatePppoeService`) |
| `src/application/use-cases/UpdatePppoeService.ts` | Modified | Delega el cambio de plan a `ChangePppoePlanService` (contrato de `PATCH` intacto) |
| `src/application/use-cases/BulkChangePppoePlan.ts` | New | Bulk best-effort agrupado por router; valida plan (fail-fast) + `ids` |
| `src/domain/ports/PlanRepository.ts` | Reused | `findByCode(profile)` para el fail-fast de plan inexistente |
| `src/infrastructure/http/routes/pppoe.routes.ts` | Modified | `POST /pppoe/bulk/change-plan` (gate `pppoe.manage`, catch async explícito) |
| `src/infrastructure/http/app.ts` | Modified | ⚠️ **God Object** — wiring de `BulkChangePppoePlan` + `PlanRepository` en el router |
| `ipnext-frontend` (`PppoeManagementTab.tsx`) | Modified | Placeholder search + selección múltiple + toolbar + modal bulk. **NO el modal Mover NAS.** |
| `ipnext-frontend` (`pppoe.api.ts`, `usePppoe.ts`, `types/internetService.ts`) | Modified | `bulkChangePlan(...)` + `useBulkChangePppoePlan` + `callerId` en el tipo del item |

> **Splynx:** este cambio NO agrega dependencias de Splynx (constraint respetado).

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Mutación de planes de clientes REALES en el RADIUS en caliente (CoA) | Alta | Reusa la ruta ya probada de `UpdatePppoeService` (CoA `applyInSession`, no dropea sesión); best-effort por-ítem (un fallo no aborta el lote); review adversarial con foco mutación/bulk-semantics; solo filas seleccionadas (nunca "todos") |
| MAC no matchea por formato (callerId guardado sin normalizar) | Alta | Normalizar AMBOS lados: variantes del input + matcheo tolerante a separadores (Decisión 1). Tests de los 3 formatos de entrada |
| Refactor de `UpdatePppoeService` rompe el `PATCH /api/pppoe/:id` | Media | Extracción a servicio de dominio con TESTS de regresión del PATCH (mismo comportamiento, evento incluido); el use case sigue siendo la fachada |
| Feature muerta en prod por hook no inyectado (lección W6) | Media | Composition test que verifica el wiring de `BulkChangePppoePlan` + `PlanRepository` en `app.ts` |
| Drift BE↔FE (construidos en paralelo, lección W6) | Media | Contrato campo-por-campo en el spec; `callerId` y el shape `{ ok, failed }` congelados en el DTO |
| Conflicto de merge con `pppoe-move-nas` en `PppoeManagementTab.tsx` / `app.ts` | Media | Zonas disjuntas (Coordinación en `design.md`); rebase ordenado; worktrees dedicados |
| Bulk sobre miles de ids satura los routers | Baja | Tope de `ids` por request + agrupación por router con throttle (patrón `RunBulkEnforcement`) |
| Handler async sin catch cuelga la request (no hay express-async-errors) | Baja | Catch explícito en el handler (patrón del PATCH existente) |

## Rollback

- **BE:** todo aditivo. `git revert` del use case bulk + la ruta + el DTO. El search extendido revierte al `OR` original (username/cliente). El refactor de `ChangePppoePlanService` se revierte re-inline en `UpdatePppoeService`. Sin migración de schema (`callerId` ya existe en la DB).
- **FE:** `git revert` del patrón de selección + modal + hook. El placeholder vuelve a `"Buscar usuario, cliente…"`.
- **Sin estado persistido nuevo:** no hay tabla ni columna nueva → rollback limpio.

## Dependencies

- `PppoeService.callerId` poblado (ya existe; el write-through de `GetPppoeCallerId` lo mantiene). Servicios sin sesión vista aún tendrán `callerId = null` → no matchean por MAC (esperado).
- Catálogo `Plan` poblado (ya en prod; `GET /api/plans` lo sirve).
- `pppoe.manage` en el catálogo RBAC (ya existe).
- Coordinación con `pppoe-move-nas` (sesión paralela) para el merge de `PppoeManagementTab.tsx` + `app.ts`.

## Success Criteria

- [ ] Buscar por **IP exacta** y **parcial** encuentra el servicio (`remoteAddress`).
- [ ] Buscar por **MAC** en los 3 formatos (`AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff`, `aabbccddeeff`) encuentra el servicio (`callerId`).
- [ ] El search **sigue** matcheando username + nombre del cliente (regresión).
- [ ] `callerId` expuesto en el DTO de lista (sin password).
- [ ] **Bulk feliz:** N servicios seleccionados cambian de plan; respuesta `{ ok: [...], failed: [] }`.
- [ ] **Bulk con ítem que falla:** el lote sigue; el ítem queda en `failed` con `{ id, username, error }`.
- [ ] **Bulk con plan inexistente:** 422 fail-fast, CERO mutación.
- [ ] **Bulk sin permiso:** 403 (`pppoe.manage`).
- [ ] **Bulk vacío:** 400.
- [ ] **Evento de historial** `'modified'` por ítem exitoso, con actor + reason + `old→new`.
- [ ] **FE:** checkboxes + "seleccionar página" + toolbar + modal de confirmación; gate `pppoe.manage` (invisible sin permiso).
- [ ] Test de **seam completo** (ruta→use case→repo real, in-memory) por cada filtro nuevo y para el bulk. `npm test` verde + `tsc --noEmit` limpio.
- [ ] **Wiring** de `app.ts` verificado con composition test. **DIP preservado** (use cases dependen de ports).
- [ ] Contrato **BE↔FE campo-por-campo** en el spec, congelado.
