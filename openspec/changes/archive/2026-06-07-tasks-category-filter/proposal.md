# Proposal — tasks-category-filter (#12)

Mode: interactive · Store: hybrid (openspec + engram `sdd/tasks-category-filter/*`). FE-only.

## Why

En "Todos los proyectos" (sin proyecto seleccionado) el filtro de Estados no se puede usar: el `StageMultiSelect` toma los stages del workflow del proyecto, así que sin proyecto muestra "Seleccioná un proyecto para ver estados". Se quiere poder filtrar por estado estando en "Todos los proyectos".

## Hallazgo (acota mucho el trabajo)

El filtro por **categoría de estado** (`stageCategory`: nuevo/enProgreso/hecho/cancelado) **ya existe y ya filtra** — es client-side en `SchedulingTasksPage` (`tasksRaw.filter(t => t.stageCategory === stageCategory)`), y `useTasksFilterUrl` ya lo parsea/persiste en la URL. **Lo único que falta es exponerlo en la UI.** No hay cambios de backend.

## Decisiones

- **AD-1 — Modo categoría sin proyecto**: cuando NO hay proyecto seleccionado, el `StageMultiSelect` muestra las **4 categorías** (Nuevo / En progreso / Hecho / Cancelado) y al elegir una setea `filter.stageCategory`. Cuando HAY proyecto: comportamiento actual (stages del workflow → `stageIds`).
- **AD-2 — Selección única de categoría**: `filter.stageCategory` es un solo valor (como ya está). El modo categoría selecciona una a la vez (coherente con el filtro existente; no se extiende a múltiples).
- **AD-3 — Limpiar el modo opuesto al cambiar de proyecto**: al seleccionar un proyecto se limpia `stageCategory`; al volver a "Todos los proyectos" se limpian los `stageIds`. Así nunca quedan los dos modos activos a la vez.

## What changes (FE-only)

- `TaskFilterBar` / `StageMultiSelect`: cuando `workflowId` es nulo, renderizar las 4 categorías como opciones (en vez del empty state) y cablearlas a `filter.stageCategory`. El select de proyecto, al cambiar, limpia el modo opuesto.
- Las chips de filtros activos: mostrar la categoría seleccionada (con su × para quitar), análogo a los stages.

## Impact / Out of scope
- **Out of scope**: backend (no se toca); múltiples categorías a la vez; cambiar la vista kanban.
- **Riesgo**: bajo. Reusa el filtro `stageCategory` ya existente; solo agrega UI. La vista de tareas filtra client-side, así que es inmediato.

## A confirmar
1. ¿Selección **única** de categoría (lo más simple, matchea lo existente) o **múltiples**? Default: única.
2. La categoría **"Cancelado"** existe en el tipo pero el `StageMultiSelect` actual solo agrupa Nuevo/En progreso/Hecho. ¿Incluir "Cancelado" como 4ª opción en modo categoría? Default: sí (las 4).
