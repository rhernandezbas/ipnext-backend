# Design: PPPoE — búsqueda por IP/MAC + bulk cambio de plan

## Contexto

El tab **PPPoE de Gestión de Red** lista los servicios PPPoE globales vía `ListAllPppoeServices` → `PppoeServiceRepository.listAllPaginated` (`GET /api/pppoe`, gate `pppoe.read`). El FE (`PppoeManagementTab.tsx`) tiene un input de búsqueda debounced (300ms) que viaja como `?search=` y una tabla server-side paginada (25/pág).

**Lo que YA existe y se reusa (verificado, file:line):**
- **Search actual** (`PrismaPppoeServiceRepository.ts:215-221`): `OR` de `{ username: contains }` + `{ contract.client.name: contains }`, ambos `mode: 'insensitive'`. El `where` se arma como `AND` de fragmentos (`:207-226`) para que el `OR` del search no colisione con el filtro de `displayStatus` ni con `contractId: { not: null }`.
- **El `select` del query YA trae `remoteAddress` (`:241`), `callerId` (`:246`), `ipMode` (`:247`)** — el dato de MAC/IP ya está en memoria, solo falta buscarlo y (para MAC) exponerlo.
- **`callerId`** (MAC del CPE) se persiste **tal cual lo manda el orchestrator** (`HttpRadiusOrchestratorGateway.ts:223` → `caller_id`), con write-through best-effort desde `GetPppoeCallerId.ts:29`. **No hay normalización en el BE.** Fixtures y el NE8000 Huawei usan `AA:BB:CC:DD:EE:FF` (mayúsculas, `:`).
- **Cambio de plan** (`UpdatePppoeService.ts:56-101`): rutea por `nas.type` — `radius_orchestrator` → `orchestrator.changePlan(username, profile, { applyInSession: true })` (CoA caliente, no dropea sesión); resto → `router.updateSecret`. Tras el upsert en DB, registra evento `'modified'` best-effort (`:87-106`) con actor + reason + `old→new`.
- **Bulk best-effort** (`RunBulkEnforcement.ts:52-136`): agrupa por `nasId`, cada router es un carril SERIAL, N routers en paralelo (`mapWithConcurrency`, `routerConcurrency=16`), throttle entre ops del mismo router (`300ms`), best-effort (ítem falla → `failed`, el lote sigue).
- **Validación de plan**: puerto `PlanRepository.findByCode(code)` (`domain/ports/PlanRepository.ts`) — chequea que el plan existe en el catálogo `Plan`. **OJO:** `UpdatePppoeService` usa `catalogRepo.getByName('INTERNET')`, que es el `ServiceCatalogRepository` (catálogo de SERVICIOS internet/tv), **NO** valida que el profile/plan exista. Para el fail-fast del bulk el chequeo correcto es `PlanRepository.findByCode(profile)`.
- **Ruta patrón** (`pppoe.routes.ts:475-495`, `POST /pppoe/enforce/bulk`): Zod `safeParse` → 422; body con array vía `z.array(z.string().min(1)).min(1)`; catch async **explícito** (no hay `express-async-errors`). Gate `requirePerm('pppoe','manage')` (`:138-140`).
- **DTO** (`pppoe.dto.ts`): `PppoeServiceListItemDto` sin password; patrón `ServiceCutBatchDto` con `items: { pppoeId, ok, error? }[]`.

---

## Parte 1 — Búsqueda por IP y MAC

### Decisión 1 — Matcheo de MAC tolerante a formato: normalizar AMBOS lados vía variantes del input (sin migración)

**El problema:** el `callerId` se guarda **sin normalizar** (lo que mande el NAS/orchestrator). El usuario puede escribir la MAC en 3 formatos: `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff`, `aabbccddeeff`. Un `contains: search` simple NO alcanza: si el usuario escribe `aabbccddeeff` y la DB guarda `AA:BB:CC:DD:EE:FF`, no matchea.

**La opción elegida — variantes del input + `OR` de `contains` (case-insensitive):**

