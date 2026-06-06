# Proposal: activity-watcher-names  (backlog #17)

## Why
El feed de actividad de la tarea (#10) muestra los eventos `watcher_added` / `watcher_removed`
como **"agregó un observador" / "quitó un observador"** — sin el nombre del observador. Es el
ÚNICO evento del feed que no muestra el diff completo: tras los refinamientos del #10, los demás
FK (proyecto / cliente / reportante / asignado) ya resuelven y muestran el nombre en `metadata`.

## What Changes
- **BE (fuente de verdad, consistente con el resto)**: el diff engine `computeUpdateTaskActivities`
  emite los eventos de watcher con el **nombre** del observador en `metadata` — `toName` para
  `watcher_added`, `fromName` para `watcher_removed` — igual que `reporter_changed` /
  `customer_changed` ya hacen con el helper `names(...)`.
- **FE**: `describeActivity` muestra el nombre — "agregó a {nombre}" / "quitó a {nombre}" — con
  fallback a "un observador" si el nombre no viene (degradado, nunca rompe el feed).

## Impact
- Eventos afectados: `watcher_added`, `watcher_removed`. Sin migración (es `metadata` jsonb).
- Cross-repo: BE (diff engine + resolución del nombre) + FE (`describeActivity`). Cada uno su PR/deploy.
- **Decisión abierta para el DESIGN**: cómo resolver `watcherId → nombre` en el BE. El `ScheduledTask`
  hoy expone `watcherIds: string[]` pero NO `watcherNames` (por eso es el único evento sin nombre).
  Candidatos: (a) agregar `watcherNames` derivado al task (JOIN) alineado con `watcherIds`;
  (b) pasar un resolver/lookup `id→nombre` a `computeUpdateTaskActivities` desde `UpdateTask`
  (vía `RbacUserRepository`). Se resuelve en la fase de Design.
