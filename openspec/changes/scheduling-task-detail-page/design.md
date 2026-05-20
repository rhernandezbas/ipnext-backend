# Design: Scheduling Task Detail Page

## Technical Approach

The detail page is a single React component (`SchedulingTaskDetailPage`) composed from seven focused sub-components, each backed by a TanStack Query call. State is partitioned strictly: **server state lives in TanStack Query**, **transient form state lives in `react-hook-form`**, **ephemeral UI state (popover open, kebab open) lives in `useState`**. There is NO global store, NO Context provider for the page. The page is mounted under the existing `AdminLayout` + `ProtectedRoute` so authentication and chrome are inherited for free.

Skill `impeccable` is the spine of the visual design: clear hierarchy (sticky header → main → sidebar), generous spacing (8 px base × multiplier), restrained palette (one accent, four stage-category greys/blues/ambers/greens), accessible motion (≤ 180 ms transitions, all paused under `prefers-reduced-motion`), real loading/error/empty states on every async surface. The page is a **modern reinterpretation** of the Splynx detail screenshot — same information, modern layout. Splynx's busy three-column layout with floating modals becomes a calm two-column with inline editing.

The page reuses ONLY existing backend endpoints. No backend code changes.

---

## Architecture Decisions

### AD-1 — Rich-text editor: TipTap (vs Lexical, Slate, textarea)

**Decision**: TipTap 2 + StarterKit, dynamically imported with the page chunk.

**Why**:
- **TipTap** — React bindings (`@tiptap/react`), MIT, ~75 KB gzipped with StarterKit. Schema-driven (no `dangerouslySetInnerHTML` for the editor view), built-in sanitization, mature plugin ecosystem. Most importantly: HTML in, HTML out — matches the backend's `description String?` which already accepts HTML.
- **Lexical** — Facebook's editor. Excellent, but its data model is a JSON tree, so we'd have to serialize/deserialize to/from HTML on every read/write. Adds a translation layer the backend doesn't need.
- **Slate** — More flexible but heavier (~140 KB) and requires more glue. Same JSON-tree issue as Lexical.
- **Plain `<textarea>`** — Zero deps, ugly UX. Splynx's editor is BBcode/HTML rich — admins expect bold/italic/lists. A textarea is a regression vs the legacy.

**Tradeoff accepted**: +75 KB on the page chunk (lazy-loaded so not on the critical path). The DX and UX wins justify it. If bundle becomes an issue, we can downgrade to a markdown-it + textarea-with-preview combo in a future iteration.

### AD-2 — State management: TanStack Query + react-hook-form (vs Zustand, useReducer)

**Decision**: Two libraries, two domains.

- TanStack Query owns **server state**: task, workflow stages, admins, customer, partners.
- `react-hook-form` owns **form state**: dirty tracking, validation, controlled inputs in the Datos form.
- `useState` owns **ephemeral UI**: popover open, kebab open, in-place edit mode.

NO Zustand, NO Redux, NO Context for the page itself.

**Why**: This is the established pattern in the codebase (see `useScheduling.ts`, `usePartners.ts`). Adding a store for a single page would be over-engineering — every piece of "state" here is either a server resource or a form input. Form state needs dirty-tracking + validation, which `react-hook-form` provides for ~25 KB with zero ceremony.

### AD-3 — Form library: react-hook-form (vs vanilla controlled inputs)

**Decision**: react-hook-form for the Datos form ONLY. Other inputs (title in-place edit, description editor) use plain `useState`.

**Why**: The Datos form has 9 fields with cross-field validation (endDate ≥ startDate, travel-times ≥ 0) and a "Guardar cambios" button that only enables on dirty. Vanilla controlled inputs would need a custom dirty-tracker and validator — RHF gives both for free, integrates with `zodResolver` if we want zod schemas later, and is the React community standard.

**Tradeoff**: One more library. ~25 KB gzipped. Worth it for this page; trivial to remove later if regretted.

