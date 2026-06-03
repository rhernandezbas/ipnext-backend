# Backlog — IPNext (Prominense)

> Backlog de trabajo sobre los dos repos (`ipnext-backend` + `ipnext-frontend`).
> Arrancó el 2026-06-03 con 14 ítems; +2 agregados el mismo día (#15, #16) → **16 totales**.
> **11 hechos (en prod) · 5 pendientes.**
> Reglas de trabajo en [`WORKFLOW-MULTI-REPO.md`](./WORKFLOW-MULTI-REPO.md). Estado vivo también en engram (`sdd/*`).

---

## ✅ Hechos (11, desplegados en producción)

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

---

## ⏳ Pendientes (5)

### #7 — Unificar sub-page "cierre de OS" + feature flag del auditor IA
- **Qué**: en Scheduling → Configuraciones → integración IClass, unificar la sub-page de "cierre de OS" (manteniendo el diseño) y crear la **feature flag del auditor de IA**.
- **Dónde**: FE config de scheduling (settings) + BE feature flags (`FeatureFlag`). El auditor IA ya existe (F6 de closure-inventory-intelligence) bajo `ICLASS_AUDIT_ENABLED` env — esto lo expondría como flag toggleable en UI.
- **Tamaño**: mediano (integraciones/flags).

### #9 — Crear tarea desde ticket: redirigir + relacionar
- **Qué**: al crear un ticket y, dentro del ticket, crear una tarea: hoy la tarea se crea pero (a) NO redirige a la tarea en ese contexto, y (b) en la tarea, en "Relacionado", NO aparece el ticket desde el que se creó.
- **Estado parcial**: el modelo ya soporta `ticketId` en la tarea y el tab "Relacionado" ya renderiza el ticket vinculado cuando `ticketId` está presente (visto en `TaskTabs.tsx`). Falta: setear el `ticketId` al crear desde el ticket + redirigir.
- **Dónde**: FE (flujo crear-tarea-desde-ticket + navegación) + BE (que el create acepte/persista `ticketId` desde ese contexto).
- **Tamaño**: mediano (tickets).

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

---

## Refinamientos del #8 (ya en prod, NO son ítems numerados)

Dos follow-ups del inventario shippeados el 2026-06-03 (archivados en `openspec/changes/archive/`):
- **inventory-edit-and-match**: editar el tipo de un equipo confirmado (admin) sincronizando sugerencia + contrato + sidebar (fix tarea 4691); match de sugerencias contra el inventario actual (badge SN/MAC → "ya instalado" / tipo → "posible reemplazo").
- **inventory-confirm-dedup-replace**: el match pasa de aviso a acción — frena el duplicado del mismo equipo; ofrece "Agregar" o "Reemplazar la actual" (la vieja → `status='replaced'` + `replacesItemId`).

## Notas de priorización (lectura del equipo)

- **Epic Tickets** (#9 + #11) y **Epic Integraciones/flags** (#7 + #14): conviene agruparlos por epic.
