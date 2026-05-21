# Splynx Scheduling Replica — Release Notes

**Fecha**: 2026-05-21 (último update)
**Repos**: `ipnext-backend` + `ipnext-frontend`
**Branch**: `main` (deployado en producción)
**Backend HEAD**: `e5a735cb`
**Frontend HEAD**: `52ab23c`

---

## Resumen ejecutivo

Reemplazo del módulo Scheduling de Splynx por una implementación nativa sobre Postgres + Node/Express + React. Trabajo realizado en **7 changes SDD** (6 del plan inicial + 1 follow-up de Calendar) más un hot-fix de consistencia visual.

Lo que entra a producción en este ciclo:

- **Configurabilidad**: workflows + stages + categorías + tipos de proyecto (lo que en Splynx era hardcodeado).
- **Enriquecimiento de modelo**: Project gana FKs a workflow/categoría/tipo/lead + relación M:N con partners; ScheduledTask gana startDate/endDate (DateTime real, no String), 5 FKs (customer/service/partner/reporter/assignee), watchers M:N, travel times, descripción rich-text.
- **Página detalle de tarea**: ruta `/admin/scheduling/tasks/:id` con editor TipTap, mapa Leaflet, datos del proyecto/asignado/cliente, checklist editable.
- **Checklists**: items de plantilla + items de tarea + assign-template-to-task (clona items en una transacción).
- **Vista de tareas**: ruta `/admin/scheduling/tasks` con Tabla + Flujo de Trabajo (Kanban con drag&drop sobre stages), filtros multi-select sincronizados a URL.
- **Calendar**: ruta `/admin/scheduling/calendars` reescrita con resource-timeline (Día/Semana/Mes), reemplaza el placeholder anterior.
- **Seguridad**: auth middleware en `projects.routes.ts` (faltaba — bug histórico).

Postgres es source of truth. No se agregaron dependencias nuevas a Splynx; el adapter Splynx queda deprecado para extracción futura.

---

## Cambios por capability

### Capability: `scheduling` (modificada)

Spec previo: `openspec/specs/scheduling/spec.md` (post-change-1 + change-3 deltas).

**Schema (Prisma)**:
- `ScheduledTask.status: String` → derived field a partir de `stageId: FK Stage` (cambio 1)
- `ScheduledTask.scheduledDate: String? + scheduledTime: String?` → `startDate: DateTime? + endDate: DateTime?` (cambio 3, bug fix latente — los strings rompían sort/comparación)
- Nuevas columnas en `ScheduledTask`: `customerId` FK Client, `serviceId` FK Service, `partnerId` FK Partner, `reporterId` FK Admin, `assigneeId` FK Admin (con `@relation("TaskReporter")` y `@relation("TaskAssignee")` para desambiguar), `travelTimeTo Int?`, `travelTimeFrom Int?` en minutos
- Nueva tabla pivot `TaskWatcher (taskId, adminId)` con composite PK y CASCADE en ambos
- Columnas legacy retenidas como deprecated read-only por un release: `status`, `scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`
- `description` ahora se trata como HTML rich-text (no se sanitiza server-side; el frontend usa TipTap con su schema-driven sanitization)
- `createdAt` y `updatedAt` ahora se exponen en la respuesta JSON (faltaban — el hot-fix los agregó)

**API**:
- `PATCH /api/scheduling/:id/stage` (cambio 1, nuevo) — reemplaza `PATCH /:id/status` para mover tareas entre stages. El status endpoint queda como deprecation shim que mapea a stages del workflow Default.
- `GET /api/scheduling?projectId=&stageIds=&partnerId=&assigneeId=&q=&from=&to=` (cambios 6 y 7) — filtros opcionales. `stageIds` acepta múltiples valores (`?stageIds=a&stageIds=b`). `from`/`to` son ISO datetimes para filtrar por `startDate` range.
- Composition test extendido para verificar que las nuevas sub-rutas no son sombreadas por el `/:id` catch-all.