### AD-4 — Optimistic UI vs eager save vs explicit Save

**Decision**: Hybrid, per-section.

| Surface | Strategy | Rationale |
|---------|----------|-----------|
| Title | **Optimistic** (Enter / blur commits) | Single-field, low-stakes. Reverts on error. |
| Stage selector | **Optimistic** on select | Single PATCH, user expects immediate kanban-like feedback. |
| Priority selector | **Optimistic** on select | Same as stage. |
| Watchers (add/remove) | **Optimistic** with chip slide-in/out | Multi-step would be jarring. |
| Datos form | **Explicit Save** button | 9 fields, cross-field validation, atomic submit. |
| Description editor | **Explicit Save** button | User intent: drafting. Auto-save would interrupt typing. |
| Address/map | **Explicit Save** (folded into Datos form) | Geocoding has its own loading; save is part of "Guardar cambios". |

### AD-5 — Information architecture and layout

#### 1280 px wireframe (low-fi ASCII)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◀  Scheduling / Tarea #1234           [stage▼ Nuevo] [pri▼ Alta] ⋮  │  ← sticky
├──────────────────────────────────────────────────────────────────────┤
│  ┌─ T1234 · Instalación Cliente Pérez ─────────────────[edit]─┐      │
│  │ (editable title, 1.5rem semibold)                          │      │
│  └────────────────────────────────────────────────────────────┘      │
│  ┌─────────────────────────────────┐  ┌──────────────────────┐       │
│  │ ▣ Datos                         │  │ Cliente              │       │
│  │ ┌──────────────┬──────────────┐ │  │ ┌──────────────────┐ │       │
│  │ │ Proyecto     │ Asignado a   │ │  │ │ ◉ Pérez, Juan    │ │       │
│  │ │ [select]     │ [select]     │ │  │ │ Ver perfil →     │ │       │
│  │ ├──────────────┼──────────────┤ │  │ └──────────────────┘ │       │
│  │ │ Partner      │ Cliente      │ │  │ Servicio             │       │
│  │ │ [select]     │ [search]     │ │  │ ┌──────────────────┐ │       │
│  │ ├──────────────┼──────────────┤ │  │ │ Plan Fibra 300   │ │       │
│  │ │ Servicio     │ Inicia       │ │  │ │ Ver servicio →   │ │       │
│  │ │ [select]     │ [dt local]   │ │  │ └──────────────────┘ │       │
│  │ ├──────────────┼──────────────┤ │  │ Reporter             │       │
│  │ │ Termina      │ Tiempo ida   │ │  │ ┌──────────────────┐ │       │
│  │ │ [dt local]   │ [min]        │ │  │ │ ◉ M. González    │ │       │
│  │ ├──────────────┼──────────────┤ │  │ └──────────────────┘ │       │
│  │ │ Tiempo vuelta│              │ │  │ Watchers (3)         │       │
│  │ │ [min]        │              │ │  │ ┌──────────────────┐ │       │
│  │ └──────────────┴──────────────┘ │  │ │ ⊕ ⊕ ⊕   + Añadir│ │       │
│  │            [Guardar cambios]    │  │ └──────────────────┘ │       │
│  └─────────────────────────────────┘  └──────────────────────┘       │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │ ▣ Ubicación                                             │         │
│  │ [Dirección: Av. Corrientes 1234, CABA              🔍] │         │
│  │ ┌─────────────────────────────────────────────────────┐ │         │
│  │ │                                                     │ │         │
│  │ │             [Leaflet map, marker draggable]         │ │         │
│  │ │                                                     │ │         │
│  │ └─────────────────────────────────────────────────────┘ │         │
│  └─────────────────────────────────────────────────────────┘         │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │ ▣ Descripción                                           │         │
│  │ [B I • 1. ⌘link]   [TipTap editor area]                 │         │
│  │                                                          │         │
│  │                                       [Guardar]         │         │
│  └─────────────────────────────────────────────────────────┘         │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │ ▣ Lista de verificación   (próximamente — change 5)    │         │
│  └─────────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────┘
```

Main column = `grid-column: span 8 / 12`. Sidebar = `span 4 / 12`. Gap = 1.5 rem.

#### 768 px wireframe

```
┌──────────────────────────────────────────────────┐
│  ◀  Tarea #1234     [stage▼] [pri▼]      ⋮       │  ← sticky
├──────────────────────────────────────────────────┤
│  T1234 · Instalación Cliente Pérez       [edit]  │
│  ┌────────────────────────────────────────────┐  │
│  │ ▣ Datos    (single column, all fields)     │  │
│  │ Proyecto     [select]                      │  │
│  │ Asignado a   [select]                      │  │
│  │ Partner      [select]                      │  │
│  │ ...                                        │  │
│  │ [Guardar cambios]                          │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │ ▣ Ubicación  ...                           │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │ ▣ Descripción ...                          │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │ Cliente — Pérez, Juan   →                  │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │ Servicio — Plan Fibra 300   →              │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │ Reporter — M. González                     │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │ Watchers — ⊕ ⊕ ⊕  + Añadir                │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### AD-6 — Typography, spacing, colour tokens