1. **Detección:** en el use case (o en un helper de dominio `macSearch.ts`), detectar si el `search` **parece una MAC** (hex-only tras quitar separadores `[:.\-\s]`, longitud 12, o un prefijo hex ≥ ~4 que huela a MAC). Si NO parece MAC, el search se comporta como hoy + IP.
2. **Normalización canónica:** `canonical = search.replace(/[:.\-\s]/g, '').toLowerCase()`.
3. **Generación de variantes** para el matcheo tolerante:
   - `raw` (el input tal cual, para el caso "pegó exactamente el formato guardado"),
   - `colon` (`aa:bb:cc:dd:ee:ff`),
   - `dash` (`aa-bb-cc-dd-ee-ff`),
   - `plain` (`aabbccddeeff`).
   Todas en lowercase; el `contains` va `mode: 'insensitive'`, así que cubre mayúsculas/minúsculas de la DB.
4. **WHERE:** el `OR` del search suma, además de username/cliente/IP, **un `contains` de `callerId` por cada variante** (parciales incluidos: si el usuario escribe medio MAC, matchea el prefijo hex).

**Por qué variantes-del-input y NO una columna normalizada persistida:**
- Una `callerIdNormalized` persistida sería el matcheo más limpio (un solo `contains`), PERO exige **migración + backfill + mantener el write-through en dos lugares** (`setCallerId`, el ingest). Costo/beneficio no lo justifica para una MAC de 12 hex.
- Generar ≤4 variantes de `contains` es O(1) por request, sin schema nuevo, y el `callerId` ya está indexado implícitamente en el `select` del query (el volumen de la tabla PPPoE es acotado — decenas de miles, no millones).
- **Tradeoff aceptado:** un `OR` con ~4 `contains` extra sobre `callerId`. Es barato y el resultado es tolerante a los 3 formatos + parciales. Si el volumen creciera y el `contains` se volviera lento, se migra a la columna normalizada (rollback-compatible).

> **Alternativa considerada y DIFERIDA:** normalizar la columna en la query con `LOWER(REPLACE(...))`. Prisma no expone `REPLACE` en el `where` sin `queryRaw`, lo que rompería el mismo `where` tipado que comparten `findMany` + `count`. Se descarta a favor de las variantes del input.

### Decisión 2 — IP: `contains` directo sobre `remoteAddress`

Para la IP, un `contains: search` sobre `remoteAddress` (`mode: 'insensitive'`) cubre **exacta y parcial** (`100.64.28.5` y `100.64.28`). No requiere normalización (las IPs se guardan canónicas). Se suma al `OR` del search **incondicionalmente** (una IP parcial es un substring válido; no hay ambigüedad con username porque el `OR` incluye ambos).

### Decisión 2b — Un solo `search`, sin tabs por tipo

Decisión del usuario: **misma UX**. El input sigue siendo uno solo. El BE resuelve el tipo por heurística:
- El `search` **siempre** intenta matchear username / cliente / IP (`remoteAddress`).
- **Si además parece MAC** (Decisión 1), suma las variantes de `callerId` al `OR`.

No se agrega `searchBy` al filtro. El FE solo cambia el placeholder.

### Decisión 2c — Exponer `callerId` en el DTO de lista

El repo ya selecciona `callerId`; hoy `PppoeServiceListItemDto` **no lo expone**. Se agrega `callerId: string | null` al DTO y al `toDto` de `ListAllPppoeServices`, para que el FE pueda **mostrar la MAC** (y el operador entienda por qué matcheó). Nunca se expone el password (frontera intacta). El tipo FE `PppoeServiceListItem` gana `callerId?: string | null`.

### Consistencia Prisma ↔ in-memory

El `InMemoryPppoeServiceRepository.listAllPaginated` (`:177-232`) hoy matchea `s.username` + `s.customerName` (`toLowerCase().includes`). Debe replicar EXACTAMENTE la nueva semántica: IP (`remoteAddress`) + MAC normalizada (mismas variantes / misma heurística). El helper de normalización de MAC vive en **dominio** (`src/domain/services/macSearch.ts` o similar) y lo usan **ambos** adapters + el test, para que la lógica sea única y testeable de forma pura.

---

## Parte 2 — Bulk cambio de plan