### Capability: `scheduling-workflows` (nueva, cambio 1)

Spec: `openspec/specs/scheduling-workflows/spec.md`.

Nuevos modelos Prisma: `Workflow`, `Stage` (con `category: StageCategory` enum `nuevo`/`enProgreso`/`hecho`), `ProjectCategory`, `ProjectType`.

**API**:
- `GET|POST /api/scheduling/workflows` y `GET|PUT|DELETE /api/scheduling/workflows/:id`
- `POST /api/scheduling/workflows/:id/stages` para agregar stages
- `PUT /api/scheduling/workflows/:id/stages/reorder` para reordenar
- `DELETE /api/scheduling/workflows/:id/stages/:stageId`
- `GET|POST /api/scheduling/project-categories` y `GET|PUT|DELETE /api/scheduling/project-categories/:id`
- `GET|POST /api/scheduling/project-types` y CRUD análogo

Migración con bootstrap idempotente: workflow "Default" + 11 stages que reflejan exactamente los sub-estados de Splynx (`Nuevo`, `Confirmado`, `Pospuesta`, `No Factible`, `Enviar a IClass`, `Registrado en IClass`, `Notificado`, `En progreso`, `Instalado`, `Hecho`, `Anulado-Cancelado`). Migración de data convirtió `ScheduledTask.status` String → `stageId` FK.

### Capability: `projects` (nueva, cambio 2)

Spec: `openspec/changes/scheduling-projects-enrich/specs/projects/spec.md` (eventualmente promovido a `openspec/specs/projects/spec.md` al archivar).

**Schema**:
- `Project` gana: `typeId` FK ProjectType, `categoryId` FK ProjectCategory, `workflowId` FK Workflow, `projectLeadId` FK Admin, `visible: Boolean default true`
- Nueva pivot table `ProjectPartner (projectId, partnerId)` con composite PK, CASCADE on project delete, RESTRICT on partner delete
- FK actions: `ON DELETE SET NULL` para todos los FKs opcionales del Project
- Backfill: proyectos existentes obtienen `workflowId = Default workflow id`

**API**:
- `POST/PUT /api/projects` ahora acepta `typeId`, `categoryId`, `workflowId`, `projectLeadId`, `visible`, `partnerIds: string[]` (replace-set semantics: el array reemplaza completamente las relaciones existentes, dentro de una transacción)
- `taskCounts` derivado ahora de `Stage.category` (no del legacy `status` string)
- **Security fix**: `projects.routes.ts` ahora requiere auth middleware en TODAS las rutas. Antes era completamente público — bug histórico. Movido oportunísticamente desde el change 6 al change 2 porque el archivo se reescribía igual.

Único `ReferenceNotFoundError` parametrizado por kind (`'category'|'type'|'workflow'|'lead'|'partner'`), no cinco clases distintas (AD-7).

### Capability: `scheduling-checklists` (nueva, cambio 5)

Spec: `openspec/changes/scheduling-checklists/specs/scheduling-checklists/spec.md`.

**Schema**:
- `TaskTemplateItem (id, templateId FK CASCADE, text, order Int)`
- `TaskChecklistItem (id, taskId FK CASCADE, text, done, order, fromTemplateItemId FK SET NULL)`
- Indexes `(templateId, order)` y `(taskId, order)`
- Back-relations: `TaskTemplate.items` y `ScheduledTask.checklist`

**API**:
- Template items vía replace-set: `PUT /api/task-templates/:id/items` body `{items: [{text, order}]}` (mirror de ProjectPartner/TaskWatcher pattern)
- Checklist vía per-item endpoints (toggle es hot path):
  - `POST /api/scheduling/:id/checklist` body `{text}` — agrega ad-hoc
  - `PATCH /api/scheduling/:id/checklist/:itemId/toggle`
  - `PATCH /api/scheduling/:id/checklist/:itemId` body `{text}` — actualizar texto
  - `DELETE /api/scheduling/:id/checklist/:itemId`
  - `PUT /api/scheduling/:id/checklist/order` body `{orderedIds: string[]}` — reorder
  - `POST /api/scheduling/:id/checklist/assign-template` body `{templateId}` — clona items del template REEMPLAZANDO el checklist actual en una transacción
  - `DELETE /api/scheduling/:id/checklist` — limpia el checklist completo