Defined as CSS custom properties in `SchedulingTaskDetailPage.module.css`:

```css
.page {
  --fs-xs: 0.75rem;   /* 12 px - meta labels */
  --fs-sm: 0.875rem;  /* 14 px - secondary */
  --fs-base: 1rem;    /* 16 px - body */
  --fs-md: 1.125rem;  /* 18 px - section titles */
  --fs-lg: 1.25rem;   /* 20 px - card titles */
  --fs-xl: 1.5rem;    /* 24 px - page title */
  --fs-2xl: 2rem;     /* 32 px - hero number */

  --sp-1: 0.25rem;
  --sp-2: 0.5rem;
  --sp-3: 0.75rem;
  --sp-4: 1rem;
  --sp-6: 1.5rem;
  --sp-8: 2rem;

  --c-bg: #FFFFFF;
  --c-surface: #F8FAFC;
  --c-border: #E2E8F0;
  --c-text: #0F172A;
  --c-text-muted: #64748B;
  --c-accent: #2563EB;
  --c-accent-hover: #1D4ED8;
  --c-danger: #DC2626;

  /* stage categories */
  --c-stage-nuevo-bg: #DBEAFE;
  --c-stage-nuevo-fg: #1E40AF;
  --c-stage-enProgreso-bg: #FEF3C7;
  --c-stage-enProgreso-fg: #92400E;
  --c-stage-hecho-bg: #D1FAE5;
  --c-stage-hecho-fg: #065F46;
  --c-stage-cancelado-bg: #E2E8F0;
  --c-stage-cancelado-fg: #334155;
}
```

All four stage-category pairs ≥ 4.5:1 contrast (WCAG AA verified via the math: `#1E40AF` on `#DBEAFE` = 7.8:1; `#92400E` on `#FEF3C7` = 7.5:1; `#065F46` on `#D1FAE5` = 7.9:1; `#334155` on `#E2E8F0` = 9.6:1).

Type scale geometric: 0.75 / 0.875 / 1.0 / 1.125 / 1.25 / 1.5 / 2.0 rem — 1.125× ratio after `1rem`.

### AD-7 — Motion guidelines

- All transitions: `cubic-bezier(0.4, 0, 0.2, 1)`, duration `150ms` (UI feedback) or `200ms` (layout shifts).
- Animated properties: `opacity`, `transform`, `background-color`. NEVER `width`/`height` (layout thrashing).
- Skeleton shimmer: 1.5s linear infinite, but capped to 3 cycles (no perpetual shimmer).
- Toast slide-up: 200 ms `translateY(8px) → 0`.
- Under `@media (prefers-reduced-motion: reduce)`: all transitions become `0ms`, animations become `opacity` fades.

### AD-8 — Empty / loading / error visuals per section