### Decisión 3 — Respuesta SÍNCRONA `{ ok, failed }`, no job poleable

El pedido del usuario es respuesta por-ítem `{ ok: [], failed: [{ id, username, error }] }`. Se resuelve **síncrono** (el handler espera a que el lote termine y devuelve el resumen), a diferencia de `RunBulkEnforcement` que persiste un `ServiceCutBatch` poleable y responde `202 { jobId }`.

**Por qué síncrono:**
- El bulk es sobre una **selección explícita acotada** (checkboxes de una página → decenas, no miles). El tope de `ids` (Decisión 4) mantiene el tiempo de respuesta bounded.
- Evita infraestructura nueva (tabla de batch, polling, runner). Menos superficie, menos riesgo.
- **Tradeoff:** una request larga si el lote es grande y los routers responden lento. Mitigado por el tope de `ids` + `routerConcurrency`. Si a futuro se pide "bulk de miles", se migra al patrón `ServiceCutBatch` poleable (el use case ya devolvería el mismo shape por-ítem).

### Decisión 4 — Tope de `ids` por request + validaciones de entrada

- **`ids` no vacío** → si viene `[]`, **422** (`z.array(...).min(1)`; el `safeParse.error` de la ruta responde SIEMPRE 422 `VALIDATION_ERROR`, igual que todo el resto de los body schemas de `pppoe.routes.ts` — NO 400. Fix-wave de review: el draft original de esta decisión decía 400, pero el código real —y el resto del archivo— usa 422 para cualquier fallo de Zod).
- **Tope máximo `ids.length ≤ 200`** (alineado con el `MAX_LIMIT=100` de la lista + margen para "seleccionar 2 páginas"; el FE selecciona por página de 25). Si excede → **422** con mensaje claro. Bounded response time + protege los routers.
- **Plan existe (fail-fast)** → `PlanRepository.findByCode(profile)` **antes** de arrancar el lote. Si no existe → **422** `PLAN_NOT_FOUND`, CERO mutación. Esto evita que 200 servicios reciban un profile RADIUS inválido (que el orchestrator rechazaría uno por uno, dejando el lote a medias). **Recomendado y adoptado: sí, fail-fast.**
- **Deduplicar `ids`** (un mismo id repetido no debe contar dos veces).

### Decisión 5 — Extraer `ChangePppoePlanService` (dominio) compartido por `UpdatePppoeService` y `BulkChangePppoePlan`

**El problema:** la lógica de cambio de plan (rutear por `nas.type` → `orchestrator.changePlan` con `applyInSession` / `router.updateSecret` → upsert DB → evento `'modified'` con actor+reason+`old→new`) vive HOY dentro de `UpdatePppoeService.execute` mezclada con el resto del update (password, remoteAddress, status). El bulk necesita **solo** el cambio de plan.

**Opciones:**

| Opción | Descripción | Tradeoff |
|--------|-------------|----------|
| **A. `BulkChangePppoePlan` invoca `UpdatePppoeService` per-item** | Reusa el use case tal cual, pasándole solo `{ id, profile, reason, actor }` | Simple, cero refactor. PERO `UpdatePppoeService` hace `findById` + `findNasServerById` + upsert completo por ítem: OK. El riesgo es acoplar el bulk a un use case pensado para un update de UN campo arbitrario; y `UpdatePppoeService` no agrupa por router (el bulk sí necesita agrupar) → el bulk igual orquesta el agrupamiento y llama al use case por ítem dentro de cada carril. **Viable y de bajo riesgo.** |
| **B. Extraer `ChangePppoePlanService` de dominio** | Servicio puro `changePlan({ service, nas, profile, reason, actor })` que hace ruteo + upsert + evento. `UpdatePppoeService` lo invoca para el sub-caso profile; `BulkChangePppoePlan` lo invoca por ítem | Más limpio (single responsibility), la lógica de cambio de plan queda en UN lugar testeable. Costo: refactor de `UpdatePppoeService` con tests de regresión del `PATCH`. |

