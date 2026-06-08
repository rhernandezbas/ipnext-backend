# Backlog — IPNext (Prominense)

> Backlog de trabajo sobre los dos repos (`ipnext-backend` + `ipnext-frontend`).
> Arrancó el 2026-06-03 con 14 ítems; +2 (#15, #16) → 16; +1 (#17); +2 (#18, #19); +1 (#20); +2 (#21, #22); +2 (#23, #24); +2 (#25, #26); +1 (#27); +1 (#28) → **28 totales**.
> **31 hechos (en prod) · 1 en curso (#32).** (#17, #7, #22, #18, #14, #11, #12, #25, #20, #19, #23, #29, #31, #30 cerrados vía SDD.)

## 🔧 En curso (1)

### #32 — Backfill async + TODA acción al LLM async + página independiente de pendientes  *(agregado 2026-06-08)*
- **Disparador**: "No se pudo reconciliar" en prod. Diagnóstico (logs del VPS, cero errores en 3h → timeout no crash): `BackfillClosedServiceOrders` hace `listTasksInIClassStage('registered_in_iclass')` (78 tareas) × 1 llamada IClass c/u **secuencial dentro del request** + corre `runClosureSideEffects` (OCR+audit Ollama) por cada cerrada → timeout. Mismo patrón del #23 pero el backfill nunca se hizo async.
- **Qué (pedido usuario)**: (1) **backfill/Reconciliar async** (202 + background, patrón #23); (2) **cualquier acción que dispare el LLM** (Ollama: OCR/audit) o un loop largo a IClass **debe ser async** — auditar TODOS los entry points HTTP sync (backfill, cierre manual si existe, etc.); el reprocess ya lo está. (3) **Página independiente de pendientes**: el contador "N pendientes" (en la card de Reprocesar / Side-effects) pasa a ser **clickeable** y lleva a una **page propia** donde vive la lista; la `ClosureProgressTable` del #31 **se mueve allí** (sale del sub-tab Procesamiento). **impeccable** en el front.
- **Dónde**: BE — pasar `BackfillClosedServiceOrders` (y cualquier otro disparador LLM/IClass-loop sync) al patrón `triggerNow`/fire-and-forget 202; FE — nueva ruta/página de pendientes + mover la tabla + el contador como link. Permiso `iclass.manage`.
- **Tamaño**: mediano. **Relación**: cierra el círculo del #23/#31 (async + observabilidad).
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
