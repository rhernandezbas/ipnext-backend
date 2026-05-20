# Splynx Scheduling — Replica Plan

Fecha exploración: 2026-05-20
Fuente: https://splynx.ipnext.com.ar/admin/scheduling/
Usuario: LuisS

## Estructura del módulo

Submenú `Scheduling` con 6 secciones:

| Sección | URL | Propósito |
|---------|-----|-----------|
| Dashboard | `/admin/scheduling/dashboard` | Stats globales del módulo |
| Proyectos | `/admin/scheduling/projects` | CRUD de proyectos (agrupadores de tareas) |
| Tareas | `/admin/scheduling/tasks` | CRUD de tareas — vista tabla + Kanban |
| Calendar | `/admin/scheduling/calendars` | Vista calendario de tareas |
| Mapas | `/admin/scheduling/maps` | Tareas geolocalizadas en mapa |
| Archivar | `/admin/scheduling/archive` | Tareas/proyectos archivados |

## Modelos de dominio derivados

### Project
- `id` (auto)
- `title` (string)
- `description` (text)
- `type` (enum: Instalacion, …) — configurable
- `category` (FK → ProjectCategory)
- `workflow` (FK → Workflow)
- `partners` (M:N → Partner)
- `projectLead` (FK → User/Admin)
- `visible` (Activo/Inactivo)
- Contadores derivados: tareas en Nuevo / En progreso / Hecho (agrupados por stage del workflow)

Proyectos detectados en producción: RED-Wireless, CAMBIO DE DOMICILIO, VISITA TECNICA WIRELESS, VISITA TECNICA-FIBRA, VISITA TECNICA-CAMARAS, RETIROS DE EQUIPOS, MIGRACIONES, INSTALACION WIRELESS, INSTALACION FIBRA, Relevamiento, Red-Fibra, Eventos/municipalidad, Corporativos, Noc.

### Task
- `id` (auto, ej: 2886)
- `title` (string)
- `description` (rich-text HTML — editor con Bold/Italic/Underline/Lists/Link/Colors/Table/Image/Code)
- `project` (FK → Project)
- `assignee` (FK → User, nullable — "Not assigned")
- `priority` (enum: Baja / Media / Alta)
- `stage` (FK → Stage del Workflow del proyecto)
- `partner` (FK → Partner; default "Main = Customer's partner")
- `customer` (FK → Customer/Lead, nullable)
- `service` (FK → CustomerService, nullable)
- `location` (Address — calle+ciudad+CP; "Customer location" por default)
- `coordinates` (lat/lng — para mapa)
- `startDate`, `endDate` (datetime)
- `travelTimeTo`, `travelTimeFrom` (duración 0h 0m)
- `reporter` (FK → User, el que creó la task)
- `watchers` (M:N → User)
- `checklist` (1:N TaskChecklistItem, opcionalmente cargados desde una ChecklistTemplate)
- `createdAt` (ej: 20/02/2026 12:01:32)
- `age` (derivado — "16 días")

### Workflow / Stage
Stages agrupados en 3 categorías visuales (las columnas del listado de Projects y del Kanban):
- **Nuevo** (stages 4, 7, 18, 19, 22, 23, 28, 29, 34, 51, 52, 61, 62, 72, 73 — varía por workflow). Sub-estados detectados: Nuevo, Confirmado, Pospuesta, No Factible, Enviar a IClass, Registrado en IClass, Notificado.
- **En progreso** (stages 5, 8). Sub-estado: En progreso.
- **Hecho** (stages 6, 9, 20, 21, 64, 65). Sub-estados: Instalado, Hecho, Anulado-Cancelado.

Cada Project apunta a un Workflow. Los stages que un Project muestra dependen del Workflow asignado (ej: workflows distintos para "Visita Técnica" vs "Retiros de Equipos").