**Elegida: Opción B (extracción), con la Opción A como fallback si el refactor resulta más invasivo de lo previsto.** Razón: la regla del proyecto es DIP estricta y "un caso por archivo"; duplicar la lógica de ruteo+evento en dos use cases es deuda que driftea (el evento `'modified'`, el `applyInSession`, el manejo de `nas.type` deben ser idénticos). Extraer a un servicio de dominio:
- **Mantiene el contrato de `PATCH /api/pppoe/:id` intacto** — `UpdatePppoeService` sigue siendo la fachada; solo delega el sub-caso profile. Tests de regresión del PATCH garantizan mismo comportamiento (incluido el evento).
- `BulkChangePppoePlan` depende del **servicio de dominio**, no de `UpdatePppoeService` (evita el acoplamiento use-case→use-case).
- El servicio recibe los ports por constructor (`PppoeServiceRepository`, `PppoeRouterGateway`, `RadiusOrchestratorGateway`, `ServiceCatalogRepository`, `ContractServiceEventRepository`) — DIP preservado.

> **Guardrail:** si al extraer aparece que `UpdatePppoeService` entrelaza profile con otros campos de forma no separable sin cambiar su semántica observable, se cae a la Opción A (invocar el use case per-item) — documentar la decisión final en `apply-progress`. Lo que NO se acepta es **duplicar** la lógica.

### Decisión 6 — Estrategia de ejecución del bulk (patrón `RunBulkEnforcement`)

```
BulkChangePppoePlan.execute({ ids, profile, reason, actor }):
  1. dedup(ids); si vacío → error de dominio (la ruta → 422; en la práctica inalcanzable vía HTTP,
     el Zod `ids.min(1)` de la ruta ya devuelve 422 antes de llegar al use case — fix-wave S2:
     error dedicado `BulkEmptyIdsError`, no reutiliza el mensaje de `BulkTooLargeError`)
  2. si ids.length > 200 → error de dominio (la ruta → 422)
  3. plan = PlanRepository.findByCode(profile); si null → error de dominio (la ruta → 422 PLAN_NOT_FOUND)   ← FAIL-FAST, cero mutación
  4. resolver filas: para cada id → repo.findById; id inexistente → failed[{ id, username:'', error:'PPPOE_NOT_FOUND' }]
  5. agrupar los existentes por nasId
  6. mapWithConcurrency(routers, routerConcurrency, async nasId => {
        for (const s of grupo) {           // carril SERIAL por router
          try {
            await changePlanService.changePlan({ service: s, profile, reason, actor });
            ok.push(s.id);
          } catch (err) {
            failed.push({ id: s.id, username: s.username, error: message(err) });
          }
          await sleep(throttleMs);          // throttle entre ops del mismo router
        }
     })
  7. return { ok, failed }                   // síncrono
```