### Frontend: `scheduling-task-detail` (nueva capability, cambio 4)

Página: `src/pages/scheduling/SchedulingTaskDetailPage.tsx` en ruta `/admin/scheduling/tasks/:id`.

**Stack visual**:
- Sticky header con título editable in-place, stage selector con pills coloreadas por categoría (AA-contrast: nuevo gris-azul, enProgreso ámbar, hecho verde), priority selector, kebab de acciones
- Main column: form Datos (react-hook-form con dirty tracking), mapa Leaflet con sincronización bidireccional address ↔ marker vía Nominatim debounce 600ms, editor TipTap (HTML rich-text), checklist editable (cambio 5)
- Sidebar: Customer/Service/Reporter cards + Watchers chips
- Hybrid save strategy: optimistic UI con snapshot/rollback para title/stage/priority/watchers (mutations atómicas); Save explícito para Datos form + Descripción (drafting context)
- Confirm-on-leave con `useEffect` cleanup correcto

**Decisiones de librerías**:
- TipTap 2 + StarterKit para rich-text (~75 KB lazy-loaded)
- react-hook-form para Datos form
- TanStack Query para todo server state
- dnd-kit (cambio 5) para drag&drop accesible (PointerSensor + KeyboardSensor)

### Frontend: `scheduling-tasks-views` (cambio 6)

Página: `src/pages/scheduling/SchedulingTasksPage.tsx` en ruta `/admin/scheduling/tasks`.

- Toggle Tabla / Flujo de Trabajo (Kanban) sobre el mismo modelo de tareas
- Filtros sincronizados a URL: `?view=table|kanban&projectId=&stageIds=&q=`
- Tabla: DataTable sortable, paginated, selectable. BulkActionBar con "Mover etapa" modal + Delete
- Kanban: columnas derivadas de los stages del workflow del proyecto seleccionado (soft prompt cuando no hay project filter — sin proyecto no hay workflow del cual derivar columnas). Drag&drop entre stages calls `PATCH /:id/stage` con optimistic UI

### Frontend: `scheduling-calendar` (cambio 7, follow-up)

Página reescrita: `src/pages/scheduling/SchedulingCalendarPage/` en ruta `/admin/scheduling/calendars`.

- Día / Semana / Mes views con URL sync (`?view=day|week|month&date=YYYY-MM-DD`)
- Día view: resource-timeline custom con CSS Grid — técnicos como filas agrupadas por `Admin.role`, horas como columnas
- Mes view: grid LUN-DOM con event pills (max 3 por celda + "+N más")
- Toolbar: dropdown Proyecto + nav `‹ rango ›` + Hoy + view selector
- Filtros backend `from`/`to` para fetchear solo la ventana visible
- **Sin librería paga**: Custom CSS Grid (vs FullCalendar Resource Timeline a USD 480/año). Tradeoff documentado en `design.md AD-1`.

---

## Schema changes resumen (Prisma)

