# Design: Reporter on Create + Unified Save in Task Detail

## Technical Approach

Tres cambios independientes pero cohesivos en una sola unidad. Backend toca **una línea** en el route handler de creación; el resto es UX/UI del frontend que reduce fricción del usuario y aprovecha datos ya disponibles. Sin nuevas entidades, sin nuevos endpoints, sin migración de datos. El delta spec (REQ-CREATE-9/10/11) define el contrato observable.

## Architecture Decisions

### Decision 1: Default `reporterId` en el route handler, NO en `CreateTask`

| Opción | Tradeoff | Decisión |
|--------|----------|----------|
| Route handler (`scheduling.routes.ts`) lee `req.user.id` y lo pasa como default | HTTP context queda en infra; use case sigue puro | ✅ Elegido |
| `CreateTask` use case recibe un `getCurrentUserId` port y lo invoca | Mezcla concerns: use case necesita conocer auth context | ❌ Rechazado |

**Rationale**: La arquitectura hexagonal del repo prohíbe que `application/` conozca primitivas HTTP. `req.user` es de la capa de infra; la decisión "default desde auth si no viene" es policy del HTTP boundary. Inyectar un port `getCurrentUserId` resolvería formalmente pero sería ceremonia para una sola línea: el use case `CreateTask` ya recibe `reporterId` como dato y valida vía `adminLookup`. Setear el default upstream del use case mantiene `application/` ignorante del auth context.

### Decision 2: `DescriptionEditor` pasa a controlado (state lifted al page padre)

| Opción | Tradeoff | Decisión |
|--------|----------|----------|
| `DescriptionEditor` expone `onChange(html)`; el page padre tiene el state | Patrón estándar React; testable; el single submit incluye `description` natural | ✅ Elegido |
| Mantener `DescriptionEditor` con estado interno + agregar un `ref` para que `DatosForm` lea `editor.getHTML()` en submit | Acoplamiento imperativo brittle; difícil de testear; quiebra el modelo react-hook-form de `isDirty` unificado | ❌ Rechazado |
| Pasar la descripción al `DatosForm` como un `<textarea>` HTML plano | Pierde el editor tiptap (rich text, listas, etc.) que ya existe en prod | ❌ Rechazado |

**Rationale**: Lift state es el patrón React canónico cuando dos componentes necesitan coordinarse en un único save. El `dirty` agregado (descripción ∪ datos) se computa en el parent, que ya orquesta `onDirtyChange` para confirm-on-leave. El editor tiptap sigue siendo el surface de edición — solo cambia quién dueña el HTML.

### Decision 3: `reporterName` se resuelve client-side, NO se denormaliza en backend

| Opción | Tradeoff | Decisión |
|--------|----------|----------|
| Pasar `technicians` (ya disponible en el page padre vía `useTechnicians`) como prop a `TasksTableView`; resolver `reporterId → name` en el render de la columna | Una línea de prop, ningún tocar de BE (DTO/entity/repo/include) | ✅ Elegido |
| Agregar `reporterName` al `ScheduledTask` entity + DTO + incluir `reporter` en el `include` de Prisma + actualizar `toTask` | 4-5 archivos BE tocados + 1 migración mental (entity contract cambia); además ya tenemos el patrón equivalente para `assigneeName` pero no es razón para duplicarlo cuando el FE tiene los datos | ❌ Rechazado |

**Rationale**: El page de la lista YA fetchea admins (filtro "Asignado"). Pasarlos como prop a `TasksTableView` es el mismo patrón que `projects`/`workflows`/`priorities` ya pasados. Tocar el DTO sería over-engineering para resolver un join que ya está cubierto por datos disponibles. Si en el futuro la columna se necesita en un contexto sin admins (ej. report exportado en backend), se reevalúa.

## Data Flow

```
Backend (creación de tarea):
  POST /api/scheduling
       │
       ▼
  route handler ── data.reporterId ?? req.user?.id ?? null ──→ CreateTask
                                                                   │
                                                                   ▼
                                                            adminLookup.findById
                                                                   │
                                                                   ▼
                                                            repo.createTask

Frontend (save unificado en detalle):
  DescriptionEditor (controlled, onChange) ──┐
                                              ├──→ SchedulingTaskDetailPage state
  DatosForm (react-hook-form)            ────┘             │
                                                            ▼ Guardar cambios
                                                   updateTask({description, ...datos})

Frontend (columna Reporter en lista):
  SchedulingTasksPage (useTechnicians) ──→ TasksTableView ──→ columna `reporterName`
                                                                 │
                                                                 ▼
                                            admins.find(a => a.id === task.reporterId)?.name ?? '—'
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modify | Default reporterId al `req.user?.id` en POST `/` |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | Modify | `StubLookup` de admin incluye `admin-1`; tests nuevos cubren REQ-CREATE-9/10/11 |
| `ipnext-frontend/.../DescriptionEditor.tsx` | Modify | Pasa de `onSave`+botón a `onChange`+`onDirtyChange` |
| `ipnext-frontend/.../TaskDetailsTab.tsx` | Modify | Reciblea props del editor |
| `ipnext-frontend/.../SchedulingTaskDetailPage.tsx` | Modify | Lift de `descriptionHtml`; `handleFormSubmit` incluye descripción; saca `handleDescSave` |
| `ipnext-frontend/.../TasksTableView.tsx` | Modify | Nueva prop `admins?`; columna `reporterName` en `ALL_TASK_COLUMNS` |
| `ipnext-frontend/.../SchedulingTasksPage/index.tsx` | Modify | Pasa `technicians` a `TasksTableView`; `reporterName` en defaults visibles |
| FE tests afectados | Modify | DescriptionEditor.test, TaskHeader/Tabs, TasksTableView |

## Interfaces / Contracts

```ts
// FE: DescriptionEditor — nuevo API controlado
interface DescriptionEditorProps {
  initialHtml: string | null;
  onChange: (html: string, isDirty: boolean) => void;
}

// FE: TasksTableView — nueva prop
interface TasksTableViewProps {
  // ...existentes
  admins?: Admin[]; // para resolver reporterId → name
}
```

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| BE unit/integration | REQ-CREATE-9/10/11 | Jest + supertest sobre `scheduling.routes.ts` con `FakeAuthProvider` (admin-1) y `StubLookup` ampliado. RED → GREEN. |
| FE unit | Save unificado en detalle | Vitest sobre `SchedulingTaskDetailPage` + `DescriptionEditor` controlado. Un solo botón, una sola `updateTask` mock call. |
| FE unit | Columna Reporter | Vitest sobre `TasksTableView`: pasar `admins=[...]`, asertar render del nombre + fallback `—`. |
| E2E manual | Verificación post-deploy | Playwright contra prod: crear tarea, verificar Reporter en detalle + columna en lista. |

## Migration / Rollout

No migration required. El cambio es aditivo a nivel de comportamiento — tareas nuevas obtienen reporter, viejas mantienen `null`. Despliegue en dos commits independientes (BE primero, FE después), cada uno con su gate de push explícito del usuario.

## Open Questions

- Ninguna.
