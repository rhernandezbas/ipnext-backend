# Tasks — tasks-category-filter (#12)

FE-only. Strict TDD (red→green). Reusa el filtro `stageCategory` existente.

## Frontend (ipnext-frontend)

- [ ] **1. RED+GREEN — `StageMultiSelect` modo categoría** (`TaskFilterBar` + su test)
  - RED: sin `workflowId` → el dropdown de Estados muestra **Nuevo / En progreso / Hecho / Cancelado** (no el empty state); click en "En progreso" llama `onCategoryChange('enProgreso')`; click en la activa → `onCategoryChange(undefined)`. Con `workflowId` → muestra los stages del workflow (mock `useWorkflow`, comportamiento actual).
  - GREEN: `StageMultiSelect` suma props `stageCategory` + `onCategoryChange`; si `!workflowId` renderiza las 4 categorías (selección única) en vez del empty state; el label del botón muestra la categoría activa.

- [ ] **2. Cablear en `TaskFilterBar`**
  - Pasar `stageCategory={filter.stageCategory}` + `onCategoryChange={cat => onFilterChange({ stageCategory: cat })}` al `StageMultiSelect`.
  - El `<select>` de proyecto: `onChange` → `onFilterChange({ projectId: e.target.value || undefined, stageIds: [], stageCategory: undefined })` (limpiar el modo opuesto).
  - Chips activos: agregar la chip de `stageCategory` (label + × → `onFilterChange({ stageCategory: undefined })`); incluir `stageCategory: undefined` en "Limpiar todo".

- [ ] **3. Test del comportamiento de limpieza**
  - Seleccionar un proyecto limpia `stageCategory`; volver a "Todos" limpia `stageIds`. (Si el test de TaskFilterBar lo permite; si no, cubrir lo esencial.)

- [ ] **4. Verify FE** — `tsc --noEmit` (0) + `npx vitest run` (verde). Commit + deploy (OK) + confirmar run en `gh`. Validación visual del filtro en "Todos los proyectos".

## Cierre

- [ ] **5. Archive + docs** — `sdd-archive` (mover change a `archive/`). Commit del `BACKLOG.md`: #12 → hecho (+ #23/#24/#25/#26 que viajan local).