| Modelo | Cambio | Change |
|---|---|---|
| `Workflow` | nuevo (id, name CI-unique, description) | 1 |
| `Stage` | nuevo (id, workflowId FK, name, category enum, order) | 1 |
| `StageCategory` | enum `nuevo|enProgreso|hecho` | 1 |
| `ProjectCategory` | nuevo | 1 |
| `ProjectType` | nuevo | 1 |
| `ScheduledTask.stageId` | nueva columna FK NOT NULL, backfilled desde status | 1 |
| `ScheduledTask.status` | retenida como deprecated read-only por 1 release | 1 |
| `Project` | +typeId, +categoryId, +workflowId, +projectLeadId, +visible | 2 |
| `ProjectPartner` | nueva pivot M:N | 2 |
| `ScheduledTask.{scheduledDate,scheduledTime}` | retenidas legacy; agregadas `startDate/endDate: DateTime?` | 3 |
| `ScheduledTask` | +customerId, +serviceId, +partnerId, +reporterId, +assigneeId | 3 |
| `ScheduledTask` | +travelTimeTo, +travelTimeFrom (minutos) | 3 |
| `TaskWatcher` | nueva pivot M:N | 3 |
| `Admin` | back-relations `tasksReported` y `tasksAssigned` con `@relation` named | 3 |
| `TaskTemplateItem` | nueva tabla | 5 |
| `TaskChecklistItem` | nueva tabla con FK opcional a TaskTemplateItem | 5 |

Migraciones aplicadas en producción (orden):

1. `20260520000000_scheduling_foundation_stage_model` (workflows, stages, backfill status→stageId)
2. `20260520010000_scheduling_projects_enrich` (project enrichment + pivot)
3. `20260520020000_scheduling_tasks_enrich` (datetime + 5 FKs + watchers)
4. `20260520050000_scheduling_checklists` (items + checklist tables)

Todas las migraciones se aplican vía `npx prisma migrate deploy` en el step "Run DB migrations" del workflow GH Actions. Todas usan `DO $$ ... WHERE NOT EXISTS $$` para bootstrap idempotente, NUNCA `ON CONFLICT ON CONSTRAINT <index_name>` (ver "Lecciones de deploy" abajo).

---

## Breaking changes

**Ninguno en runtime**. Las columnas legacy quedan retenidas como deprecated read-only por un release:

- `ScheduledTask.status` — el backend YA NO escribe ahí, pero la columna sigue. Los clientes que la leen siguen funcionando (el mapper la deriva de `Stage.category`).
- `ScheduledTask.scheduledDate` y `scheduledTime` — idem; los clientes deben migrar a `startDate`/`endDate` antes del próximo release.
- `ScheduledTask.clientId`, `clientName`, `assignedTo`, `assignedToId` — idem; migrar a `customerId` + JOIN, `assigneeId` + JOIN.

`PATCH /api/scheduling/:id/status` queda como deprecation shim que loguea warning y forwardea a `moveTaskToStage` mapeando legacy status → Default workflow stage.

`POST/PUT /api/projects` ahora REQUIERE auth (era público antes — bug de seguridad fixeado).

---

## Lecciones de deploy aprendidas (4 bugs de CI cazados)

Documentadas para no repetir y para que los próximos sub-agents las apliquen:

1. **Migration SQL — `ON CONFLICT ON CONSTRAINT <name>`** (cazado en change 1, prod):
   Postgres distingue entre UNIQUE INDEX (creado con `CREATE UNIQUE INDEX`) y UNIQUE CONSTRAINT (creado con `ALTER TABLE ... ADD CONSTRAINT`). `ON CONFLICT ON CONSTRAINT <name>` requiere lo segundo; falla con error 42704 si el nombre apunta a un índice.
   **Fix definitivo**: usar `DO $$ ... WHERE NOT EXISTS $$` con PL/pgSQL para bootstrap idempotente. NUNCA `ON CONFLICT ON CONSTRAINT`.

2. **Workflow YAML — `docker stop/rm || true`** (cazado en change 1 backend, change 6 frontend):
   El `|| true` enmascaraba fallos del `docker stop` y `docker rm` cuando el container estaba en estado raro. El step `Verify` solo greppeaba `docker ps | grep <name>` que pasa aunque el container viejo siga corriendo. Resultado: GH Actions verde mientras producción seguía con código viejo.
   **Fix definitivo** (`.github/workflows/deploy.yml` de ambos repos):
   - `docker rm -f` (atómico stop+remove)
   - SHA assertion en Verify: `docker inspect <container> --format '{{.Image}}'` vs `docker inspect <image>:latest --format '{{.Id}}'`, exit 1 si difieren