- **Best-effort:** un ítem que falla (router caído, orchestrator 502, pppoe borrado) → `failed`, el lote sigue (igual que `RunBulkEnforcement`).
- **Agrupar por router:** no saturar un maestro; N routers en paralelo, cada uno serial con throttle.
- **`ok` = ids; `failed` = { id, username, error }`** — congelado en el DTO (contrato FE).
- **Evento de historial** por ítem OK lo emite `ChangePppoePlanService` (mismo path que el PATCH), best-effort (un fallo del evento no revierte el cambio ya aplicado — igual que hoy).

### Decisión 7 — Ruta, gate, catch async, mapeo de errores

- `POST /api/pppoe/bulk/change-plan`, `auth` + `canManage = requirePerm('pppoe','manage')`.
- Body Zod `BulkChangePlanBodySchema = z.object({ ids: z.array(z.string().min(1)).min(1), profile: z.string().min(1), reason: z.string().nullish() })`. `safeParse` falla → **422** (vacío o inválido — mismo código `VALIDATION_ERROR` que el resto de las rutas de `pppoe.routes.ts`).
- **Catch async EXPLÍCITO** en el handler (no hay `express-async-errors`; un throw sin catch cuelga la request). Fix-wave W1: el catch debe terminar en `next(err)`, NUNCA `throw err` — un `throw` dentro de un handler async de Express 4 es una promesa rechazada sin manejar: la request se cuelga (no se envía respuesta), no llega 500.
- Mapeo: `BulkEmptyIdsError` → 422; `PlanNotFoundForBulkError` → 422; `BulkTooLargeError` (>200) → 422; error inesperado → `next(err)` → global handler → 500. Los errores **por ítem** NO son HTTP status — van en `failed[]` con 200 global (el lote se ejecutó, algunos fallaron).
- Actor: `actorOf(req)` = `{ actorId: req.user?.id ?? null, actorName: req.user?.username ?? '' }` (patrón del PATCH).

### Decisión 8 — Wiring en `app.ts` (God Object) + composition test

`BulkChangePppoePlan` se construye con: `PppoeServiceRepository`, `PlanRepository`, y `ChangePppoePlanService` (que a su vez recibe `router`, `nasRepo`, `orchestrator`, `catalogRepo`, `eventRepo`). Se inyecta en `createPppoeRouter`. Un **composition test** (anti "feature muerta", lección W6) verifica que la ruta existe, el use case está cableado con los repos reales, y responde (no 404 de ruta).

---

## Hexagonal / DIP

- `ChangePppoePlanService` y `BulkChangePppoePlan` viven en `application`/`domain` y dependen **solo de ports** (`PppoeServiceRepository`, `PlanRepository`, `RadiusOrchestratorGateway`, `PppoeRouterGateway`, `NasRepository`, `ServiceCatalogRepository`, `ContractServiceEventRepository`). Ningún import de Prisma / Express / axios.
- El helper de normalización de MAC (`macSearch.ts`) es **puro** (dominio) — sin infra — y lo consumen los dos adapters (Prisma + in-memory) + los tests.
- Tests TDD con `InMemory*` repos + fakes del gateway (red → green → refactor).

---

## Contrato BE↔FE (resumen; el detalle campo-por-campo va en el spec)

**Search:** sin cambio de contrato — el mismo `?search=` (string) ahora matchea también IP/MAC. El FE solo cambia el placeholder.

**Lista (item):** `PppoeServiceListItemDto` gana `callerId: string | null`. El tipo FE `PppoeServiceListItem` gana `callerId?: string | null`.

**Bulk request:** `POST /api/pppoe/bulk/change-plan` body `{ ids: string[], profile: string, reason?: string | null }`.

**Bulk response (200):**
```json
{
  "ok": ["id1", "id2"],
  "failed": [{ "id": "id3", "username": "juan@ipnext.com.ar", "error": "OrchestratorUnreachable" }]
}
```

**Errores HTTP:** 422 (ids vacío / plan inexistente / ids > 200 / body inválido) · 403 (sin `pppoe.manage`) · 401 (sin sesión) · 500 (error inesperado del use case, no cuelga — fix-wave W1).

---

## Coordinación con `pppoe-move-nas` (sesión paralela — NO tocar)

Ambos changes tocan `PppoeManagementTab.tsx` (FE) y `app.ts` (BE) en **zonas disjuntas**:

| Archivo | `pppoe-search-bulk-plan` (este) | `pppoe-move-nas` (paralelo) |
|---------|--------------------------------|-----------------------------|
| `PppoeManagementTab.tsx` | input de búsqueda (placeholder) + tabla (checkboxes/toolbar) + modal NUEVO de bulk cambio de plan | el MODAL "Mover NAS" existente + tab "Movimientos NAS" en `/admin/networking/audit` |
| `app.ts` | wiring de `BulkChangePppoePlan` + `PlanRepository` en el router pppoe | wiring de `MovePppoeToNas` + watcher + repo de `PppoeNasMoveEvent` |

**Regla:** este change **NO** toca el modal Mover NAS, `MovePppoeServiceToRouter`, `MovePppoeToNas`, ni la page de auditoría. Worktrees dedicados; rebase ordenado en el merge; sin conflicto semántico (secciones distintas del mismo archivo). Si hay conflicto de líneas, se resuelve manteniendo AMBAS features.

---

## Reglas del proyecto que este diseño respeta

- **Contrato BE↔FE campo-por-campo en el spec** (lección W6: BE y FE en paralelo driftean).
- **Test de seam completo por filtro/param nuevo** (lección #28): ruta → use case REAL → repo in-memory; NO mockear el use case. El search IP/MAC y el bulk se testean end-to-end del seam.
- **Wiring de `app.ts` verificado** contra el diseño con composition test (lección W6: feature muerta por hook no inyectado).
- **Handlers async con catch explícito** (no hay `express-async-errors`).
- **Permisos en las DOS capas:** FE (`useMyPermissions`/`<Can>`) + BE (`requirePermission('pppoe','manage')`).
- **DTOs sin password** (defense in depth: `PppoeServiceListItemDto` nunca lo trae; el `select` del repo tampoco).
- **FE ui-ux-pro-max obligatoria** para la UI nueva; CSS Modules + tokens `var(--color-*)`; accesibilidad (contraste ≥4.5:1, touch ≥44px, focus visible).
- **TDD estricto:** cada task de código arranca por el test que falla.
- **Worktrees dedicados BE+FE + review adversarial** (mínimo 2 revisores: foco mutación/bulk-semantics + foco contrato/wiring — el bulk muta planes de clientes REALES en el RADIUS en caliente).

---

## Addendum — fix-wave post-review adversarial (R1 mutación/bulk NO CLEAN, R2 contrato/wiring CLEAN)

El review adversarial doble encontró que el best-effort de `BulkChangePppoePlan` (Decisión 6) y la delegación de `UpdatePppoeService` (Decisión 5) NO se comportaban como está documentado más arriba. Fixes aplicados:

- **F1 — best-effort real, no solo declarado.** El `nasRepo.findNasServerById` del carril (paso 6 del pseudocódigo de Decisión 6) vivía FUERA del `try`. Un throw ahí (ej. Prisma caído) rechazaba el `mapWithConcurrency` completo → `execute()` entero rechazaba, perdiendo los `ok` ya producidos por OTROS carriles y dejando ese carril sin `failed[]` (zombie). Fix: todo el cuerpo del carril (lookup del NAS incluido) va dentro de un try/catch — si el lookup tira, TODOS los ítems de ese grupo caen a `failed[]` con `NAS_LOOKUP_FAILED`, los demás carriles siguen. El `findById` por ítem del paso 4 tiene el mismo problema/fix (`PPPOE_LOOKUP_FAILED` por ítem).
- **F2 — delegación (Decisión 5, Opción B) es SOLO para profile-solo.** El código original delegaba a `ChangePppoePlanService` para CUALQUIER patch que incluyera `profile`, incluso combinado con password/status/remoteAddress. Eso cambiaba la atomicidad observable de `PATCH /api/pppoe/:id`: el profile quedaba commiteado + eventado aunque un campo posterior (ej. `suspend`) tirara después, y el path Mikrotik hacía DOS `updateSecret` en vez de uno combinado. Fix: la delegación aplica ÚNICAMENTE cuando `profile` es el ÚNICO campo del patch. Los combinados van COMPLETOS por el camino legacy inline (comportamiento observable EXACTO al original, pre-Decisión 5).
- **S1 — throttle correcto.** `sleep(throttleMs)` ya NO corre después del último ítem del carril, ni después de ítems que nunca tocaron el plano de control (`NAS_NOT_FOUND` / lookup de NAS fallido).
- **S2 — mensaje de error para lote vacío.** `ids=[]` pasado directo al use case (bypaseando el Zod de la ruta) ahora lanza `BulkEmptyIdsError` dedicado ("el lote está vacío"), no reutiliza el texto de `BulkTooLargeError` ("recibió 0 ids, máximo 200").
- **W1 — la ruta bulk ya no cuelga.** El catch del handler terminaba en `throw err`, que dentro de un handler async de Express 4 es una promesa rechazada sin manejar — la request nunca recibía respuesta. Fix: `next(err)` → el `errorHandler` global responde 500.
- **Corrección de semántica documentada (400→422):** esta misma página decía "ids vacío → 400" en varios lugares (Decisión 4, pseudocódigo de Decisión 6, resumen de errores HTTP). El código real (y el resto de `pppoe.routes.ts`) responde SIEMPRE 422 `VALIDATION_ERROR` para cualquier fallo de Zod — nunca 400. Corregido en las secciones correspondientes más arriba.
