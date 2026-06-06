# Backlog — IPNext (Prominense)

> Backlog de trabajo sobre los dos repos (`ipnext-backend` + `ipnext-frontend`).
> Arrancó el 2026-06-03 con 14 ítems; +2 (#15, #16) → 16; +1 (#17); +2 (#18, #19); +1 (#20); +2 el 2026-06-06 (#21, #22) → **22 totales**.
> **14 hechos (en prod) · 8 pendientes.** (#17 y #7 cerrados vía SDD.)
> Reglas de trabajo en [`WORKFLOW-MULTI-REPO.md`](./WORKFLOW-MULTI-REPO.md). Estado vivo también en engram (`sdd/*`).

---

## ✅ Hechos (14, desplegados en producción)

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

## ⏳ Pendientes (8)

### #11 — Rediseño de tickets + ID autoincremental + filtros ocultos
- **Qué**: (a) rediseño visual de tickets; (b) agregar un **ID autoincremental** como se hizo con tareas (`sequenceNumber`); (c) los filtros deben estar **ocultos** y mostrarse solo al clickear el botón de filtro.
- **Dónde**: FE página de tickets + BE (columna `sequenceNumber` en `Ticket`, migración + backfill). Ya existe un worktree `tickets-redesign-fe`.
- **Tamaño**: mediano (tickets).

### #12 — Filtros usables en "Todos los proyectos"
- **Qué**: NO es bug. Hoy el filtro de Estados (`StageMultiSelect`) requiere un proyecto seleccionado, porque los stages vienen del workflow del proyecto. Se quiere poder filtrar estando en "Todos los proyectos".
- **Camino propuesto**: cuando no hay proyecto, el filtro de estados pasa a filtrar por **categoría de estado** (`stageCategory`: nuevo/enProgreso/hecho/cancelado) — transversal a todos los workflows, ya existe como filtro client-side.
- **Dónde**: FE `TaskFilterBar.tsx` + `SchedulingTasksPage`.
- **Tamaño**: chico-mediano.

### #14 — Campos `auditoria_ia` + `iclass_data` en la tarea + flag de auto-completado
- **Qué**: agregar al modelo de tareas dos campos (tipo `auditoria_ia` + `iclass_data`) para que, si a una tarea le falta la auditoría o la ingesta, se pueda **auto-completar**. Con una feature flag en integraciones. Es casi igual pero distinto a "Reconciliar tareas pendientes".
- **Dónde**: BE `ScheduledTask` (columnas/estado) + un job/use-case de auto-completado + `FeatureFlag` + UI de integraciones.
- **Tamaño**: mediano-grande (integraciones/flags).

### #18 — Bug: confirmar inventario sin data (no validar el ítem antes de confirmar)  *(agregado 2026-06-04)*
- **Síntoma**: en la confirmación de inventario de una OS (ejemplo visto en la **4175**), un ítem queda **confirmado pero sin data** — se puede confirmar aunque no tenga los datos mínimos (un DEVICE sin SN ni MAC, o un ítem sin descripción). No se debería poder confirmar un ítem vacío.
- **Camino propuesto**: validar datos mínimos por `kind` antes de confirmar — DEVICE → al menos SN o MAC; MATERIAL → descripción + cantidad. Rechazar con error de validación si falta.
- **Dónde**: BE `ConfirmInventorySuggestion` (guard de datos mínimos por kind) — fail-closed en el backend, no solo en el front; FE `SuggestionCard` / `TaskInventorySuggestions` (deshabilitar "Confirmar" o mostrar la validación). Permiso ya existente (`inventory.write`).
- **Tamaño**: chico.

### #19 — Agregar ítem de inventario MANUAL a la tarea (antena/onu/router/etc.)  *(agregado 2026-06-04)*
- **Qué**: hoy las sugerencias de inventario salen **solo** del cierre (OCR de fotos device + materiales de IClass). Se quiere poder **agregar manualmente** un ítem de inventario en la tarea — elegir el tipo del catálogo (antena/onu/router/otros) y cargar su SN/MAC/datos — sin depender de que el OCR lo haya detectado.
- **Camino propuesto**: nuevo use-case + endpoint para crear una sugerencia/ítem manual en la tarea (`source = MANUAL`, kind DEVICE/MATERIAL); FE botón "Agregar ítem" en el panel de inventario de la tarea con form (tipo del `DeviceTypeCatalog` + SN/MAC/desc). Reusa la validación del #18.
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

### #22 — Bug: sugerencia de inventario con FOTO pero SIN SN cuando el OCR falla  *(agregado 2026-06-06)*
- **Síntoma**: varias tareas con sugerencia de inventario que tienen la **foto pero no la SN** (DEVICE con `serialNumber=null`). Coincide con la LLM (Ollama OCR) **caída**, así que no se sabe si no se analizó o si se creó la sugerencia igual sin OCR.
- **Comportamiento deseado**: si el OCR **no** extrae la SN (o la LLM está caída), **NO crear la sugerencia DEVICE incompleta** ni marcar `inventoryBuilt=true` — dejarla **pendiente** para que el reprocess la re-OCR-ee después. "Si no está el OCR ok, no se pasa la imagen, para reprocesarla."
- **Causa probable**: en `runClosureSideEffects`, el OCR loop agrega la extracción aunque no traiga SN (o `BuildInventorySuggestions` crea el DEVICE igual), y `inventoryBuilt` se marca `true` → el reprocess no la reintenta.
- **Dónde**: BE `IngestClosedServiceOrders.runClosureSideEffects` (OCR loop) + `BuildInventorySuggestions` + `ExtractDeviceInfoFromPhoto`. Se apoya en el tracking del reprocess (B+C).
- **Tamaño**: chico-mediano. **Relación**: #18 (validación), reprocess (re-OCR).

---

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
