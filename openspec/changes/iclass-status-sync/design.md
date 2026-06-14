# Design: iclass-status-sync — catálogo configurable de estados de IClass

## Technical Approach

Clon del patrón `IClassResultCode` (entidad + port + Prisma/InMemory + use-cases Sync/List/Update + router admin `/api/admin/iclass` + DTO + wiring), con tres campos editables (`displayLabel`, `color`, `tracked`) en lugar del mapeo a Stage. La captura del estado se inserta en el use-case `IngestClosedServiceOrders.processSummary` que el scheduler ya corre: el `IClassPort.listServiceOrders()` **ya devuelve `statusCode`+`statusDescription` de toda OS** (verificado: `parseServiceOrderSummary` mapea `status.id`/`status.descricao` incondicionalmente, `IClassClient.ts:502-503`), así que NO se agrega ningún método al port ni llamada nueva a IClass. El estado en la tarea guarda SOLO el `statusCode`; el read-path resuelve label/color por JOIN al catálogo (igual que `mappedStageName`).

## Architecture Decisions

| Decisión | Alternativas | Elección + rationale |
|----------|--------------|----------------------|
| Cómo traer los estados | Nuevo `getServiceOrder(id)` on-demand; nuevo método de listado en el port | **Reusar `listServiceOrders()` que el scheduler ya invoca** — el summary ya trae `statusCode`/`statusDescription` de TODAS las OS del rango (no solo terminales). Cero llamadas nuevas, cero riesgo de 429 adicional. El filtro `'7'` está en el use-case, no en el adapter |
| Punto de captura | Use-case nuevo paralelo que re-liste OS | **Insertar en `processSummary` ANTES del guard `statusCode !== TERMINAL_STATUS`** — la tarea ya se resuelve por `sequenceNumber` para el terminal; se sube ese lookup y se captura el status para CUALQUIER estado. El guard se mantiene para no romper mirror/cierre/side-effects |
| Auto-discovery de códigos opacos | Tabla seed con IDs conocidos; relevar manualmente | **Auto-upsert por `statusCode` en cada captura** (`tracked=false` default): el catálogo se auto-puebla con los `statusCode`+`iclassLabel` REALES observados. Resuelve la opacidad sin documentación previa de IClass |
| Estado en la tarea | Desnormalizar `iclassStatusLabel`+`color` en la tarea | **Guardar solo `iclassStatusCode`** (+ `iclassStatusUpdatedAt`); resolver label/color por JOIN al catálogo al leer. Editar el catálogo NO requiere reescribir las tareas. Parity con `IClassResultCode.mappedStageName` (derivado por JOIN) |
| Sync manual | Endpoint dedicado de IClass `/statuses` (no existe) | **`POST /api/admin/iclass/statuses/sync` reusa `listServiceOrders` sobre la ventana reciente** (≈28 días, bajo el cap de 30) y auto-upserta cada `statusCode` distinto visto. Mismo enfoque de discovery que `listResultCodes` (que infiere soTypeIds de las OS recientes) |
| Config editable | Mapeo a Stage como result-code | **3 campos: `displayLabel` (null→usa `iclassLabel`), `color` (hex opcional), `tracked` (bool, opt-in)** — esto es lo que el usuario pidió: elegir qué estados resaltar y cómo etiquetarlos |
| Write condicional en cada tick | Escribir siempre | **`setIClassStatus` solo persiste si `iclassStatusCode` cambió** (idempotente) — evita writes inútiles cada 10 min; `iclassStatusUpdatedAt` se mueve solo en transición real |
| Ruta del catálogo | Router nuevo | **Extender el router admin `iclass` montado en `/api/admin/iclass`** (auth + `requirePerm('iclass','manage')` ya ahí) — cero mount nuevo, mismo gate que result-codes |
| Permiso de lectura del catálogo | Solo `iclass.manage` | **`iclass.read` para GET/list, `iclass.manage` para sync+update** — dos niveles, ambos ya existen. El badge en la tarea va con `iclass.read` |
| Error not-found | Reusar uno existente | **`IClassStatusNotFoundError` → `ICLASS_STATUS_NOT_FOUND: 404`** en `errorHandler.ts` (parity con `IClassResultCodeNotFoundError`) |