3. **Docker build cacheaba TODO** (cazado en change 6 frontend):
   El runner self-hosted cacheaba la layer `COPY . .` agresivamente, dejando la imagen `:latest` apuntando a versiones viejas pese a cambios de source.
   **Fix**: `docker build --no-cache --pull -t <image>:latest .` en el workflow. Cuesta ~30s por build, garantiza que la imagen matchea HEAD.

4. **Vite production builds — directory-only lazy import** (cazado en change 6 frontend):
   `import('@/pages/scheduling/SchedulingTasksPage')` apuntando a un directorio (sin sibling `.tsx`) PRODUCE BUILD SIN ERROR pero el chunk resultante es vacío. La ruta queda sin renderizar (React Router 404).
   **Fix**: sibling re-export shim. Si la página vive en un directorio, crear `SchedulingTasksPage.tsx` hermano que `export { default } from './SchedulingTasksPage/index';`. Mirror del patrón de `SchedulingTaskDetailPage`.

5. **Smoke E2E con URL directa esconde bugs de navegación** (cazado por user post-release):
   Todos los smokes de los 7 changes navegaron a `/admin/scheduling/tasks` con URL directa via Playwright. Pasaron OK. Pero el sidebar tenía el link `Tareas` apuntando a la URL vieja (`/admin/scheduling`) que ruteaba a la legacy page. El usuario real entraba a `Scheduling → Tareas` desde el menú y caía en la pantalla vieja. Nunca lo detectamos porque mi flujo de Playwright skip-eaba el sidebar.
   **Fix definitivo**: SIEMPRE el smoke E2E debe empezar desde `/login`, hacer auth, y navegar la página objetivo via clicks reales en el sidebar/breadcrumbs/menús. NUNCA `page.goto(URL completa)` para el path de verificación. URL directa puede usarse como pre-condición de fixtures, no como navegación de validación.

---

## Bug fixes incluidos en este release

- **`scheduledDate/scheduledTime` como String**: bug latente desde antes de este ciclo. Rompía sort y comparaciones. Migrado a `DateTime?` con backfill cuidadoso en change 3 (`DO $$ ... EXCEPTION WHEN OTHERS THEN RAISE NOTICE` por fila, tolerante a strings malformados).
- **`projects.routes.ts` sin auth**: bug de seguridad. Era completamente público. Fixed en change 2 oportunísticamente.
- **`ScheduledTask.createdAt/updatedAt` ausentes del response**: el mapper Prisma no los exponía. La columna `Edad` del Tasks page mostraba `NaN días`. Fixed en hot-fix post change 6.
- **Tasks page no seguía el design system**: el sub-agent que aplicó el change 6 priorizó "diseño bueno nuevo" sobre "consistencia con el resto del sistema". Fixed con un hot-fix mirroreando los CSS tokens de `SchedulingProjectsPage`.
- **Calendar page era un placeholder**: la página original tenía solo un grid de números de día. Reescrita en change 7 con resource-timeline funcional.
- **MoveTaskStage swallowing STAGE_NOT_FOUND** (cazado en verify del change 1): el catch-all del adapter Prisma escondía errores de stage missing y devolvía `TASK_NOT_FOUND` engañoso. Fixed con check explícito antes del update.
- **InMemoryProjectRepository.update no sincronizaba `partners` array** (cazado en verify del change 2): faithless test double. Fixed.
- **Bare `catch {}` en PrismaProjectRepository.update/delete** (cazado en verify del change 2): swallowed cualquier error. Fixed para solo capturar Prisma P2025.
- **Sidebar `Tareas` linkeaba a la página vieja** (post-release, cazado por user): `Sidebar.tsx:102` apuntaba a `/admin/scheduling` que ruteaba a la legacy `empresa/SchedulingPage` (toggle Lista/Kanban/Calendario rojo, KPI cards, columnas Técnico/Categoría/Estado). La página nueva del change 6 vivía en `/admin/scheduling/tasks` pero el sidebar nunca la apuntaba. Fixed con commit `52ab23c`: link del sidebar actualizado + redirect de `/admin/scheduling` → `/admin/scheduling/tasks` para bookmarks viejos + lazy import del legacy page comentado.