| Section | Loading | Empty | Error |
|---------|---------|-------|-------|
| Page | `<Spinner fullPage />` | "Tarea no encontrada" + back link | Toast with mapped Spanish message + retry |
| Stage selector | Skeleton chip 80×24 px | "Sin workflow" (rare; backend always has default) | Disabled + tooltip |
| Datos form | Skeleton 9 input rows | n/a | Inline error per field + form-level summary |
| Ubicación | Skeleton map 360 px | Placeholder card + default map of Argentina | Inline "No se pudo geocodificar" |
| Descripción | Skeleton 3 lines | Muted placeholder "Sin descripción. Haz clic para añadir." | Editor disabled + retry button |
| Cliente | Skeleton avatar+name | "Sin cliente asignado" + "Vincular" CTA | Inline "Error al cargar cliente" |
| Servicio | Skeleton | "Sin servicio asignado" | "Error al cargar servicio" |
| Watchers | Skeleton 3 chips | "Sin watchers" + "Añadir watcher" | Inline error |

### AD-9 — Accessibility commitments

- Every interactive element reachable by Tab in DOM order.
- `:focus-visible` outline 2 px solid `--c-accent` offset 2 px.
- Icon-only buttons: `aria-label` in Spanish.
- Save-status announcements: `<div aria-live="polite" aria-atomic="true" />` hidden visually but read by SR.
- Semantic landmarks: `<header>`, `<main>`, `<aside>` (sidebar), `<section>` per card.
- Headings hierarchy: `<h1>` for task title, `<h2>` for section titles. No skipped levels.
- Modal/popover focus traps via the existing `@/components/atoms/KebabMenu` pattern (already implements focus management).
- Map: marker has `tabIndex={0}`, arrow keys nudge position by 0.0001° (≈ 11 m). Documented in the component file.

### AD-10 — Responsive breakpoints + behaviour

```css
/* defaults: ≥ 1280px */
.layout { grid-template-columns: 8fr 4fr; gap: var(--sp-6); }

@media (max-width: 1279px) {
  .layout { grid-template-columns: 9fr 3fr; gap: var(--sp-4); }
}
@media (max-width: 1023px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { order: 2; }
}
@media (max-width: 767px) {
  .page { padding: var(--sp-3); }
  .header { flex-wrap: wrap; }
}
```

Map height: `min-height: 360px` on all viewports. Title size: 1.5 rem default, 1.25 rem at ≤ 767 px.

### AD-11 — Dirty state + confirm-on-leave

`react-hook-form` exposes `formState.isDirty`. We track:
- `formDirty` (RHF) — Datos form
- `descriptionDirty` (`useState<boolean>`) — TipTap editor
- `titleEditingDirty` (`useState<boolean>`) — in-place title edit

Page-level `isDirty = formDirty || descriptionDirty || titleEditingDirty`.

On `isDirty === true`:
- `useBlocker` from `react-router-dom` v6 returns a `blocker` we use to show `confirm("Tienes cambios sin guardar. ¿Salir igual?")` before letting the route change.
- `window.addEventListener('beforeunload', ...)` for full-tab navigation (close tab, browser back).

After successful save, the corresponding flag resets.

### AD-12 — Date/time handling (timezone safety)

- Inputs use `<input type="datetime-local">` which gives a string like `2026-05-20T14:30` interpreted in the user's local TZ.
- Convert on write: `new Date(localStr).toISOString()` → `"2026-05-20T17:30:00.000Z"`.
- Convert on read: backend returns ISO with offset → `new Date(iso).toISOString().slice(0,16)` → fed back into the input.
- Display in cards: `new Date(iso).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })`.

Documented inline in `DatosForm.tsx`.

---

## Data Flow