## Data Flow

```
[Scheduler tick cada 10min] IClassClosureScheduler.runOnce
  → IngestClosedServiceOrders.execute → iclass.listServiceOrders(ventana)  // YA corre hoy
    → para cada summary s (CUALQUIER statusCode):
        processSummary(s):
          task = findTaskBySequenceNumber(Number(s.iclassCodigo))   // lookup subido
          if (task):                                                 // NUEVO bloque, pre-guard
            statusCatalog.upsertByStatusCode(s.statusCode, s.statusDescription)  // auto-discovery, tracked=false
            if (task.iclassStatusCode !== s.statusCode):
              scheduling.setIClassStatus(task.id, s.statusCode, now)  // write condicional
          if (s.statusCode !== '7') { skippedNotClosed++; return }   // guard terminal SIN CAMBIO
          ... mirror + transición + side-effects (igual que hoy) ...

[Sync manual] POST /api/admin/iclass/statuses/sync  (iclass.manage)
  → SyncIClassStatuses → iclass.listServiceOrders(últimos ~28d)
  → statusCatalog.upsertByStatusCode(code, descricao) ×N distintos → 200 { synced, created, updated }

[Config] PATCH /api/admin/iclass/statuses/:statusCode  (iclass.manage)
  → UpdateIClassStatusCatalog → statusCatalog.update(code, {displayLabel?, color?, tracked?})
  → 200 entry | 404 ICLASS_STATUS_NOT_FOUND

[Read] GET /api/admin/iclass/statuses  (iclass.read)  → ListIClassStatusCatalog → { items }
[Read task] GET /api/scheduling/tasks(/:id)  → task DTO con iclassStatus resuelto por JOIN al catálogo
```

## Schema / Migración

`prisma/migrations/20260724000000_iclass_status_catalog/migration.sql` — aditiva, sin BEGIN/COMMIT (Prisma envuelve cada migración), generada con `prisma migrate diff`:

```sql
-- CreateTable: catálogo de estados de IClass (auto-discovery + config editable).
CREATE TABLE "IClassStatusCatalog" (
    "id" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,        -- id opaco de IClass (status.id), clave de upsert
    "iclassLabel" TEXT NOT NULL,       -- descricao crudo del último visto
    "displayLabel" TEXT,               -- etiqueta Prominense editable; NULL = usa iclassLabel
    "color" TEXT,                      -- hex opcional para el badge
    "tracked" BOOLEAN NOT NULL DEFAULT false,  -- opt-in del operador al seguimiento/visibilidad
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IClassStatusCatalog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IClassStatusCatalog_statusCode_key" ON "IClassStatusCatalog"("statusCode");
CREATE INDEX "IClassStatusCatalog_tracked_idx" ON "IClassStatusCatalog"("tracked");

-- AlterTable: estado actual de la OS en la tarea (solo el code; label/color por JOIN al catálogo).
ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "iclassStatusCode" TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "iclassStatusUpdatedAt" TIMESTAMP(3);
```

No hay seed: el catálogo se auto-puebla por discovery (los códigos son opacos, no se conocen a priori). No hay FK desde `ScheduledTask` al catálogo (el join es por `statusCode` string en el read-path; mantiene el upsert del catálogo independiente del orden de captura).

## File Changes — BE

