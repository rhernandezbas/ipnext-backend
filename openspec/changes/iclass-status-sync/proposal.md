# Proposal: iclass-status-sync — catálogo configurable de estados de IClass

## Intent

Hoy Prominense NO ve el estado de una OS de IClass salvo cuando ya cerró: el ingest (`IngestClosedServiceOrders.processSummary`) **descarta** toda OS cuyo `statusCode !== '7'` (`skippedNotClosed`). El operador no tiene seguimiento de los estados intermedios (Agendada, Em Análise, Vinculada Credenciada, …) y, peor, esos `id` de estado son **OPACOS** — IClass no los documenta como enum.

El usuario eligió el **Approach 3** de la investigación: un **catálogo configurable de mapeo estado-IClass → etiqueta Prominense** (mismo patrón que `IClassResultCode`/`IClassNode`), para **elegir qué estados traer/resaltar** y cómo etiquetarlos. La pieza clave (verificada en código): el `IClassPort.listServiceOrders()` que el scheduler ya corre **YA devuelve `statusCode` + `statusDescription` de TODAS las OS del rango** (`parseServiceOrderSummary` lee `status.id`/`status.descricao` siempre) — el filtro terminal está aguas abajo, en el use-case. Por eso NO hace falta un `getServiceOrder(id)` nuevo ni nuevas llamadas a IClass: ampliamos el use-case existente para capturar el status de las OS atadas a una tarea, ANTES del filtro `'7'`, resolviendo de paso los códigos opacos vía auto-discovery.

## Scope

### In Scope (Fase 1 — solo estado visible configurable)

1. **Capturar el status de las OS abiertas**: extender `IngestClosedServiceOrders.processSummary` para que, ANTES del guard `statusCode !== '7'`, resuelva la tarea por `iclassCodigo ↔ sequenceNumber` y persista el statusCode/description actual en la tarea + haga auto-upsert del statusCode en el catálogo. El guard terminal se mantiene para el resto del flujo (mirror/cierre intactos).
2. **Catálogo `IClassStatusCatalog`** (tabla nueva, patrón `IClassResultCode`): `statusCode` (id opaco de IClass, UNIQUE), `iclassLabel` (`descricao` crudo del último visto), `displayLabel` (etiqueta Prominense editable, null = usar `iclassLabel`), `color` (hex opcional como result-code), `tracked` (bool, default false = el operador opta-in al seguimiento). **AUTO-DISCOVERY**: el sync hace upsert por `statusCode` con `tracked=false` por default → el catálogo se auto-puebla con los estados REALES observados, resolviendo el problema de los códigos opacos.
3. **Campo `iclassStatusCode` (+ `iclassStatusUpdatedAt`) en `ScheduledTask`**: guarda SOLO el code actual de su OS. El label/color se resuelven al leer vía el catálogo (NO se desnormaliza el label, igual que `IClassResultCode.mappedStageName` se resuelve por JOIN).
4. **FE**: (a) sub-tab de config "Estados de IClass" (espejo de la página de result-codes): lista los estados descubiertos, edita `displayLabel`/`color`, togglea `tracked`, botón sync. (b) Badge del estado de IClass (displayLabel + color del catálogo) en el detalle y el listado de la tarea, SOLO para estados `tracked`.
5. **Permisos** (dos capas FE+BE): `iclass.read` para ver, `iclass.manage` para configurar (ambos ya existen, ya usados por el router de closure).

### Out of Scope (próximas fases — anotadas, NO ahora)

- **Fase 2 — Cerrar/validar la OS desde Prominense** (`POST /serviceorders/close`): no se toca el port de escritura.
- **Fase 3 — Asignar técnico/cuadrilla desde Prominense** (`POST /serviceorders/update` + catálogo `IClassTeam`): fuera.
- Historial de estados de OS abiertas (timeline `IClassSoStatusHistory` para no-cerradas): fuera; este cambio persiste solo el estado ACTUAL.
- Polling on-demand en tiempo real al abrir la tarea (Approach 1): fuera; el scheduler de 10 min es la única fuente (lag aceptado).

## Capabilities

### New Capabilities

- `iclass-status-catalog`: catálogo persistido de estados de IClass con auto-discovery (auto-upsert del statusCode observado), sync manual, listado/edición admin (displayLabel, color, tracked) y resolución de etiqueta al leer.
- `iclass-task-status`: el estado actual de la OS persistido en la tarea (`iclassStatusCode` + `iclassStatusUpdatedAt`), expuesto en el DTO de tarea como `{ iclassStatus: { code, label, color, tracked } | null }` resuelto vía catálogo, y renderizado en FE solo cuando `tracked`.

