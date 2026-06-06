# Design: activity-watcher-names (#17)

## Decisión: Approach B — resolver el nombre con el lookup de usuarios existente

**Recomendado.** El nombre se resuelve durante la escritura (en `UpdateTask`), reusando el
`adminLookup` que UpdateTask **ya** usa para validar los watchers, y se pasa al diff engine.

### Por qué B y no A

| | Approach A (watcherNames derivado en el task) | **Approach B (resolver vía lookup)** ✅ |
|---|---|---|
| Superficie | entity `ScheduledTask` + `PrismaSchedulingRepository` (JOIN) + `InMemory` + DTO + diff engine | `EntityLookup` (+name opcional) + `UpdateTask` + diff engine |
| Modelo/DTO de lectura | **cambia** (nuevo campo `watcherNames`) | **no cambia** |
| Resolver el watcher puntual | alinear `watcherIds`/`watcherNames` por índice (**frágil**) | map `id→name` directo (**robusto**, N watchers) |
| Reuso | — | `userLookupForScheduling` YA hace `rbacUserRepo.findById(id)` que trae `rbacUser.name` — hoy lo descarta |
| Consistencia del resultado | `metadata.toName/fromName` | **idéntico**: `metadata.toName/fromName` (el FE lo consume igual) |

El factor decisivo: `userLookupForScheduling` ya resuelve el `RbacUser` completo (con nombre) para
validar cada watcher — solo lo descarta. Devolver el nombre es a un paso, y `UpdateTask` ya recorre
los watchers. Approach A duplicaría la resolución en la capa de lectura (JOIN) y tocaría el modelo.

## Cambios

| Archivo | Cambio |
|---------|--------|
| `domain/ports/EntityLookup.ts` | `findById(id): Promise<{ id: string; name?: string } \| null>` (name **opcional**, retrocompatible — los otros lookups no lo devuelven y siguen igual) |
| `infrastructure/http/app.ts` | `userLookupForScheduling` devuelve `{ id, name: rbacUser.name }` (hoy descarta el name) |
| `application/use-cases/UpdateTask.ts` | cuando hay recorder y cambió `watcherIds`: resolver un `Record<id,name>` de la UNIÓN `prev.watcherIds ∪ data.watcherIds` vía `adminLookup` y pasarlo al diff engine |
| `application/use-cases/computeUpdateTaskActivities.ts` | nuevo param opcional `watcherNames?: Record<string,string>`; `watcher_added` → `metadata { toName }`, `watcher_removed` → `metadata { fromName }` |
| **FE** `taskActivityLabel.ts` | `watcher_added` → `m.toName ? "agregó a {toName}" : "agregó un observador"`; idem `watcher_removed`/`fromName` |

## Notas
- Los watchers QUITADOS no se validan hoy (no están en `data`); para su nombre, UpdateTask resuelve
  la UNIÓN (prev ∪ data), no solo los nuevos.
- Sin migración (es `metadata` jsonb). FK lookups de otros dominios no se afectan (name opcional).
- Cross-repo: BE primero (deploy espera al reprocess 76/76), luego FE.