```
┌─────────────────────────┐
│ SchedulingTaskDetailPage│
│  useTask(id) ──────────────►  GET /api/scheduling/:id
│  useWorkflow(workflowId) ────►  GET /api/workflows/:id
│  useAdmins() ────────────────►  GET /api/admins
│  useClient(customerId) ──────►  GET /api/clients/:id  (conditional)
│  usePartners() ──────────────►  GET /api/partners
│                         │
│  useUpdateTask() ◄───────────┐
│  useMoveTaskToStage() ◄──────┼─ buttons / form save
│  useDeleteTask() ◄───────────┘
│                         │
│  onSuccess → invalidate ['scheduling-task', id] + ['scheduling-tasks']
└─────────────────────────┘
```

All writes funnel through the existing `axios-client.ts` which handles auth cookies, CSRF, and 401 → `/login` redirect.

---

## File Changes

| Path (frontend repo unless noted) | Type | Purpose |
|------|------|---------|
| `src/App.tsx` | Modify | Add lazy import + Route `/admin/scheduling/tasks/:id` |
| `src/types/scheduling.ts` | Modify | Align with backend; deprecate legacy fields |
| `src/api/scheduling.api.ts` | Modify | Add `moveTaskToStage(id, stageId)` |
| `src/hooks/useScheduling.ts` | Modify | Add `useTask(id)`, `useMoveTaskToStage` |
| `src/pages/scheduling/SchedulingTaskDetailPage.tsx` | New | Page entry |
| `src/pages/scheduling/SchedulingTaskDetailPage.module.css` | New | Tokens + layout |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskHeader.tsx` | New | Sticky header |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskHeader.module.css` | New | |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/DescriptionEditor.tsx` | New | TipTap wrapper |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/DescriptionEditor.module.css` | New | |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/DatosForm.tsx` | New | RHF form |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/DatosForm.module.css` | New | |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/UbicacionMap.tsx` | New | Leaflet + geocode |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/UbicacionMap.module.css` | New | |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/WatchersChips.tsx` | New | Chip list + popover |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/WatchersChips.module.css` | New | |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/CustomerCard.tsx` | New | |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/ServiceCard.tsx` | New | |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/ReporterCard.tsx` | New | |
| `src/pages/scheduling/SchedulingTaskDetailPage/lib/geocode.ts` | New | Nominatim wrapper (debounced) |
| `src/__tests__/scheduling/SchedulingTaskDetailPage.test.tsx` | New | Page integration test |
| `src/__tests__/scheduling/components/TaskHeader.test.tsx` | New | |
| `src/__tests__/scheduling/components/DescriptionEditor.test.tsx` | New | |
| `src/__tests__/scheduling/components/DatosForm.test.tsx` | New | |
| `src/__tests__/scheduling/components/UbicacionMap.test.tsx` | New | (uses existing `__mocks__/react-leaflet.tsx`) |
| `src/__tests__/scheduling/components/WatchersChips.test.tsx` | New | |
| `src/pages/scheduling/SchedulingProjectsPage.tsx` | Modify | Link to detail page |
| `src/pages/scheduling/SchedulingCalendarPage.tsx` | Modify | Link to detail page |
| `src/pages/scheduling/SchedulingMapsPage.tsx` | Modify | Link to detail page |
| `src/pages/scheduling/SchedulingDashboardPage.tsx` | Modify | Link to detail page |
| `package.json` | Modify | Add `@tiptap/react`, `@tiptap/starter-kit`, `react-hook-form` |
| **(backend)** | — | **No changes** |

---

## Component Tree

```
SchedulingTaskDetailPage
├── TaskHeader
│   ├── (editable title input)
│   ├── StageDropdown (uses workflow query)
│   ├── PrioritySelect
│   └── KebabMenu (Delete, Duplicate-disabled, Open-in-calendar)
├── <main>
│   ├── DatosForm (react-hook-form)
│   │   ├── ProjectSelect       (useProjects)
│   │   ├── AssigneeSelect      (useAdmins)
│   │   ├── PartnerSelect       (usePartners)
│   │   ├── CustomerSearch      (useClients{search})
│   │   ├── ServiceInput
│   │   ├── StartDateInput
│   │   ├── EndDateInput
│   │   ├── TravelTimeToInput
│   │   └── TravelTimeFromInput
│   ├── UbicacionMap
│   │   ├── AddressInput (debounced geocode)
│   │   └── MapContainer + draggable Marker
│   ├── DescriptionEditor (TipTap)
│   └── ChecklistPlaceholder (change-5 stub)
└── <aside>
    ├── CustomerCard
    ├── ServiceCard
    ├── ReporterCard
    └── WatchersChips
        ├── ChipList
        └── AddWatcherPopover (useAdmins + search)
