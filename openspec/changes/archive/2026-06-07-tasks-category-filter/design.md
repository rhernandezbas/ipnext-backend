# Design — tasks-category-filter (#12)

FE-only. Reusa el filtro `stageCategory` que ya existe; solo agrega UI.

## `StageMultiSelect` — dos modos según haya proyecto

Firma nueva (suma 2 props para el modo categoría):
```ts
function StageMultiSelect({
  workflowId,          // hay proyecto → modo stages
  selectedIds, onChange,        // modo stages (actual)
  stageCategory, onCategoryChange,  // modo categoría (sin proyecto)
})
```

- **`workflowId` presente → modo stages** (comportamiento actual): stages del workflow agrupados por categoría, multi-select de `stageIds`.
- **`workflowId` nulo → modo categoría**: renderiza las 4 categorías fijas
  `[{cat:'nuevo',label:'Nuevo'},{cat:'enProgreso',label:'En progreso'},{cat:'hecho',label:'Hecho'},{cat:'cancelado',label:'Cancelado'}]`
  como opciones de **selección única**: click en una → `onCategoryChange(cat)`; click en la activa → `onCategoryChange(undefined)`. El label del botón muestra la categoría activa (o "Estados").
  Reemplaza el empty state "Seleccioná un proyecto para ver estados".

## `TaskFilterBar`

- Pasar `stageCategory={filter.stageCategory}` y `onCategoryChange={cat => onFilterChange({ stageCategory: cat })}` al `StageMultiSelect`.
- El `<select>` de proyecto: al elegir un proyecto, además de `stageIds: []`, limpiar `stageCategory: undefined`. Al volver a "Todos", `stageIds: []` (ya lo hace). → `onFilterChange({ projectId: e.target.value || undefined, stageIds: [], stageCategory: undefined })`.
- Chips activos: agregar la chip de `stageCategory` (label de la categoría + × que hace `onFilterChange({ stageCategory: undefined })`). "Limpiar todo" ya debería incluir `stageCategory: undefined`.

## Filtrado
- **Sin cambios** — `SchedulingTasksPage` ya hace `tasks = stageCategory ? tasksRaw.filter(t => t.stageCategory === stageCategory) : tasksRaw`. `useTasksFilterUrl` ya parsea/persiste `stageCategory`.

## Tests (Vitest)
- `TaskFilterBar` (si tiene test; si no, uno mínimo): sin proyecto → el dropdown de Estados muestra las 4 categorías; click en "En progreso" llama `onFilterChange({ stageCategory: 'enProgreso' })`. Con proyecto → muestra los stages del workflow (mock `useWorkflow`). Seleccionar proyecto limpia `stageCategory`.
- Verificar en apply si existe `TaskFilterBar.test.tsx` para extenderlo.

## Riesgos
- Bajo. UI nueva sobre un filtro existente. El `useWorkflow(undefined)` ya devuelve sin stages (no rompe). La selección única de categoría no toca la forma del filtro (ya es single).
