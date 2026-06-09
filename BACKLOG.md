# Backlog — IPNext (Prominense)

> Backlog de trabajo sobre los dos repos (`ipnext-backend` + `ipnext-frontend`).
> Arrancó el 2026-06-03 con 14 ítems; +2 (#15, #16) → 16; +1 (#17); +2 (#18, #19); +1 (#20); +2 (#21, #22); +2 (#23, #24); +2 (#25, #26); +1 (#27); +1 (#28) → 28; +9 (#29–#37, sesión 2026-06-08: cierre de OS async/resiliente + página de Reconciliar + observabilidad) → **37 totales**.
> **37 hechos (en prod) · 1 EPIC en curso (#38).** (#17, #7, #22, #18, #14, #11, #12, #25, #20, #19, #23, #29, #31, #30, #32, #33, #34, #35, #36, #37 cerrados vía SDD.)

---

## 🏗️ EPIC #38 — Sistema de Inventario completo (equipos + materiales, multi-ubicación, descuento desde tareas)  *(agregado 2026-06-08)*

> **Big epic, múltiples SDDs (waves).** Visión del usuario: llevar control real del inventario — equipos por cliente, equipos nuestros (depósito), devolución de equipos en los retiros, consumo de materiales (POEs, conectores, etc.), inventario por técnico/camioneta, y **descuento automático/semi-automático desde las tareas y los equipos técnicos**. Front a elección, **siempre impeccable**. Todo con foreign keys.

### Concepto central (investigado + alineado al código)
El patrón estándar de field-service inventory (ver Fuentes) conecta **depósito + camionetas + sitios de trabajo** en un solo sistema con un **ledger de movimientos en vivo**: cada *issue / transfer / install / return / consume / adjust* queda atado a una **work order (tarea) + técnico + ubicación** — "una sola fuente de verdad de qué se usó, dónde y por qué". Cuatro tipos de stock: **truck stock (camioneta), warehouse (depósito), serialized equipment (equipos por SN), job-specific (reservado a una tarea)**.

**La pieza que FALTA hoy** es justamente esa: **ubicaciones de stock + ledger de movimientos**. El resto ya existe parcial.

### Lo que YA existe (reutilizar, NO reinventar)
- **Equipos serializados**: `InventoryProduct` (catálogo) + `InventoryUnit` (unidad física con `serialNumber`/`barcode`/`status` available|assigned|damaged|retired/`location` string/`assignedToClientId`). 6 páginas FE de inventario ya hechas (`/inventory/*`).
- **Equipos x cliente**: `ContractInstalledItem` (roster de equipos instalados por contrato, `status` active|removed|replaced, `source` OCR|MANUAL|ICLASS).
- **Materiales**: `MaterialCatalog` (catálogo UPPERCASE) + `TaskMaterialConsumption` (consumo por tarea, FK a tarea+usuario) + `IClassSoMaterial` (líneas de material de la OS).
- **Eventos de equipos de IClass**: `IClassSoEquipmentEvent` (install|remove|move, serialNumber/mac/patrimonio/modelo) — **se capturan en el closure pero NO se consumen** (`IClassClient.getServiceOrderEquipmentEvents`, fetched en `IngestClosedServiceOrders.ts:202`).
- **Staging**: `TaskInventorySuggestion` (pending→confirmed→discarded) + flujo confirm/discard/replace (add|link_existing|replace) ya battle-tested (#19).
- **Técnico**: `RbacUser` (= técnico vía `ScheduledTask.assigneeId`).

### ⚠️ Decisión arquitectónica clave (resolver en wave 1)
Hoy conviven **DOS mundos de inventario** en paralelo: (a) genérico `InventoryItem`/`InventoryProduct`/`InventoryUnit`, y (b) específico de tareas/contratos `ContractInstalledItem`/`TaskMaterialConsumption`. El epic DEBE decidir cómo **unificarlos** (o cuál es la fuente de verdad) antes de construir encima. Es el mayor riesgo de diseño.

### Modelo de dominio propuesto (a refinar en SDD)
- **`StockLocation`** (NUEVO): tipos `DEPOSITO` | `CLIENTE` | `TECNICO` | `CAMIONETA`. FK polimórfica/tipada: TECNICO→`RbacUser`, CLIENTE→`Contract`/`Client`, CAMIONETA→`Vehicle` (nuevo). Todo lo que tiene stock apunta a una location.
- **`InventoryUnit.currentLocationId`** (NUEVO FK): la unidad serializada se mueve depósito→técnico/camioneta→cliente (install)→depósito (retiro).
- **`MaterialStock`** (NUEVO): `(materialCatalogId, locationId, qty)` — cantidad de un consumible por ubicación.
- **`InventoryMovement`** (NUEVO, el ledger): `type` (ISSUE|TRANSFER|INSTALL|RETURN|CONSUME|ADJUST), `unitId?`/`materialCatalogId?`, `fromLocationId?`, `toLocationId?`, `qty`, `taskId?` (FK), `technicianId?` (FK), `source` (manual|iclass|ocr), `occurredAt`. El stock actual se deriva del ledger (o se materializa en `MaterialStock`/`InventoryUnit.location`).
- **`Vehicle`/`Camioneta`** (NUEVO): para el truck stock. (v1 podría usar técnico-como-location y diferir camioneta.)

### Waves (cada una = su propio SDD: explore→propose→spec∥design→tasks→apply→verify→deploy→archive)

- **Wave 1 — Fundación ✅ HECHO (en prod, 2026-06-09, BE PR #85)**: Strategy 3 (núcleo unificado; World A vacío en prod → deprecado). `StockLocation` (DEPOSITO|CLIENTE|TECNICO) + `InventoryAsset` (serializado) + `MaterialStock` (Decimal(12,4) + CHECK qty>=0) + `InventoryMovement` (ledger) + `RecordInventoryMovement` (movimiento+balance atómico, TOCTOU-free) + `UnitOfWork` transaccional (dual-write del #19 atómico). Migración: 56 `ContractInstalledItem` → 56 `InventoryAsset` (installed) + 56 INSTALL movements + 41 ubicaciones CLIENTE + DEPOSITO (56/56 sin huérfanos, confirmado en prod). CII gana `assetId` (aditivo, FE intacto). Revisión: review inicial (CRÍTICOS de integridad) → 5 olas de fix → 3 análisis adversariales opus hasta IMPECABLE. Suite 2730/0. Archivado en `openspec/changes/archive/2026-06-09-inventory-foundation/`.
- **Wave 2 — Equipos x cliente ✅ HECHO (en prod, 2026-06-09, BE PR #86 + FE PR #58)**: vista agregada cross-contrato. BE `GET /api/clients/:clientId/equipment` (perm `inventory.read`, DTO `ClientInstalledItemDto` con contractPlan/contractType) sobre `listByClient` (un JOIN). FE tab "Equipos" en `CustomerDetailPage` agrupado por contrato, badges de estado, impeccable. Read-only, sin migración. Suite BE 2735/0, FE 2016/0. Archivado.
- **Wave 3 — Inventario nuestro (depósito) ✅ HECHO (en prod, 2026-06-09, BE PR #87 + FE PR #59)**: BE `GET /api/inventory/depot` (perm `inventory.read`) → equipos `available` en DEPOSITO + stock de consumibles, enriquecidos con DeviceTypeCatalog + MaterialCatalog. `listByLocation` genérico (filtro en use case → reuso W7). `GetDepotStock` resuelve DEPOSITO por `findByCode` (sin crear en GET). FE página nueva `InventoryDepotPage` (`/admin/inventory/depot`) con empty-states contextuales. Read-only, sin migración. Suite BE 2743/0, FE 2025/0. (Depósito vacío hoy → se puebla con W4.) Archivado.
- **Wave 4 — Retiros → devolución al depósito ✅ HECHO (en prod, 2026-06-09, BE PR #88 + FE PR #60)**. **Premisa pivoteada**: IClass devuelve 204 en TODOS los endpoints de equipos (IPNEXT no usa ese módulo) → no hay eventos que consumir. Re-scopeado a **retiro detectado desde el cierre**. STAGE (auto, read-only, **feature flag `iclass-inventory-returns` OFF por default**): OS cierra con result-code de retiro completado (`isRemovalCode`+Sucesso: "Retiro completo Servicio Fibra/Wireless") → matchea serial OCR con asset `installed` (normalizado) → encola `ReturnSuggestion`. CONFIRM (operador, semi-auto, único punto de mutación): → `RecordInventoryMovement(RETURN→DEPÓSITO)` atómico → equipo `available` en depósito (visible en la W3). No-match → crear/vincular/descartar. **Idempotencia 2 capas** (L1 flag por-SO + L2 sourceRef índice parcial). Review: 4 análisis opus → 2 graves corregidos (guard installed, L2 concurrente) → CLEAN. Suite 2793/0, dry-run prod limpio. **Para activar: prender el flag.** FE: página "Devoluciones pendientes" (link picker = follow-up). Archivado.
- **Wave 5a — Inventario x técnico ✅ HECHO (en prod, 2026-06-09, BE PR #89 + FE PR #61)**: TECNICO ya estaba de la W1 (sin migración). `ResolveTechnicianLocation` (find-or-create + P2002), `IssueStockToTechnician` (asigna stock depósito→técnico vía **TRANSFER** —NO ISSUE—, multi-item en UnitOfWork atómico, guard asset-at-depot), `GetTechnicianStock` (clon de GetDepotStock). Rutas `GET /technicians/:id/stock` + `POST /technicians/:id/issue`. FE: página `/admin/inventory/technicians/:id` + modal "Asignar stock". Review opus focalizado: CLEAN. Suite 2814/0. Archivado.
- **Wave 5b — Camioneta (Vehicle model) ✅ HECHO (en prod, 2026-06-09, BE PR #91 + FE PR #63)**: catálogo `Vehicle` (plate UNIQUE, name?, assignedTechnicianId? informativo, status active|inactive) + tipo de StockLocation **CAMIONETA** (`vehicleId` FK + `@@unique([type, vehicleId])`) + `ResolveVehicleLocation` (find-or-create + P2002 retry) + `GetVehicleStock` + `IssueStockToVehicle` (TRANSFER depósito→camioneta multi-item UoW atómico, guards asset-at-depot + **vehículo activo** 422). CRUD `/api/vehicles` (read/manage; DELETE guardeado `VEHICLE_IN_USE`; race P2002 plate → 409 `VEHICLE_PLATE_CONFLICT`). FE: tab "Camionetas" en settings (ABM + "Ver stock"), página `/admin/inventory/vehicles/:id`, modal sibling (técnicos intacto), sidebar. Migración `20260614000000` aditiva, dry-run prod rolled-back OK. **Sin flag** (read-only hasta asignar stock). Review opus → 2 FIX-FIRST (tests de ruta stock/issue + mapeo P2002) → CLEAN. Suite BE 2882/0, FE 2122/0. Archivado en `openspec/changes/archive/2026-06-09-inventory-vehicle-stock/`.
- **Wave 6 — Descuento de materiales desde tareas ✅ HECHO (en prod, 2026-06-09, BE PR #90 + FE PR #62)**: cierra el gap "consumo no descuenta stock". **Semi-auto** (decisión del usuario): STAGE flag-gated (**`inventory-material-auto-deduct` OFF por default**) desde AMBOS canales de consumo (`RecordMaterialConsumption` + `ConfirmInventorySuggestion.handleMaterial`, hook compartido `StageMaterialDeduction` best-effort) → `MaterialDeductionSuggestion` `pending` (stock TECNICO suficiente) o `needs_review` (sin assignee / sin stock). CONFIRM (`ConfirmMaterialDeduction`, única mutación, UoW atómico con slot `stock` tx-scoped nuevo): 4 defensas W4 (guard terminal, pre-write `findBySourceRef`, TOCTOU re-check en la tx, sourceRef `consume:task-material:{id}` sobre el índice parcial W4) + `updateStatus` guardeado por status (races → 409). Resoluciones `needs_review`: `issue-first` (TRANSFER+CONSUME una tx) / `depot` / `discard`. FE: página "Descuentos pendientes" espejo de W4. Migración `20260613000000` aditiva, dry-run prod rolled-back OK. **Review 4 opus → 9 FIX-FIRST corregidos (staging no cableado en app.ts, drift contrato BE↔FE del list, TOCTOU no-tx, qty sin roundQty, etc.) → re-review CLEAN.** Suite BE 2851/0, FE 2083/0. **Para activar: prender el flag.** Archivado en `openspec/changes/archive/2026-06-09-inventory-material-deduction/`.
- **Wave 7 — Dashboard unificado + impeccable**: vista por ubicación (depósito/cliente/técnico/camioneta), el ledger de movimientos, alertas de stock bajo (`minStock`). Reconciliar/unificar las 6 páginas `/inventory/*` con el modelo nuevo.

### Cross-cutting / a tener en cuenta
- **Serializado vs consumible**: equipos (SN único, ledger por unidad) vs materiales (cantidad por ubicación). Tratarlos distinto.
- **IClass tiene** `/equipments`, `/materials`, `/equipments/move`, `/materials/move` (skill `iclass-ipnext`): podríamos espejar o empujar movimientos — decidir si v1 es solo-lectura (consumir eventos) o bidireccional.
- **Auto vs semi-auto**: el usuario quiere ambos modos configurables (como los flags del cierre). El semi-auto reusa el patrón confirm/discard del #19.
- **Foreign keys en todo**: cada movimiento atado a tarea/técnico/ubicación/unidad.

### Fuentes (investigación de patrones)
- [Field Service Inventory Management: 2026 Guide — FieldPulse](https://www.fieldpulse.com/resources/blog/field-service-inventory-management)
- [Field Service Inventory Management Playbook — BuildOps](https://buildops.com/resources/field-service-inventory-management)
- [Real-Time Multi-Location Stock Control For Field Teams](https://small-business-inventory-management.com/inventory-asset-tracking-for-industries/field-inventory-management-software.htm)

> **Próximo paso**: arrancar **Wave 1** (la fundación + la decisión de unificación) con `/sdd-new inventory-foundation`. Cada wave es un SDD independiente; el orden importa (1 antes que todo; 4 y 6 dependen de 1).

---

### #37 — Loguear fallos del reconcile + badge de cantidad en la página  *(HECHO 2026-06-08)*
- **Disparador**: investigando la discrepancia del #36 (4 OS cerradas pero clavadas = las `failed=6` del reconcile), descubrimos que el `catch` de `reconcileOne` **tragaba el error entero** (`catch {` sin capturar `err`) — cada fallo requería arqueología manual (IClass + DB).
- **Resuelto** (SDD `reconcile-observability`, multi-repo): BE — el `catch` bindea el error y loguea `[backfill] task <sequenceNumber> FAILED: <message>` antes de contar `failed` (cubre batch y 1x1). FE — pill sutil `{n} en Registrado en IClass` en la página de Reconciliar, desde `items.length` (no driftea), oculto en vacío. impeccable.
- **PR**: BE #84 + FE #57. Sin migración. Verify SDD: 6/6 (BE 2578, FE 2004). Archivado en `openspec/changes/archive/2026-06-08-reconcile-observability/`.

### #36 — Normalizar match de result-code (motivoFechamento con punto)  *(HECHO 2026-06-08)*
- **Disparador**: 45 tareas clavadas en "Registrado en IClass". Verificado en vivo (IClass real + DB prod): de las 12 más viejas, **8 estaban `Concluida`** en IClass sin transicionar; 4 legítimamente abiertas.
- **Causa (bug de IClass)**: cerraron con `motivoFechamento = "Cliente Ausente."` (con punto), pero el catálogo de IClass devuelve `codigo = "Cliente Ausente"` (sin punto). El match en `resolveResultCode` era exacto → `rc=null` → se espejaba pero `moved=0`. El adapter ya toleraba case + whitespace externo; el gap era la puntuación final. Hipótesis previas (ventana 29d / OS abiertas) descartadas por la verificación.
- **Resuelto** (SDD `result-code-match-normalize`, BE-only): helper puro `normalizeResultCode` (trim → lowercase → strip puntuación final → collapse whitespace, conservador) + finders normalizados en el port y ambos adapters. `resolveResultCode`: exact-match primero + normalizado como fallback, preservando soTypeId. **Sin migración ni reset** — el path idempotente (`IngestClosedServiceOrders.ts:187-196`) re-evalúa el stage cada corrida → las clavadas se mueven solas.
- **PR**: BE #83. Sin migración. Verify SDD: PASS 10/10 (suite 2576). Archivado en `openspec/changes/archive/2026-06-08-result-code-match-normalize/`.

### #35 — Reset de auditAttempts + página de Reconciliar 1x1/batch  *(HECHO 2026-06-08)*
- **Disparador**: tras el #34 (map-reduce), el reprocess NO rescataba las OS que degeneraban — ya habían **quemado sus 3 `auditAttempts`** pre-#34 → `listPendingSideEffects` las excluye → el #34 nunca corría. Y el "Reconciliar" era todo-o-nada.
- **Parte 1 (BE PR #81)**: migración data-only `20260610000000_reset_burned_audit_attempts` — `UPDATE IClassServiceOrder SET auditAttempts=0 WHERE auditDone=false AND auditAttempts>=3` (mirror del #20). Idempotente, sin schema. Re-incluye las rendidas → el reprocess + #34 las rescata. **Aplicó en prod.**
- **Parte 2 (BE PR #82 + FE PR #56)**: capability `iclass-closure-reconcile`. BE: `reconcileOne` extraído de `BackfillClosedServiceOrders` (batch byte-idéntico) + `ReconcileTaskClosure(taskId)` síncrono 200 + `ListInFlightTasks`→DTO + rutas `GET /closure/in-flight` y `POST /closure/reconcile/:taskId`. FE: página `/admin/scheduling/iclass/closure/reconcile` con lista de in-flight, botón 1x1 por fila + "Reconciliar todas" (batch), refresca tras reconciliar. impeccable.
- **Verify SDD**: PASS 15/15 (BE suite 2553, FE 2002). Archivado en `openspec/changes/archive/2026-06-08-reconcile-page-and-audit-reset/`.

### #34 — Auditor IA: map-reduce ante degeneración del modelo  *(HECHO 2026-06-08)*
- **Disparador**: con el reprocess drenando, algunas OS multi-foto degeneran (`qwen2.5vl:7b` devuelve `<|im_start|>` en loop en vez de JSON → soft-fail → no persiste → reintenta con las mismas fotos → degenera igual). Visto en prod (OS 4564).
- **Pivot de enfoque (feedback del usuario)**: la primera idea (escalera que tira fotos 8→3→0) se descartó —las fotos SON contexto—; el usuario pidió usar las 8 **1x1**.
- **Resuelto** (SDD `audit-degeneration-retry`, BE-only): **map-reduce**. Attempt 1 = una llamada con las 8 fotos (rápido, anda para la mayoría); si degenera → MAP (cada foto 1x1 → descripción en texto, sin schema) + REDUCE (una llamada solo-texto con el contexto + las 8 descripciones → hallazgos con schema). **Ninguna foto se pierde**, el modelo nunca ve el prompt gigante. Fotos descargadas una vez y reusadas. Gateado por `mapReduceOnDegeneration` (default ON), fallback solo en degeneración.
- **PR**: BE #80. Sin migración. Verify SDD: PASS 11/11 (suite 2537). Archivado en `openspec/changes/archive/2026-06-08-audit-degeneration-retry/`.

### #33 — Backfill resiliente al rate-limit de IClass (HTTP 429)  *(HECHO 2026-06-08)*
- **Disparador**: tras el #32 (backfill async), "Reconciliar" no hacía nada. Diagnóstico vía logs del VPS: `[backfill-scheduler] ERROR: IClass responded with HTTP 429` — el backfill rafagueaba ~78 llamadas a IClass sin pausa → 429 → un solo 429 abortaba todo el batch.
- **Resuelto** (SDD `iclass-rate-limit-backfill`, BE-only): `IClassClient` reintenta el **HTTP 429** en `withAuthRetry` (`Retry-After`/backoff, acotado a `MAX_RATE_LIMIT_RETRIES=4`) — **protege TODAS las llamadas a IClass**; el 401 sigue solo en attempt 0 y el path 200-texto "Espere um pouco" intacto. `BackfillClosedServiceOrders` con try/catch por tarea (contador `failed` top-level, distinto del `errored` por-SO) + throttle (350ms) entre tareas. Mantiene el modelo 1x1 async del #32. `failed` llega al status + el log del scheduler.
- **PR**: BE #79. Sin migración. Verify SDD: PASS 11/11 (suite 2523). Archivado en `openspec/changes/archive/2026-06-08-iclass-rate-limit-backfill/`.

### #32 — Backfill async + TODA acción al LLM async + página independiente de pendientes  *(HECHO 2026-06-08)*
- **Disparador**: "No se pudo reconciliar" en prod. Diagnóstico vía logs del VPS (cero errores en 3h → timeout, no crash): `BackfillClosedServiceOrders` hacía ~78 llamadas IClass secuenciales + OCR/audit por OS, **síncrono dentro del request** → timeout. Mismo patrón del #23, pero el backfill nunca se había hecho async.
- **Resuelto** (SDD `closure-actions-async`, multi-repo, apply BE∥FE en paralelo): nuevo `BackfillScheduler` (espeja `TaskAutocompleteScheduler`: `inFlight` + `PgAdvisoryLock('iclass-closure-backfill')` + `triggerNow()` fire-and-forget, **sin cron**); la ruta devuelve **202**/503 y no bloquea. **Auditoría del scope**: el backfill era el ÚNICO entry point HTTP sync que tocaba el LLM/loop IClass — el reprocess ya era async (#23), el resto es rápido → con esto **ninguna acción de cierre bloquea el request**. FE: el contador pasó a `Link` → **`ClosurePendingPage`** standalone (gate `iclass.manage`) a donde se mudó la `ClosureProgressTable` del #31; banner del Reconciliar "encolada"/"en curso"/"no disponible". Front con **impeccable**.
- **PRs**: BE #78 / FE #54. Sin migración. Verify SDD: PASS 14/14 (suite BE 2509, FE closure 40/40). Archivado en `openspec/changes/archive/2026-06-08-closure-actions-async/`.
> Reglas de trabajo en [`WORKFLOW-MULTI-REPO.md`](./WORKFLOW-MULTI-REPO.md). Estado vivo también en engram (`sdd/*`).

---

## ✅ Hechos (27, desplegados en producción)

### #19 — Agregar ítem de inventario MANUAL a la tarea
- **Resuelto** (SDD `task-manual-inventory-item`, automático + hybrid, multi-repo con apply BE∥FE en paralelo): nuevo use case `CreateManualSuggestion` + `POST /scheduling/:taskId/inventory/suggestions` (guard `inventory.write`) — DEVICE con tipo del catálogo + SN/MAC, o MATERIAL con descripción; `source='MANUAL'` entra al pipeline confirm/discard normal. Validación #18 extraída a `domain/services/suggestionCompleteness.ts` (compartida con el confirm). FE: `ManualSuggestionForm` inline + botón "Agregar ítem" **siempre visible** (el early-return del panel vacío era justo lo que dejaba sin salida a la OS sin foto de MAC).
- **2 bugs latentes arreglados** (los encontró la exploración): (a) el confirm etiquetaba todo lo no-OCR como `'ICLASS'` en el contrato (en `execute()` Y `replace()`) — ahora el source pasa through; (b) la clave natural del upsert de ingest era ciega al source → una sugerencia MANUAL pisaba la fila OCR del mismo SN/MAC; la clave ahora incluye `source` en ambos adapters.
- **PRs**: BE #73 / FE #49. Sin migración. Verify SDD: PASS 23/23 scenarios (suite BE 2430 + FE 1907). Archivado en `openspec/changes/archive/2026-06-08-task-manual-inventory-item/`.

### #20 — Audit IA: pasarle el detalle COMPLETO de IClass al modelo
- **Resuelto** (SDD `iclass-audit-full-context`, automático + hybrid): `AuditContext` ahora lleva `historyCommentary` (últimas 10 entradas CON comentario), `commentaryLog` (500 chars), `internalNote` (300) y `equipmentEvents` (20) del mirror — con presupuestos de recorte exportados en `buildAuditContext` (~1.5k tokens worst-case, seguro para qwen2.5vl:7b). `renderPrompt` agrega las secciones como bloques etiquetados condicionales (omitidos si vacíos) + instrucción siempre presente de NO marcar "falta X" si X está en el contexto.
- **Remediación**: migración data-only `20260607010000_remediate_audit_full_context` resetea `auditDone`/`auditAttempts` en `IClassServiceOrder` → el reprocess loop re-audita TODO con contexto completo (gradual; requiere flag `iclass-audit` ON + Ollama arriba).
- **PR**: BE #72. Verify SDD: PASS 12/12 scenarios. El design cazó un error del spec (los flags viven en `IClassServiceOrder`, no `ScheduledTask`). Archivado en `openspec/changes/archive/2026-06-07-iclass-audit-full-context/`.

### #21 + #24 + #26 — Tres chicos de FE en un PR (un commit por ítem)
- **#21 — Asterisco debajo del label (CreateTaskModal)**: `.label` es flex column → el texto y el `<span>*</span>` eran flex items separados y el `*` caía a su línea propia en TODOS los campos. Fix: texto+asterisco comparten un span inline (5 campos). Test estructural.
- **#24 — RV solo editable con `inventory.write`**: el BE ya lo exigía; el FE mostraba el botón a todos y el BE lo rechazaba. Sin permiso → indicador **read-only** (mismo footprint, sin botón, la info se sigue viendo). Gateado con `useCan('inventory.write')`.
- **#26 — Estado closed en blanco y negro (tickets)**: la columna Estado pasó de texto plano a **pill** con el color del catálogo; `closed`/`cerrado` → variante negra con texto blanco. Aplica a lista + Archivo (mismo componente).
- **PR**: FE #48 (commits d7af26e / 6b0b8f4 / c201d63). Sin BE. Sin migración.

### #27 — Filtro de Prioridad en tareas no filtraba
- **Resuelto** (FE-only, directo con TDD). **Causa raíz**: el select manda el **name del catálogo** `TaskPriority` (Baja/Normal/Alta/Urgente — la migración `20260526010000` convirtió hasta las tareas legacy a esos nombres), pero `useTasksFilterUrl` whitelisteaba el valor de la URL contra el **enum legacy** (`low/normal/high/urgent`) en cada read/merge → todo valor real parseaba a `undefined` y el filtro nunca salía en el request. La cadena del BE estaba perfecta (ruta ✓ zod free-text ✓ `ListTasks` passthrough entero ✓ `where['priority']` ✓) — se verificó PRIMERO, aplicando la lección del #28.
- **Fix**: fuera la whitelist `parsePriority`; eliminado el union legacy `TaskPriority` de `types/scheduling` (el typecheck cazó el único otro uso: un cast inútil en `KanbanCard`). 4 tests nuevos de round-trip en `useTasksFilterUrl.test.tsx`.
- **PR**: FE #47. Sin cambios BE. Sin migración. Lección documentada en [`WORKFLOW-MULTI-REPO.md`](./WORKFLOW-MULTI-REPO.md) ("Testear el SEAM completo").

### #28 — Filtro de Asignado en tickets traía sin-asignar (follow-up del #25) + contrato FE de tickets roto
- **Resuelto** (directo con TDD, sin SDD). **Causa raíz BE**: `ListTickets` (use case) reconstruía el query campo a campo y **descartaba `assigneeId`/`from`/`to`** — el #25 cableó la ruta y los repos, pero el filtro moría en el medio (los tests de ruta mockean el use case y los de filtros pegan al repo: el seam no tenía cobertura). Test nuevo con el use case real + repo in-memory.
- **Yapa FE** (mismo combo, contrato legacy del mock): (a) `useAssignTicket` pegaba a `PATCH /tickets/:id/assign` — ruta inexistente (404) — con `Number(uuid)`=NaN → **asignar nunca persistía**; ahora `PATCH /tickets/:id` con `{assigneeId}`. (b) La columna "Asignado a" leía `assignedToName` y el detalle `assignedTo`, campos que el BE no manda (`assigneeId`/`assigneeName`) → todo se veía sin asignar. (c) Crear ticket mandaba `message`+`assignedTo:number`, pero el POST exige `description` (400) y lee `assigneeId:string`. Nuevo `ticketsWireContract.test.tsx` pinea el contrato real en el boundary de axios.
- **PRs**: BE #71 / FE #46. Sin migración.

### #25 — Filtros del listado de tickets (asignado + fechas) ahora aplican
- **Resuelto** (SDD `ticket-assignee-filter`): filtrar por **Asignado** no hacía nada (traía sin-asignar) y las **fechas** (from/to) tampoco — el filtro se perdía en TODAS las capas (query FE, ruta, port, where del repo). Ahora `ListTicketsQuery` + `PrismaTicketRepository.list` filtran por `assigneeId` (exacto) y `createdAt` (rango, fin de día en `to`); la ruta lee/mapea `assignedTo→assigneeId`; el FE manda los params. Tareas ya filtraban server-side (sin cambios).
- **PRs**: BE #68 / FE #45. Sin migración. Archivado en `openspec/changes/archive/2026-06-07-ticket-assignee-filter/`.

### #12 — Filtros usables en "Todos los proyectos" (filtrar por categoría de estado)
- **Resuelto** (SDD `tasks-category-filter`, FE-only): sin proyecto seleccionado, el filtro de Estados muestra las 4 **categorías** (Nuevo / En progreso / Hecho / Cancelado, selección única) y setea `filter.stageCategory` — que ya filtraba client-side. Con proyecto, mantiene los stages del workflow. Cambiar de proyecto limpia el modo opuesto; la categoría activa muestra chip.
- **PR**: FE #44. Sin backend (el filtrado por `stageCategory` ya existía). Archivado en `openspec/changes/archive/2026-06-07-tasks-category-filter/`.

### #11 — Rediseño de la lista de tickets (como tareas) + ID autoincremental
- **Resuelto** (SDD `tickets-redesign-sequence`): la lista de tickets se rediseñó **espejando la de tareas** (single-column: header → barra de filtros horizontal → tabla full-width; `#sequenceNumber` linkeado; prioridad como pill color-coded). BE: `Ticket.sequenceNumber` (Int autoincrement) + migración con backfill por `createdAt` (réplica del patrón de tareas).
- **PRs**: BE #65 / FE #42. Migración `20260607000000_add_ticket_sequence_number`. Archivado en `openspec/changes/archive/2026-06-07-tickets-redesign-sequence/`.
- **Nota**: se eligió "como las tareas" (filtros visibles en barra horizontal) en vez del "ocultos con botón" del item original. Solo la LISTA (el detalle quedó fuera de scope). El worktree viejo `tickets-redesign-fe` se descartó (desactualizado).

### #14 — Campos de completitud del cierre por tarea + auto-completado
- **Resuelto** (SDD `task-completeness-tracking`): 3 flags en `ScheduledTask` (`closureCommentDone`, `closureAuditDone`, `closureHasDeviceInventory` — este último cuenta **solo equipos DEVICE**, no materiales) marcados por el closure (loop/reprocess/cron) vía `markClosureCompleteness`. Migración con backfill idempotente. Cron `TaskAutocompleteScheduler` (flag `task-autocomplete`, default OFF) que reusa `ReprocessClosureSideEffects`. La API de tareas expone los flags para medir.
- **PRs**: BE #63 / FE #41. Migración `20260606020000_task_completeness_fields`. Archivado en `openspec/changes/archive/2026-06-06-task-completeness-tracking/`.
- **Post-deploy**: prender el flag `task-autocomplete` (Cierre de OS) si se quiere el auto-completado automático.

### #18 — Bug: confirmar inventario sin data (validación de datos mínimos)
- **Resuelto** (SDD `inventory-confirm-validation`): guard fail-closed en `ConfirmInventorySuggestion` (`execute` + `replace`) — DEVICE requiere SN o MAC, MATERIAL requiere descripción; sin eso, `IncompleteSuggestionError` → HTTP 422. FE: `SuggestionCard` deshabilita los botones de confirmar + hint del por qué. Eliminado el fallback silencioso a "OTRO" (visto en OS 4175).
- **PRs**: BE #61 / FE #40. Sin migración. Prerequisito del #19. Archivado en `openspec/changes/archive/2026-06-06-inventory-confirm-validation/`.

### #22 — Bug: inventario con foto pero sin SN cuando el OCR falla
- **Resuelto** (SDD `closure-ocr-failure-retry`): el OCR ahora distingue el **fallo técnico** (LLM caída/timeout → `failed`) del label ilegible. Ante fallo técnico NO se cachea la extracción ni se crea el DEVICE incompleto y NO se marca `inventoryBuilt` → el reprocess re-OCR-ea. Una migración de remediación destildó los históricos y borró las extracciones `ocr-error` + los DEVICE pending vacíos.
- **PR**: BE #59. Migración `20260606010000_remediate_ocr_failed_inventory`. Archivado en `openspec/changes/archive/2026-06-06-closure-ocr-failure-retry/`.
- **Post-deploy**: correr "Reprocesar" (con la LLM arriba) para completar los SN de los inventory destildados.

### #7 — Unificar sub-page "Cierre de OS" + feature flag del auditor IA
- **Resuelto** (SDD `iclass-audit-flag-and-unify`): el auditor IA pasó de gatearse por env `ICLASS_AUDIT_ENABLED` a un feature flag DB-backed `iclass-audit` (runtime, toggleable en UI, default OFF). El gate vive en `AuditInstallationQuality.execute()` → aplica al closure-loop **y** al reprocess. FE: la sub-page "Cierre de OS" unifica loop + reconciliar + reprocess + mapeo de resultados + toggle del auditor (**5 → 4 sub-tabs**).
- **PRs**: BE #57 / FE #39. Migración `20260606000000_seed_iclass_audit_flag`. Archivado en `openspec/changes/archive/2026-06-06-iclass-audit-flag-and-unify/`.
- **Post-deploy**: prender el flag `iclass-audit` desde la UI (arranca OFF) para reactivar el auditor.

### #17 — Activity log: nombre de los observadores (watchers)
- **Resuelto** (SDD `activity-watcher-names`, Approach B): el nombre del watcher se resuelve en `UpdateTask` vía el admin lookup (que ya validaba los watchers) y viaja en `metadata` (`toName`/`fromName`); el FE lo muestra como "agregó/quitó a {nombre}". Sin migración.
- **PRs**: BE #55 / FE #38. Archivado en `openspec/changes/archive/2026-06-06-activity-watcher-names/`.

### #1 — Crear tarea: proyecto + descripción obligatorios
- **Qué se pidió**: el select de proyecto al crear tarea venía pre-seleccionado ("Fibra los…"); se quería que arrancara sin proyecto, obligatorio elegir uno, y descripción obligatoria.
- **Cómo se resolvió**: `CreateTaskModal` arranca con placeholder "— Seleccionar proyecto —" (sin auto-default); `canSave` exige proyecto + descripción no vacía; descripción marcada con `*`.
- **Dónde**: FE `CreateTaskModal.tsx`. **PR**: #28 (frontend). Directo con TDD (sin SDD).

### #2 — Refresh de tarea perdía Asignado + Proyecto
- **Síntoma**: al hacer F5 en la página de detalle de una tarea, los `<select>` de Asignado y Proyecto quedaban vacíos; había que salir y volver a entrar.
- **Causa raíz**: `react-hook-form` fija los `defaultValues` al montar; en frío las queries de `admins`/`projects` llegan DESPUÉS, las `<option>` no existen aún y el select cae al vacío sin re-aplicarse.
- **Fix**: hidratación ref-guarded de `assigneeId` + `projectId` cuando llegan las options (mismo patrón que ya existía para `contractId`).
- **Dónde**: FE `DatosForm.tsx`. **PR**: fix/scheduling-bugs-batch1-fe.

### #3 — "Revisado por inventario": mostrar OK + quién lo marcó
- Era parte del cambio `equipment-catalog` (F3).
- **Fix**: columnas `reviewedByInventoryAt` + `reviewedByInventoryUserId` (FK `RbacUser`, `onDelete: SetNull`); el use-case threadea el actor desde `req.user`; el DTO expone `reviewedByInventoryAt` + `reviewedByInventoryUserName`; badge FE "✓ Revisado · {nombre} · {fecha}".
- **Dónde**: BE `ScheduledTask`, `SetTaskInventoryReview`, `scheduling.routes`; FE `InventoryPanel` (TaskTabs). **PRs**: #29 (BE) / #25 (FE).

### #4 — Confirmar equipo: respetar el tipo elegido + mantener diseño
- **Síntoma**: al confirmar una sugerencia salía "✓ ONU — confirmado" (texto plano), perdía la foto/diseño y no respetaba el tipo elegido (era antena).
- **Causa raíz**: el ítem del contrato sí quedaba con el tipo correcto, pero la sugerencia conservaba su `deviceType` escaneado, y la card resuelta era texto plano.
- **Fix**: el use-case persiste el tipo elegido en la sugerencia; la card resuelta mantiene foto + diseño read-only con badge de estado.
- **Dónde**: BE `ConfirmInventorySuggestion`, `setStatus`; FE `SuggestionCard`, `TaskInventorySuggestions`. **PRs**: #22 (BE) / #24 (FE).

### #5 — Catálogo de equipos (antenas/onu/router/otros)
- Cambio `equipment-catalog` (F1). Reemplaza el enum hardcodeado (`VALID_DEVICE_TYPES`, duplicado en 4 lugares) por una tabla editable `DeviceTypeCatalog`.
- Validación dinámica: OCR/confirm/guards leen del catálogo. `OTROS` no-borrable. Migración aditiva que siembra los 5 base idempotente.
- **PR**: #29 (BE). Archivado en `openspec/changes/archive/2026-06-03-equipment-catalog/`.

### #6 — Sub-page de configuración del catálogo
- Cambio `equipment-catalog` (F2). `/admin/inventory/settings` → tab "Equipos" (ABM, espeja `TaskPrioritiesBody`). Dropdowns de inventario leen del catálogo vía `useDeviceTypes`.
- Gateado: `inventory.read` (página) + `inventory.manage` (mutaciones). **PR**: #25 (FE).

### #13 — Búsqueda de tareas rota
- **Síntoma**: buscar por un nombre no devolvía nada.
- **Causa raíz**: el `where` solo buscaba en `title`; buscar por nombre de cliente no matcheaba.
- **Fix**: `where` ahora es un OR sobre **title + customer.name + address**, y matchea el `sequenceNumber` exacto si el término es numérico (Prisma + InMemory, con helper `seedCustomerName`).
- **Dónde**: BE `PrismaSchedulingRepository`, `InMemorySchedulingRepository`. **PR**: #28.

### #8 — Gestión de inventario del servicio (modelo de 3 conceptos)
- **Qué se pidió**: traer el inventario actual del servicio/contrato para validar contra el nuevo; CRUD para quitar/agregar/modificar; agregar otra MAC o material; permisos granulares; materiales como categoría separada.
- **Cómo se resolvió** (cambio SDD `service-inventory-management`, modo automático, 6 batches):
  - **Equipos** = `ContractInstalledItem` (estado): CRUD + **quitar** (soft-delete idempotente: re-quitar = no-op, DELETE→200+item) + cambio de tipo validado vs catálogo.
  - **Catálogo de materiales** = `MaterialCatalog` (nuevo, espeja DeviceTypeCatalog + `unit`): ABM en tab "Materiales" de config (gate `inventory.manage`).
  - **Consumo por visita** = `TaskMaterialConsumption` (nuevo, ledger por tarea); `ConfirmInventorySuggestion` ramifica por kind (DEVICE→ítem, MATERIAL→consumo) — cierra el agujero de materiales huérfanos.
  - **F4**: el sidebar "Inventario del cliente" muestra el inventario real del contrato (read-only).
  - **Permisos**: `inventory.read`/`write`/`manage`; rutas del contrato migradas de `clients.*`→`inventory.*`.
- **Fuera de scope (futuro)**: `stockQuantity` (la base que sube/baja), reportes de costo de material, reemplazo de equipo (`status='replaced'`).
- **Dónde**: BE PR #31 / FE PR #26. Archivado en `openspec/changes/archive/2026-06-03-service-inventory-management/`. 3 migraciones aditivas.

### #15 — GR ingesta: reporter = "Api"
- **Qué se pidió**: en la ingesta de OS de Gestión Real, la `ScheduledTask` debía reportarse con un usuario "Api" (sistema/API), no `null`.
- **Cómo se resolvió**: `bootstrapApiUser` idempotente siembra un `RbacUser` de sistema (`login=api`, `name=Api`, passwordHash inutilizable → no puede loguear), asegurado en el arranque del ingest. El use-case resuelve su id **por run** (`findByLogin`) y lo estampa como `reporterId`; usuario ausente → `null` (degradado, no aborta el batch).
- **Dónde**: BE `bootstrapApiUser.ts` (nuevo), `IngestGestionRealOrders` (inyecta `RbacUserRepository`), `bootstrapGestionRealIngest`. **PR**: #39. Sin migración (el usuario es data en `RbacUser`).
- **Verificado en prod**: tarea OS 17741 recreada con `reporterId` = usuario Api.

### #16 — GR ingesta: traer comentario de la OS a la tarea
- **Qué se pidió**: al crear la tarea desde GR, traer el comentario de la OS y pegarlo en la `description`.
- **Cómo se resolvió**: el campo de GR es **`observaciones`** (confirmado contra la API real). Se agregó a `GrServiceOrder`, se mapea en `parseServiceOrdersResponse` decodificando HTML entities con `he`, y el use-case lo usa como `description` de las tareas normales. Las needs-review conservan su motivo REVISAR (no se pisan).
- **Dónde**: BE `gestionReal.ts`, `GestionRealClient.ts`, `IngestGestionRealOrders.ts`. **PR**: #39. Nueva dep `he`. Sin migración (aterriza en la columna `description` existente).
- **Verificado en prod**: tarea OS 17741 con `description` = comentario de GR, entities decodificadas ("instalación", no "instalaci&oacute;n").

### #10 — Activity log de la tarea
- **Qué se pidió**: la pestaña "Actividad" de la tarea era un `<ComingSoonPanel>`. Reemplazarla por un feed real de auditoría (creación, cambios de etapa/prioridad/asignado, comentarios, checklist, IClass, etc.).
- **Cómo se resolvió** (SDD `task-activity-log`, 5 fases, TDD estricto): tabla `ScheduledTaskActivity` (FK `actor→RbacUser`, `taskId` cascade) + `GET /api/scheduling/:id/activity` (cursor keyset) + recorder best-effort (nunca aborta la operación) + **15 use-cases de escritura instrumentados** + diff engine de `UpdateTask` (14 familias). FE: pestaña Actividad consume el feed con `useInfiniteQuery`, `describeActivity` mapea ~30 tipos a texto humano, gateada con `scheduling.read`.
- **Dónde**: BE PR #41 (migración `20260604120000`) / FE PR #30. Archivado en `openspec/changes/archive/2026-06-03-task-activity-log/`. Verify SDD: PASS 20/20.
- **Verificado en prod**: tabla creada + migración aplicada + FK a `RbacUser` confirmados en la DB; pestaña Actividad desplegada.

### #9 — Crear tarea desde ticket: redirigir + relacionar
- **Qué se pidió**: al crear una tarea desde un ticket, redirigir a la tarea y que el ticket aparezca en "Relacionado".
- **Cómo se resolvió** (solo FE — el BE ya tenía el endpoint): causa raíz — el FE creaba la tarea por `POST /scheduling` (genérico), que **descarta el `ticketId` por diseño** (AD-7: no body-overridable). Fix: usar el endpoint dedicado `POST /tickets/:id/tasks` (ata el ticketId al path + lo persiste) vía `createTaskFromTicket`/`useCreateTaskFromTicket`, y redirigir a `/admin/scheduling/tasks/:id`. El tab "Relacionado" ya renderiza el ticket.
- **Dónde**: FE PR #33. Sin cambios BE.

---

### #29 — Tarea de RED (network-only task, solo nodo)  *(HECHO 2026-06-08)*
- **Resuelto** (SDD `network-node-task`, multi-repo, apply BE∥FE en paralelo): side-button rojo en el modal togglea a modo nodo (sin cliente/contrato), Nodo del catálogo `NetworkSite`, mismo flujo (proyecto/stages/IClass) con badge RED. `ScheduledTask` gana `kind` (discriminador) + `networkSiteId` FK; `NetworkSite` gana `iclassNodeCode`; el dispatch a IClass sustituye campos node-derived (name/address/city del sitio, `customerCode='NETWORK'`, `phone='0000000000'`) + `nodeCode` override explícito. Front con **impeccable** (acento OKLCH terracota).
- **PRs**: BE #75 / FE #51. Migración `20260608000000_network_node_task`. Verify SDD: PASS 16/16. Archivado en `openspec/changes/archive/2026-06-08-network-node-task/`.

### #31 — Reestructurar "Cierre de OS" + vista de progreso por tarea  *(HECHO 2026-06-08)*
- **Resuelto** (SDD `closure-page-restructure`, multi-repo, apply BE∥FE en paralelo): el "Mapeo de estado" (`IClassResultCodeMappingBody`) salió a su propio sub-tab; el tab `cierre` se relabeló **"Procesamiento"** (id preservado → deep-links intactos) y suma una **`ClosureProgressTable`** que muestra, por OS pendiente, comentario/inventario/auditoría ✓/✗ + `auditAttempts` + link a la tarea (#seq · título). 5 sub-tabs. Nuevo `GET /closure/reprocess/pending-list` (use case `GetPendingSideEffectsList` + port `listPendingSideEffectsWithTask`, JOIN sin N+1); `usePendingList` pollea y para al llegar a 0. Front con **impeccable** (pills ✓/✗ semánticos). Responde la pregunta del operador "¿de qué son los N pendientes?".
- **PRs**: BE #76 / FE #52. Sin migración. Verify SDD: PASS 15/15. Archivado en `openspec/changes/archive/2026-06-08-closure-page-restructure/`.

### #30 — Intervalos de los crons de cierre ajustables desde la UI  *(HECHO 2026-06-08)*
- **Resuelto** (SDD `cron-interval-config`, BE + control FE): el cron de cierre (10 min) y el de auto-completado (15 min) tenían el intervalo hardcodeado; ahora lo leen de un config singleton en la DB (`IClassClosureConfig`, espeja el patrón de Gestión Real). `GET/PUT /closure/config` (guard `iclass.manage`, Zod floor 60000ms). `main.ts` pasó a un **async IIFE** que lee el config una vez y awaitea ambos bootstraps con los intervalos persistidos antes de `createApp`. El cambio aplica en el próximo reinicio (se lee al bootstrap). FE: card "Frecuencia de los procesos automáticos" en la tab "Procesamiento" (slot del #31), con impeccable.
- **PRs**: BE #77 / FE #53. Migración `20260609000000_iclass_closure_config` (aditiva, sin seed). Verify: suite BE 2501 + FE 1977, container boot confirmado en prod. Archivado en `openspec/changes/archive/2026-06-08-cron-interval-config/`.

## Refinamientos del #8 (ya en prod, NO son ítems numerados)

Dos follow-ups del inventario shippeados el 2026-06-03 (archivados en `openspec/changes/archive/`):
- **inventory-edit-and-match**: editar el tipo de un equipo confirmado (admin) sincronizando sugerencia + contrato + sidebar (fix tarea 4691); match de sugerencias contra el inventario actual (badge SN/MAC → "ya instalado" / tipo → "posible reemplazo").
- **inventory-confirm-dedup-replace**: el match pasa de aviso a acción — frena el duplicado del mismo equipo; ofrece "Agregar" o "Reemplazar la actual" (la vieja → `status='replaced'` + `replacesItemId`).

## Refinamientos del #10 (post-deploy 2026-06-04, ya en prod)

Tres iteraciones del activity log pedidas tras usarlo en serio (no son ítems numerados):
- **FKs faltantes**: el diff engine no trackeaba contrato/cliente/partner (por eso cambiar el contrato no generaba log) → se agregaron `contract_changed` / `customer_changed` / `partner_changed`. BE PR #43 / FE PR #34.
- **Diff legible en todo el feed**: los eventos FK con nombre muestran el cambio (proyecto/cliente/reportante/asignado: "cambió el proyecto: A → B", "asignó a Juan", "reasignó: A → B"); contrato/partner por presencia ("quitó el contrato"); fechas, dirección y descripción muestran from→to. BE PR #44 / FE PR #35.
- **Refresh en vivo**: el feed se invalida tras update/stage/checklist/inventario/comentarios → el evento aparece **sin recargar la página**. FE PR #34.
- **Pendiente → promovido a #17**: los observadores (`watcher_added/removed`) muestran "agregó/quitó un observador" **sin nombre** — el único evento sin diff completo. Ahora es el ítem **#17** en Pendientes.

## Notas de priorización (lectura del equipo)

- **Epic Tickets**: #9 ✅ hecho; queda **#11** (rediseño + ID autoincremental + filtros). **Epic Integraciones/flags** (#7 + #14): conviene agruparlos.