| File | Action | Qué |
|------|--------|-----|
| `src/domain/entities/iclass-status-catalog.ts` | Create | Entidad `IClassStatusCatalogEntry { id, statusCode, iclassLabel, displayLabel, color, tracked, lastSyncedAt, createdAt, updatedAt }` |
| `src/domain/ports/IClassStatusCatalogRepository.ts` | Create | `list()`, `getByStatusCode(code)`, `upsertByStatusCode({statusCode, iclassLabel})→{status}` (preserva displayLabel/color/tracked), `update(code, {displayLabel?, color?, tracked?})→entry\|null`, `findManyByStatusCodes(codes[])` (resolución batch para el read-path de tareas) |
| `src/domain/errors/iclass.ts` | Modify | `IClassStatusNotFoundError(statusCode)` |
| `src/infrastructure/http/middleware/errorHandler.ts` | Modify | mapear `ICLASS_STATUS_NOT_FOUND → 404` |
| `src/application/use-cases/SyncIClassStatuses.ts` | Create | `listServiceOrders(últimos ~28d)` → set de `statusCode`+`descricao` distintos → upsert ×N → `{ synced, created, updated }` |
| `src/application/use-cases/ListIClassStatusCatalog.ts` | Create | wrapper `repo.list()` |
| `src/application/use-cases/UpdateIClassStatusCatalog.ts` | Create | `repo.update(code, patch)`; null → `IClassStatusNotFoundError` |
| `src/application/use-cases/IngestClosedServiceOrders.ts` | Modify | inyectar `statusCatalog?` opcional + sub ir el lookup de tarea ANTES del guard terminal; capturar status (upsert catálogo + setIClassStatus condicional). Opcional para no romper los tests existentes que no lo pasan |
| `src/domain/ports/SchedulingRepository.ts` | Modify | `setIClassStatus(taskId, statusCode, at): Promise<void>` |
| `src/domain/entities/scheduling.ts` | Modify | `iclassStatusCode: string \| null` + `iclassStatus: { code, label, color, tracked } \| null` (resuelto) en la entidad de lectura |
| `src/infrastructure/adapters/prisma/PrismaIClassStatusCatalogRepository.ts` | Create | upsert por `statusCode` (findFirst-then-write, preserva config), update, findMany |
| `src/infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository.ts` | Create | parity |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modify | `setIClassStatus`; resolver `iclassStatus` en el mapeo de lectura (JOIN/lookup al catálogo por `iclassStatusCode`) |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | Modify | parity de `setIClassStatus` + resolución |
| `src/application/dto/scheduling.dto.ts` | Modify | exponer `iclassStatus` en el task DTO |
| `src/application/dto/iclassStatus.dto.ts` | Create | `toStatusCatalogDTO(entry)` → `{ statusCode, iclassLabel, displayLabel, effectiveLabel, color, tracked, lastSyncedAt: ISO }` + zod `UpdateStatusSchema` |
| `src/infrastructure/http/routes/iclass-closure.routes.ts` (o router admin iclass) | Modify | `POST /statuses/sync` + `PATCH /statuses/:statusCode` (gate `iclass.manage`), `GET /statuses` (gate `iclass.read`); firma +3 use cases + `requireIClassRead` |
| `src/infrastructure/http/app.ts` | Modify | wiring: `iclassStatusCatalogRepo`, `syncIClassStatuses`, `listIClassStatusCatalog`, `updateIClassStatusCatalog`; inyectar `statusCatalog` en `IngestClosedServiceOrders`; pasar `requirePerm('iclass','read')` al router |

**Wiring exacto app.ts**: junto al bloque de result-codes (~L1578-1593, donde se construye `createIClassClosureRouter`): declarar `const iclassStatusCatalogRepo = new PrismaIClassStatusCatalogRepository();` antes del montaje. Construir `new SyncIClassStatuses(buildIClassClient(), iclassStatusCatalogRepo)`, `new ListIClassStatusCatalog(iclassStatusCatalogRepo)`, `new UpdateIClassStatusCatalog(iclassStatusCatalogRepo)` y pasarlos al router (firma extendida, params nuevos al final, opcionales si hace falta). En la construcción de `IngestClosedServiceOrders` (buscar dónde se instancia para el scheduler/backfill): pasar `statusCatalog: iclassStatusCatalogRepo` en `IngestClosedOptions`. El `schedulingRepo` ya inyectado gana el método `setIClassStatus`.

## File Changes — FE