```

---

## Interfaces (TypeScript prop signatures)

```ts
// TaskHeader
interface TaskHeaderProps {
  task: ScheduledTask;
  stages: WorkflowStage[];
  onTitleSave: (title: string) => Promise<void>;
  onStageMove: (stageId: string) => Promise<void>;
  onPriorityChange: (priority: TaskPriority) => Promise<void>;
  onDelete: () => void;
  isSaving: boolean;
}

// DescriptionEditor
interface DescriptionEditorProps {
  initialHtml: string | null;
  onSave: (html: string) => Promise<void>;
  isSaving: boolean;
}

// DatosForm
interface DatosFormValues {
  projectId: string | null;
  assigneeId: string | null;
  partnerId: string | null;
  customerId: string | null;
  serviceId: string | null;
  startDate: string | null;   // ISO 8601
  endDate: string | null;
  travelTimeTo: number | null;
  travelTimeFrom: number | null;
  address: string | null;
  coordinates: { lat: number; lng: number } | null;
}
interface DatosFormProps {
  initial: DatosFormValues;
  onSubmit: (values: DatosFormValues) => Promise<void>;
  isSaving: boolean;
}

// UbicacionMap
interface UbicacionMapProps {
  address: string | null;
  coordinates: { lat: number; lng: number } | null;
  onChange: (next: { address: string | null; coordinates: { lat: number; lng: number } | null }) => void;
}

// WatchersChips
interface WatchersChipsProps {
  watcherIds: string[];
  allAdmins: Admin[];
  onChange: (nextIds: string[]) => Promise<void>;
  isSaving: boolean;
}
```

---

## Testing Strategy

- **Strict TDD red-first** for every component (per project policy).
- **Vitest + @testing-library/react + jsdom + user-event**.
- **`__mocks__/react-leaflet.tsx`** already exists — `UbicacionMap.test.tsx` uses it; we mock marker drag via the existing pattern.
- **MSW** for HTTP mocking if not already configured; otherwise we use `vi.mock('@/api/scheduling.api')`.
- **Per-component tests**: render, dirty-state, optimistic update path, error path.
- **Page integration test**: full mount with mocked APIs, assert sections render, assert keyboard nav reaches all controls.
- **Accessibility**: structural assertions (heading order, ARIA labels, focus-visible classes). If `vitest-axe` is on the team's radar, add it under devDeps and run `expect(await axe(container)).toHaveNoViolations()` on page render. Otherwise scoped for a future a11y change.
- **E2E smoke**: Playwright-style steps in `tasks.md` for the orchestrator to run against the deployed instance.

---

## Open Questions

1. **`vitest-axe`** — add it now or in a follow-up? Recommendation: follow-up (keeps this change focused).
2. **Service search popover** — implement now with a thin `GET /api/clients/:id/services` call, or defer to change 5? Recommendation: defer; service is read-only in this iteration, edit via the customer-detail page.
3. **Duplicate task** action — wire it now (POST a copy) or stay disabled? Recommendation: disabled with tooltip; revisit in change 6 when the kanban context makes duplicate more useful.
4. **Checklist placeholder shape** — empty card with "Próximamente" text, OR scaffolded UI (checkbox rows, disabled) to reduce churn in change 5? Recommendation: empty card with text — minimises throwaway code.
5. **Nominatim usage** — public OSM is rate-limited (1 req/s). Acceptable for admin tool. If we hit limits, switch to a self-hosted instance — out of scope here.