---

## Deprecation notices

Estos elementos están marcados como deprecated y se removerán en un próximo "cleanup change". Los consumidores tienen UN release de gracia para migrar:

- Columnas `ScheduledTask.status`, `scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`
- Endpoint `PATCH /api/scheduling/:id/status` (usar `PATCH /:id/stage`)
- Tipos TypeScript `TaskStatus = 'pending'|'in_progress'|'completed'|'cancelled'` (usar `StageCategory`)

---

## Follow-ups / limitaciones conocidas

1. **`createTask` modal** en `SchedulingCalendarPage` es un stub. La página detalle (`SchedulingTaskDetailPage`) sí permite editar, pero la creación inline desde el calendar abre un placeholder. Extraer el formulario reutilizable del `SchedulingTasksPage` para usarlo en ambos.
2. **`Admin.team` / `Admin.category`**: el calendar agrupa técnicos por `Admin.role` como proxy. Para matchear la agrupación de Splynx (Red, LOGISTICA, INSTALACION, VISITA TECNICA, etc.) hace falta una nueva columna. Diferido.
3. **Drag-and-drop en Calendar**: el resource-timeline NO permite arrastrar eventos entre técnicos o resize todavía. Render-only.
4. **Bulk Actions en Tasks Kanban**: solo en vista Tabla. Kanban es one-at-a-time drag.
5. **Filter de Partner y Assignee en `TasksPage`**: solo `Project` y `Etapas` tienen UI dedicada; partner/assignee se filtran vía free-text `q`. Diferido a próxima iteración.
6. **Mobile (≤480px)**: degrada gracefully pero no está optimizado.
7. **Sanitización HTML del campo `description`**: el backend NO sanitiza (boundary explícita per AD-6). El frontend renderiza via TipTap `EditorContent` cuyo schema-driven model previene XSS. Si en el futuro otra UI renderiza `description` con `dangerouslySetInnerHTML`, agregar DOMPurify.

---

## Commits

### Backend (`ipnext-backend`)

```
c423b793  feat(scheduling): add from/to date range filter to GET /api/scheduling   [change 7]
5a387cc3  fix(scheduling): expose ScheduledTask createdAt/updatedAt in API         [hot-fix]
51247345  feat(scheduling): add filter query params to GET /api/scheduling         [change 6]
c8c93463  feat(scheduling): add checklists — template items + task checklist       [change 5]
ebbc7b2d  docs(scheduling): SDD docs for task detail page                          [change 4]
80bc31e9  feat(scheduling): enrich ScheduledTask with datetime + 5 FKs + watchers  [change 3]
8e545a11  feat(projects): enrich Project with workflow/category/type/lead/partners [change 2]
7f2bfeee  fix(scheduling): migration SQL idempotent bootstrap + harden deploy      [change 1 hotfix]
22ee0a09  fix(scheduling): mount workflows router before scheduling (/:id shadow)  [change 1 hotfix]
6bd4408c  docs(scheduling): add Splynx replica plan overview                       [planning]
ca7bd316  feat(scheduling): add Workflow + Stage foundation model                  [change 1]
31940b00  chore: ignore local tooling and playwright artifacts                     [housekeeping]
```

### Frontend (`ipnext-frontend`)

```
52ab23c   fix(scheduling): point sidebar 'Tareas' to /tasks + redirect legacy URL  [post-release fix]
6cfc250   feat(scheduling): rewrite Calendar page with resource-timeline           [change 7]
f19429d   fix(scheduling): align Tasks page UI with the system's design pattern    [hot-fix]
8ada911   fix(scheduling): add SchedulingTasksPage.tsx re-export shim              [change 6 hotfix]
4e0b9d0   fix(scheduling): explicit /index import for SchedulingTasksPage          [change 6 hotfix]
7d71646   fix(ci): force --no-cache on docker build to avoid stale layers          [change 6 hotfix]
5daa814   fix(ci): harden frontend deploy verify with image SHA assertion          [change 6 hotfix]
1a7a5da   feat(scheduling): add tasks page with Table + Kanban views               [change 6]
48c09ea   feat(scheduling): checklist editor on TaskDetailPage + TemplatesPage     [change 5]
32746ce   feat(scheduling): add task detail page at /admin/scheduling/tasks/:id    [change 4]
```