### Modified Capabilities

- El loop de cierre (`iclass-closure-loop`): `processSummary` ahora captura el status ANTES del filtro terminal. El comportamiento de mirror/transición/side-effects para las OS terminales (`'7'`) NO cambia.

## Approach

Espejo del patrón `IClassResultCode` (entity + port + Prisma/InMemory + use-cases Sync/List/Update + router admin + DTO + wiring), con dos diferencias: (a) la fuente de discovery NO es un endpoint dedicado de IClass sino las OS ya listadas por el scheduler (auto-upsert pasivo) más un sync explícito que reusa `listServiceOrders` sobre la ventana reciente; (b) la "configuración" no es un mapeo a Stage sino tres campos editables (`displayLabel`, `color`, `tracked`). El estado en la tarea guarda solo el `statusCode`; el read-path lo resuelve por JOIN al catálogo (como `mappedStageName`).

El punto de inserción en `processSummary` es quirúrgico: una llamada nueva, idempotente, ANTES del `if (s.statusCode !== TERMINAL_STATUS)`, que (1) resuelve la tarea por `sequenceNumber` (ya se hace para el terminal — se sube ese lookup), (2) escribe el statusCode actual en la tarea solo si cambió, (3) auto-upserta el statusCode en el catálogo. El guard terminal sigue cortando el resto del flujo para no-`'7'`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` + migración | New/Mod | Modelo `IClassStatusCatalog` + 2 columnas en `ScheduledTask` |
| `src/domain/{entities,ports,errors}` | New/Mod | Entidad `IClassStatusCatalogEntry`, port `IClassStatusCatalogRepository`, error not-found |
| `src/application/use-cases/` | New/Mod | `SyncIClassStatuses`, `ListIClassStatusCatalog`, `UpdateIClassStatusCatalog`; modificar `IngestClosedServiceOrders` |
| `src/application/dto/` | Mod | `iclassStatus` en el DTO de tarea + DTO del catálogo |
| `src/infrastructure/adapters/{prisma,in-memory}` | New | Repos parity del catálogo + setIClassStatus en SchedulingRepository |
| `src/infrastructure/http/{routes,app.ts}` | Mod | Router admin del catálogo + wiring + status en task routes |
| FE config page + task badge + hooks/api | New/Mod | Sub-tab "Estados de IClass" + badge en detalle/listado |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Códigos de estado opacos (no documentados) | High → resuelto | Auto-discovery: el catálogo se auto-puebla con `statusCode`+`iclassLabel` reales observados; el operador edita después |
| Rate-limit 429 al traer estados | Low | CERO llamadas nuevas en el scheduler (reusa `listServiceOrders` que ya corre); el sync manual reusa `withAuthRetry` |
| OS abiertas que hoy se descartan (`skippedNotClosed`) | Med | El capture corre ANTES del guard terminal; el guard se mantiene para mirror/cierre, así que el flujo terminal no cambia |
| Escribir status en cada tick infla writes | Low | Update condicional: solo persiste si `iclassStatusCode` cambió (idempotente) |
| Estado en portugués sin etiqueta amigable | Med | `displayLabel` editable; mientras null se muestra `iclassLabel` crudo; `tracked=false` por default lo oculta del FE hasta que el operador opta-in |

## Rollback Plan

Revert del PR (BE+FE). La tabla `IClassStatusCatalog` y las columnas `iclassStatusCode`/`iclassStatusUpdatedAt` son aditivas y nullable → pueden quedar sin romper nada. El `processSummary` vuelve al filtro terminal directo; el mirror/cierre nunca dependió de los campos nuevos.

## Dependencies

- Credenciales IClass ya configuradas (mismo `buildIClassClient()` del sync de result-codes).
- Scheduler de closure ya operativo (`iclass-closure-loop` flag). El capture de status va atado a ese tick.
- Permisos `iclass.read` / `iclass.manage` ya existentes y asignados (router de closure).

## Success Criteria

- [ ] Tras un tick del scheduler, las OS abiertas atadas a una tarea pueblan el catálogo con su `statusCode`+`iclassLabel` reales (`tracked=false`).
- [ ] La tarea muestra `iclassStatusCode` actual; el DTO resuelve `{ code, label, color, tracked }` vía catálogo.
- [ ] El operador edita `displayLabel`/`color` y togglea `tracked` desde la sub-tab de config; el badge en la tarea refleja el cambio.
- [ ] El badge en detalle/listado aparece SOLO para estados `tracked`.
- [ ] El flujo de cierre terminal (`'7'`) y el mirror NO cambian (tests existentes verdes).