### ChecklistTemplate / TaskChecklistItem
- Plantillas reutilizables ("Cargar la lista de verificación" en task detail)
- Items detectados: "Preparar materiales/herramientas", "Solucionar el problema", "Prueba de condición"
- Operaciones: cargar template, limpiar, añadir elemento

### Soporte
- **ProjectCategory**: "Default category"
- **ProjectType**: "Instalacion", …

## Vistas relevantes

- **Listado Projects**: tabla con columnas ID/Título/Nuevo/En progreso/Hecho/Acciones. Filtros: Visible, Socios. Paginación. Search.
- **Listado Tasks**: dos modos —
  - **Tabla**: columnas Checkbox/ID/Estado/Proyecto/Dirección/Cliente/Fecha/Asignado/(prioridad)/Edad/Acciones. Filtros: Proyecto/Estado multi-select/Socios. Bulk actions.
  - **Kanban (Flujo de Trabajo)**: columnas por stage del workflow del proyecto seleccionado.
- **Task detail**: tabs/secciones — Descripción, Datos (Proyecto/Asignado/Prioridad/Estado/Socio/Ubicación/Dirección/Coordenadas/Start/End/Travel), Checklist, Customer/Lead vinculado, Servicio, Chats, Watchers, Reporter.
- **Calendar**: vista mes/semana/día (a inspeccionar más en SDD design).
- **Maps**: tareas como markers en mapa (Leaflet — ya está en frontend).

## Artefactos capturados

Snapshots y screenshots completos en:
- `md/splynx-scheduling/snapshots/*.yml` (estructura accesible)
- `md/splynx-scheduling/screenshots/*.png` (diseño visual)

---

## Estado actual del código (lo que YA EXISTE)

### Backend
- `prisma/schema.prisma` — modelos `Project` (mínimo), `ScheduledTask`, `TaskTemplate`
- `src/domain/entities/{scheduling,project,taskTemplate}.ts`
- `src/domain/ports/{SchedulingRepository,ProjectRepository,TaskTemplateRepository}.ts`
- Use cases CRUD para tasks (`ListTasks`, `GetTask`, `CreateTask`, `UpdateTask`, `DeleteTask`, `UpdateTaskStatus`)
- Rutas: `scheduling.routes.ts` (con auth), `projects.routes.ts` (⚠️ SIN auth), `taskTemplate.routes.ts`
- DTOs en `src/application/dto/scheduling.dto.ts` (zod-like via safeParse)

### Frontend
- `src/pages/scheduling/{SchedulingProjectsPage,SchedulingTemplatesPage,SchedulingArchivePage,SchedulingMapsPage,SchedulingDashboardPage,SchedulingCalendarPage}.tsx`
- Hooks `useProjects`, `useTasks`, `useTaskTemplates`
- Tests para las 5 páginas en `src/__tests__/scheduling/`

## GAP REAL vs Splynx

| Área | Estado | Falta |
|------|--------|-------|
| Workflow + Stage | ❌ no existe; `status` es String libre | Tabla `Workflow`, `Stage` con categoría (Nuevo/En progreso/Hecho); migrar `status: String → stageId: FK` |
| Sub-estados | 4 enums hardcoded | 11 sub-estados configurables agrupados en 3 categorías |
| Project fields | title, description | type, categoryId, workflowId, partners (M:N → Partner existe), projectLeadId, visible |
| Task fields | clientId String suelto | customerId (FK real), serviceId, partnerId, reporterId, watchers (M:N), travelTimeTo/From |
| `scheduledDate/Time` | 🐛 STRING — bug latente | `startDate`/`endDate` DateTime |
| Descripción Task | textarea plano | Rich-text HTML |
| TaskTemplate items | solo name/category | `TaskTemplateItem` + `TaskChecklistItem` (con done, fromTemplateItemId) |
| Task detail page | ❌ no existe | Página completa con mapa, checklist, customer binding, watchers |
| Kanban view | ❌ no existe | Drag&drop entre stages |
| `projects.routes.ts` | 🐛 sin auth | Agregar `createAuthMiddleware` |
| `Prisma*.ts` naming | 🐛 24/26 exportan `InMemory*` | NO replicar el bug en adapters nuevos |

