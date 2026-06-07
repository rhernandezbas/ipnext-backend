# Spec delta — tasks-category-filter (#12)

Capability: filtro de estado en la lista de tareas usable sin proyecto. FE-only.

## ADDED Requirements

### Requirement: REQ-CAT-1 — Sin proyecto, filtrar por categoría de estado
Cuando NO hay proyecto seleccionado, el filtro de Estados ofrece las 4 categorías y filtra por ellas.

#### Scenario: muestra las 4 categorías sin proyecto
- **WHEN** no hay proyecto seleccionado y se abre el filtro de Estados
- **THEN** muestra **Nuevo / En progreso / Hecho / Cancelado** (en vez de "Seleccioná un proyecto para ver estados").

#### Scenario: elegir una categoría filtra las tareas
- **WHEN** se elige una categoría (p. ej. "En progreso")
- **THEN** se setea `filter.stageCategory='enProgreso'` y la lista muestra solo las tareas de esa categoría (transversal a todos los workflows; el filtrado client-side ya existe).

#### Scenario: selección única
- **WHEN** se elige otra categoría
- **THEN** reemplaza a la anterior (una a la vez). Re-clickear la activa la deselecciona (sin filtro de categoría).

### Requirement: REQ-CAT-2 — Con proyecto, comportamiento actual
#### Scenario: stages del workflow
- **WHEN** hay un proyecto seleccionado
- **THEN** el filtro de Estados muestra los stages de su workflow y filtra por `stageIds` (como hoy).

### Requirement: REQ-CAT-3 — No mezclar los dos modos
#### Scenario: cambiar de/ a proyecto limpia el modo opuesto
- **WHEN** se selecciona un proyecto
- **THEN** se limpia `stageCategory` (pasa a modo stages).
- **WHEN** se vuelve a "Todos los proyectos"
- **THEN** se limpian los `stageIds` (pasa a modo categoría).

### Requirement: REQ-CAT-4 — Chip de categoría activa
#### Scenario: chip con ×
- **WHEN** hay una `stageCategory` activa
- **THEN** aparece su chip en los filtros activos, con × para quitarla.

## Out of scope
- Backend (no se toca — el filtrado por categoría ya es client-side).
- Múltiples categorías a la vez; vista kanban.
