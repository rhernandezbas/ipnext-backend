# Backlog — IPNext (Prominense)

> Backlog de trabajo sobre los dos repos (`ipnext-backend` + `ipnext-frontend`).
> Arrancó el 2026-06-03 con 14 ítems; +2 (#15, #16) → 16; +1 (#17); +2 (#18, #19); +1 (#20); +2 (#21, #22); +2 (#23, #24); +2 (#25, #26); +1 (#27); +1 (#28) → **28 totales**.
> **21 hechos (en prod) · 7 pendientes.** (#17, #7, #22, #18, #14, #11, #12, #25 cerrados vía SDD.)
> Reglas de trabajo en [`WORKFLOW-MULTI-REPO.md`](./WORKFLOW-MULTI-REPO.md). Estado vivo también en engram (`sdd/*`).

---

## ✅ Hechos (21, desplegados en producción)

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

## ⏳ Pendientes (7)

### #19 — Agregar ítem de inventario MANUAL a la tarea (antena/onu/router/etc.)  *(agregado 2026-06-04)*
- **Qué**: hoy las sugerencias de inventario salen **solo** del cierre (OCR de fotos device + materiales de IClass). Se quiere poder **agregar manualmente** un ítem de inventario en la tarea — elegir el tipo del catálogo (antena/onu/router/otros) y cargar su SN/MAC/datos — sin depender de que el OCR lo haya detectado.
- **Caso clave (visto 2026-06-06)**: una OS **sin foto de MAC** no genera ninguna sugerencia → el panel de inventario queda **vacío** y hoy no hay forma de cargar el equipo. Esto NO lo resuelve el #22 (ese re-OCR-ea cuando la LLM falló; acá directamente no hay foto que OCR-ear).
- **Camino propuesto**: nuevo use-case + endpoint para crear una sugerencia/ítem manual en la tarea (`source = MANUAL`, kind DEVICE/MATERIAL); FE botón "Agregar ítem" **siempre visible** en el panel de inventario de la tarea (incluso con panel vacío / sin sugerencias) con form (tipo del `DeviceTypeCatalog` + SN/MAC/desc). Reusa la validación del #18.
- **Dónde**: BE nuevo use-case (`AddTaskInventoryItem` o similar) + ruta bajo `/scheduling/:taskId/inventory`; FE `TaskInventorySuggestions` (form de alta). Permiso `inventory.write`.
- **Tamaño**: mediano. **Relación**: depende del #18 (la validación) y se apoya en el catálogo del #5.

### #20 — Audit IA: pasarle el detalle COMPLETO de IClass al modelo  *(agregado 2026-06-06)*
- **Síntoma**: en OS con detalle en IClass (visto en la **4673** "Reparación de señal"), la IA marca warnings tipo *"no se especifica si se verificó la señal/conexión"*, *"el técnico no dejó observaciones"*, *"no se adjuntaron fotos"* — **cuando esa info SÍ está en los detalles de IClass**. La IA "refuta" porque audita con contexto incompleto.
- **Causa**: `buildAuditContext` solo arma el contexto con `checklistText` (Q/A no-foto), `technicianNote`, `materials`, `photoUrls`, `taskTitle/description/taskComments`. **NO incluye** del mirror: `order.history` (status history con `commentary` por transición — el "qué pasó" en cada paso), `order.commentaryLog` (blob de comentarios de IClass), `order.internalNote` (obs interna), `order.equipmentEvents` (equipos install/remove/move con SN/MAC).
- **Camino propuesto**: enriquecer `buildAuditContext` + el prompt con esos campos. Cuidar: (a) tamaño del prompt (el history puede ser largo — resumir/recortar); (b) re-auditar las ya hechas tras el cambio (poner `auditDone=false` + reprocesar para que tomen el contexto nuevo).
- **Dónde**: BE `buildAuditContext.ts` + `OllamaInstallationAuditor.renderPrompt` + entity `AuditContext` (nuevos campos).
- **Tamaño**: chico-mediano.

### #21 — Bug (FE): el asterisco de obligatorio aparece DEBAJO del label, no al lado  *(agregado 2026-06-06)*
- **Síntoma**: en el modal de crear tarea, el `*` de campo obligatorio cae en una línea aparte ("Proyecto" y abajo "*") en vez de "Proyecto *" en la misma línea. Pasa en **todos** los campos del modal.
- **Camino propuesto**: el `*` debe ir inline con el label (revisar el CSS del label / required-marker — probablemente un `display:block`, un `<br>` implícito o un wrap del span). Corregir el componente del label, no campo por campo.
- **Dónde**: FE `CreateTaskModal` + su CSS module (el marcador de requerido).
- **Tamaño**: chico.

### #23 — Auditor IA + OCR de inventario 100% asíncronos (background, no bloqueantes)  *(agregado 2026-06-07)*
- **Síntoma**: el "Reprocesar" corre los side-effects pesados (OCR de inventario + auditoría IA) **síncrono dentro del request HTTP** → con carga (reprocess masivo) el modelo `qwen2.5vl:7b` tarda y el request corta con "No se pudo reprocesar", **aunque el backend siga procesando** en background. Visto el 2026-06-07.
- **Qué se quiere**: que TODO el procesamiento de auditor IA y OCR de inventario sea **asíncrono** — el endpoint encola/dispara y devuelve al toque (202); el job corre en background y **tarda lo que tenga que tardar**, sin timeout. El progreso se mira por el tracking de side-effects + los flags de completitud (#14).
- **Camino propuesto**: pasar `ReprocessClosureSideEffects` (y el closure) a un patrón job async (queue o fire-and-forget con lock). El botón "Reprocesar" responde "encolado". El cron `task-autocomplete` (#14) ya corre en background — unificar todo a ese modelo.
- **Dónde**: BE `ReprocessClosureSideEffects` + endpoint de reprocess + runner/queue; FE el botón muestra "encolado".
- **Tamaño**: mediano-grande. **Relación**: lo reveló el reprocess del 2026-06-07. NOTA: además el audit **degenera** bajo carga (el modelo devuelve JSON truncado `[`) — el async deja que tarde sin cortar, pero la degeneración puede requerir bajar `maxPhotos` (hoy 8) o más VRAM.

### #24 — RV en la vista general de tareas: solo editable con permiso  *(agregado 2026-06-07)*
- **Qué**: la columna **RV (Revisado por Inventario)** de la vista general de tareas solo la puede cambiar quien tenga el permiso de revisado por inventario (el **mismo** que ya exige la ruta: `inventory.write`).
- **Estado actual**: el BE ya está protegido — `PATCH /:id/inventory-review` exige `inventory.write` (`invWrite`). Falta el **FE**: en la lista general, ocultar/deshabilitar el control de RV para quien no tiene el permiso (hoy se ve/clickea y el BE lo rechaza).
- **Dónde**: FE tabla/columna RV de la vista general de tareas (gatear con `useMyPermissions().can('inventory.write')` / `<Can permission="inventory.write">`). BE ya OK.
- **Tamaño**: chico.

### #26 — Rediseño visual del estado "cerrado/closed" en tickets  *(agregado 2026-06-07)*
- **Qué**: el estado **closed/cerrado** en los tickets tendría que verse **mejor y diferenciarse fácil**. Propuesta del usuario: un diseño **blanco y negro** para distinguir de un vistazo los cerrados del resto.
- **Dónde**: FE — el badge/estilo del estado en la lista y/o detalle de tickets (`SuggestionCard`/columna `status`, tab "closed", `TicketDetailPage`). Reusar el color del catálogo de status donde aplique.
- **Tamaño**: chico.

### #27 — Bug: el filtro de Prioridad en tareas no filtra  *(agregado 2026-06-07)*
- **Síntoma**: en la lista de tareas, elegir una prioridad en el filtro no filtra (sigue trayendo todas). Para chequear.
- **Pista**: el BE `PrismaSchedulingRepository.listTasks` SÍ arma `where['priority']` (existe), así que probablemente el bug es **FE** (el control no manda `priority`, o manda un valor que no matchea — p. ej. el catálogo de prioridades usa nombres/ids distintos a `low/normal/high/urgent`). Auditar el `<select>` de prioridad del `TaskFilterBar` vs los valores reales de las tareas.
- **Dónde**: FE `TaskFilterBar` (control de prioridad) + verificar el valor que se compara. Posible relación con #25 (auditoría de filtros).
- **Tamaño**: chico.

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