## Plan de Changes SDD FINAL (basado en delta real, 6 changes)

### 1. `scheduling-foundation-stage-model` 🔒 bloqueador
Nuevos modelos: `Workflow`, `Stage` (con `category: 'nuevo'|'enProgreso'|'hecho'` y orden), `ProjectCategory`, `ProjectType`.
- Migración Prisma + seeds con los stages de Splynx que documentamos.
- **Data migration**: `ScheduledTask.status: String → stageId: FK Stage` mapeando los valores actuales (`pending → "Nuevo"`, `in_progress → "En progreso"`, `completed → "Hecho"`, `cancelled → "Anulado-Cancelado"`).
- Endpoint admin `/admin/scheduling/workflows` (CRUD + reordenar stages).
- Frontend: página `/admin/scheduling/config/workflows` con UI de gestión (skill `impeccable` aplicada).

### 2. `scheduling-projects-enrich`
Extender `Project` con `type`, `categoryId`, `workflowId`, `projectLeadId`, `visible`, tabla pivot `ProjectPartner`.
- Update `SchedulingProjectsPage`: modal Crear/Editar con todos los campos, filtros Visible/Socios.
- Contadores derivados de los Stages reales (no hardcodeados como hoy).
- Skill `impeccable` aplicada al rediseño.

### 3. `scheduling-tasks-enrich`
- **Fix bug**: `scheduledDate`/`scheduledTime` String → `startDate`/`endDate` DateTime con migración cuidada.
- Agregar `customerId` (FK Client real), `serviceId` (FK Service), `partnerId` (FK Partner), `reporterId` (FK Admin), `watchers` (M:N pivot), `travelTimeTo/From` (Int minutos), descripción rich-text (HTML).
- Update `SchedulingDashboardPage` y listados.

### 4. `scheduling-task-detail-page`
Nueva página `/scheduling/tasks/:id`:
- Header con título/stage/prioridad.
- Descripción rich-text (editor).
- Sección Datos (proyecto, asignado, prioridad, stage, partner, customer, service, fechas, travel times).
- Sección Ubicación con dirección + mapa Leaflet (lat/lng).
- Sección Checklist editable.
- Sección Customer/Lead y Servicio vinculados.
- Sección Watchers / Reporter.
- Skill `impeccable` aplicada (página densa, máximo cuidado visual).

### 5. `scheduling-checklists`
- Schema: `TaskTemplateItem(id, templateId, text, order)`, `TaskChecklistItem(id, taskId, text, done, order, fromTemplateItemId?)`.
- Use cases: `AssignTemplateToTask` (clona items), `ToggleChecklistItem`, `AddChecklistItem`, `RemoveChecklistItem`.
- Update `SchedulingTemplatesPage` con editor de items reordenable.

### 6. `scheduling-tasks-views` + security fixes
- Vista Kanban (drag&drop entre stages, actualiza `stageId` vía PATCH).
- Filtros multi-select por estado en listado tabla.
- **Fix**: agregar `createAuthMiddleware` a `projects.routes.ts`.
- Skill `impeccable` aplicada al Kanban.

## Notas de ejecución

- Modo SDD: **Automatic** (back-to-back).
- Artifact store: **Hybrid** (openspec + engram).
- TDD estricto: red → green → refactor (`npm test` quality gate).
- `tsc --noEmit` como typecheck — no ESLint/Prettier.
- Postgres como source of truth — sin nuevas dependencias a Splynx (que será deprecado).
- Adapters nuevos: respetar nombre (`Prisma*Repository` debe exportar clase `Prisma*Repository`, NO `InMemory*Repository` como tiene la deuda actual).
- Commits conventional separados back/front (`feat(scheduling-*): …`), push a `main` → GH Actions Docker self-hosted (back :8291 / front :7778).