---

## Métricas

| Métrica | Valor |
|---|---|
| Changes SDD ejecutados | 7 (+2 hot-fixes sin SDD formal) |
| Migraciones Prisma | 4 |
| Tests backend (Jest) | 745 (delta +273 desde el inicio) |
| Tests frontend (Vitest) | 838 (delta +96 nuevos) |
| Líneas agregadas backend | ~15.000 |
| Líneas agregadas frontend | ~8.000 |
| Páginas frontend nuevas | 2 (TaskDetail + TasksPage) |
| Páginas frontend reescritas | 1 (Calendar) |
| Deploys exitosos a producción | 15 (8 backend + 7 frontend) |
| Bugs descubiertos post-release | 1 (sidebar Tareas linkeaba a legacy page) |
| Bugs de CI/CD descubiertos y fixeados | 4 |
| Lecciones de E2E aprendidas | 1 (no usar URL directa para validar nav) |
| Skill `impeccable` aplicada | en design.md de changes 4, 6, 7 |
| Smoke E2E con Playwright | sí, en cada change (con URL directa — gap descubierto) |

---

## Verificación final en producción

URLs verificadas con Playwright + curl autenticado (admin):

- `GET https://ipnext-backend / scheduling-workflows` devuelve workflow Default con 11 stages ordenados
- `GET /admin/scheduling/projects` muestra contadores derivados de stages reales
- `GET /admin/scheduling/tasks` muestra Tabla y Kanban con filtros URL-synced
- `GET /admin/scheduling/tasks/:id` renderiza descripción rich-text, mapa, checklist editable
- `PATCH /api/scheduling/:id/stage` mueve la tarea entre stages (optimistic UI)
- `POST /api/scheduling/:id/checklist/assign-template` clona items con `fromTemplateItemId` set
- `GET /admin/scheduling/calendars?view=month&date=2026-06-20` muestra event pills en días con tareas
- `GET /api/scheduling?from=2026-01-01&to=2026-12-31` filtra por ventana de tiempo

Backend container: `ipnext-new-backend` (puerto 8291).
Frontend container: `ipnext-new-frontend` (puerto 7778).

---

## Cómo desplegar al próximo entorno

1. Aplicar las 4 migraciones en orden: `npx prisma migrate deploy` desde una imagen del backend con las migraciones presentes.
2. Confirmar que `npx prisma generate` corrió contra el schema enriquecido (los `as any` casts en los adapters dejan de ser necesarios después de eso).
3. Verificar que `Default` workflow + sus 11 stages existen post-migración: `GET /api/scheduling/workflows`.
4. Para los proyectos legacy: revisar que `workflowId` quedó seteado al Default workflow id (backfill del change 2). Si quedó NULL (workflow Default ausente al momento de la migración), re-correr `npm run prisma:seed`.
5. Frontend: asegurar que el workflow YAML del frontend incluye `docker build --no-cache --pull` + el SHA assertion en Verify (fix del change 6). Si no, los deploys reportarán verde pero servirán código viejo.

---

## Referencias

- Plan original de changes: `md/splynx-scheduling/OVERVIEW.md`
- Screenshots de Splynx (reference) y de ipnext (final): `md/splynx-scheduling/screenshots/`
- Snapshots accesibilidad (Splynx + ipnext): `md/splynx-scheduling/snapshots/`
- SDD artifacts por change: `openspec/changes/<change-name>/`
- Specs consolidados: `openspec/specs/`