| File | Action | Qué |
|------|--------|-----|
| `src/types/iclassStatus.ts` | Create | wire type `IClassStatusCatalogItem { statusCode, iclassLabel, displayLabel, effectiveLabel, color, tracked, lastSyncedAt }` |
| `src/api/iclassStatuses.api.ts` | Create | `BASE='/admin/iclass/statuses'`: `getIClassStatuses()`, `syncIClassStatuses()`, `updateIClassStatus(code, patch)` |
| `src/hooks/useIClassStatuses.ts` | Create | `useIClassStatuses()` (queryKey `['iclass-statuses']`), `useSyncIClassStatuses()` + `useUpdateIClassStatus()` (invalidan `['iclass-statuses']` y `['scheduling']`/`['tasks']`) |
| FE config page (sub-tab "Estados de IClass", espejo de la página de result-codes mapping) | Create | tabla: statusCode, iclassLabel (read-only), input displayLabel, color picker, toggle tracked, botón "Sincronizar desde IClass" con counts |
| FE task badge (detalle + card de listado) | Modify | badge con `iclassStatus.label` y `iclassStatus.color`, renderizado SOLO si `iclassStatus?.tracked` |
| `src/types/scheduling.ts` (o el type de Task del FE) | Modify | agregar `iclassStatus?: { code, label, color, tracked } \| null` |

Gates FE: sub-tab bajo `Can permission="iclass.manage"`; badge bajo `iclass.read` (o sin gate explícito si la tarea ya está bajo `scheduling.read` — verificar en apply contra la pantalla de result-codes existente).

## Testing Strategy (STRICT TDD — red→green→refactor)

| Capa | Test | Aproximación |
|------|------|--------------|
| BE unit | `InMemoryIClassStatusCatalogRepository.test.ts` | contrato del port: upsert preserva config (displayLabel/color/tracked), update parcial, findManyByStatusCodes |
| BE unit | `SyncIClassStatuses.test.ts` | InMemory client+repo: distintos statusCodes → created/updated; mismo code dos veces → 1 created; descricao actualiza iclassLabel pero preserva displayLabel; IClass caído → error |
| BE unit | `UpdateIClassStatusCatalog.test.ts` | patch parcial (solo tracked, solo displayLabel/color), code inexistente → `IClassStatusNotFoundError` |
| BE unit | `IngestClosedServiceOrders.statusCapture.test.ts` | InMemory: OS no-terminal con tarea → catálogo auto-poblado (tracked=false) + tarea con iclassStatusCode; OS sin tarea → no escribe; statusCode sin cambio → no re-escribe (idempotente); guard '7' sigue cortando mirror; sin statusCatalog inyectado → comportamiento legacy intacto |
| BE unit | `InMemorySchedulingRepository.iclassStatus.test.ts` | `setIClassStatus` escribe code+at; el read resuelve `iclassStatus` por catálogo (label cae a iclassLabel si displayLabel null; null si no hay code) |
| BE routes | `iclassStatuses.routes.test.ts` (supertest, in-memory) | GET 200 shape ISO (gate iclass.read, 403 sin permiso); POST sync 200 counts (gate manage); PATCH happy/404; 400 zod inválido; 502 IClass caído |
| BE routes | `scheduling.routes` (extender) | el task DTO incluye `iclassStatus` resuelto (tracked y no-tracked) |
| BE composición | `app-composition.iclassStatuses.test.ts` (patrón existente) | app monta `/api/admin/iclass/statuses` con wiring real + `IngestClosedServiceOrders` recibe el statusCatalog |
| FE | `IClassStatusMappingBody.test.tsx` (vitest) | tabla con catálogo, edit displayLabel/color → PATCH, toggle tracked → PATCH, sync → POST + feedback |
| FE | task badge test (vitest) | badge visible solo si tracked; usa displayLabel y color; oculto si !tracked o iclassStatus null |

## Migration / Rollout

Deploy **BE primero** (migración aditiva + endpoints + captura en el scheduler; los campos nuevos son nullable, el FE viejo no rompe), después FE. Post-deploy: el scheduler auto-puebla el catálogo en los primeros ticks; el operador entra a la sub-tab, edita labels/colores y togglea `tracked` en los estados que quiere seguir. Rollback: revert FE + BE; tabla y columnas pueden quedar (aditivas, nullable).

## Open Questions

- [ ] ¿El sync manual debe bypassear la ventana de 28d y aceptar un rango configurable? Default: ventana fija ~28d (bajo el cap de 30), igual que `listResultCodes`. No bloqueante.
- [ ] ¿`color` valida formato hex en el BE o solo en el FE? Default: zod `#RRGGBB` opcional en el BE (parity defensiva). No bloqueante.
- [ ] Ninguna bloqueante.
