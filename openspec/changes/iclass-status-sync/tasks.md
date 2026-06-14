# Tasks: iclass-status-sync — catálogo configurable de estados de IClass

Orden TDD estricto (red → green → refactor). NO mockear Prisma: usar los repos in-memory.

## Phase 1: DB + Domain Foundation

- [ ] 1.1 [RED] `src/__tests__/domain/iclass-status-catalog.test.ts` — invariantes de la entidad `IClassStatusCatalogEntry` (effectiveLabel = displayLabel ?? iclassLabel si lo modelás como helper)
- [ ] 1.2 [GREEN] `src/domain/entities/iclass-status-catalog.ts` — entidad `IClassStatusCatalogEntry { id, statusCode, iclassLabel, displayLabel, color, tracked, lastSyncedAt, createdAt, updatedAt }`
- [ ] 1.3 [GREEN] `src/domain/ports/IClassStatusCatalogRepository.ts` — `list()`, `getByStatusCode`, `upsertByStatusCode({statusCode, iclassLabel})→{status}`, `update(code, {displayLabel?, color?, tracked?})→entry|null`, `findManyByStatusCodes(codes[])`
- [ ] 1.4 [GREEN] `src/domain/ports/SchedulingRepository.ts` — agregar `setIClassStatus(taskId, statusCode, at): Promise<void>`
- [ ] 1.5 [GREEN] `src/domain/entities/scheduling.ts` — agregar `iclassStatusCode: string | null` + `iclassStatus: { code, label, color, tracked } | null` (resuelto en lectura)
- [ ] 1.6 [GREEN] `src/domain/errors/iclass.ts` — `IClassStatusNotFoundError(statusCode)`
- [ ] 1.7 [GREEN] `src/infrastructure/http/middleware/errorHandler.ts` — mapear `ICLASS_STATUS_NOT_FOUND → 404`
- [ ] 1.8 [GREEN] `prisma/schema.prisma` — modelo `IClassStatusCatalog` (statusCode unique, tracked index) + 2 columnas en `ScheduledTask` (`iclassStatusCode`, `iclassStatusUpdatedAt`)
- [ ] 1.9 [GREEN] crear migración `prisma/migrations/20260724000000_iclass_status_catalog/migration.sql` (CREATE TABLE + ALTER TABLE ADD COLUMN IF NOT EXISTS; sin BEGIN/COMMIT; unique statusCode + index tracked)

## Phase 2: Adapters (parity in-memory + Prisma)

- [ ] 2.1 [RED] `src/__tests__/infrastructure/InMemoryIClassStatusCatalogRepository.test.ts` — upsert preserva displayLabel/color/tracked; update parcial; findManyByStatusCodes omite ausentes
- [ ] 2.2 [GREEN] `src/infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository.ts` — implementación del port
- [ ] 2.3 [GREEN] `src/infrastructure/adapters/prisma/PrismaIClassStatusCatalogRepository.ts` — upsert por statusCode (findFirst-then-write, preserva config), update, findMany
- [ ] 2.4 [RED] `src/__tests__/infrastructure/InMemorySchedulingRepository.iclassStatus.test.ts` — `setIClassStatus` escribe code+at; el read resuelve `iclassStatus` por catálogo (label, color, tracked; null sin code)
- [ ] 2.5 [GREEN] `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` — `setIClassStatus` + resolución de `iclassStatus`
- [ ] 2.6 [GREEN] `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` — `setIClassStatus` + resolución batch de `iclassStatus` (JOIN/lookup al catálogo por `iclassStatusCode`, sin N+1 en el listado)

## Phase 3: Use Cases (TDD estricto)

- [ ] 3.1 [RED] `src/__tests__/application/SyncIClassStatuses.test.ts` — distintos statusCodes → created/updated; code repetido → 1 created; descricao refresca iclassLabel pero preserva config; statusCode vacío descartado; IClass caído → error
- [ ] 3.2 [GREEN] `src/application/use-cases/SyncIClassStatuses.ts` — `listServiceOrders(~28d)` → set distinto de {statusCode, descricao} → upsert ×N → `{ synced, created, updated }`
- [ ] 3.3 [RED] `src/__tests__/application/UpdateIClassStatusCatalog.test.ts` — patch parcial (solo tracked / solo label+color); code inexistente → `IClassStatusNotFoundError`
- [ ] 3.4 [GREEN] `src/application/use-cases/UpdateIClassStatusCatalog.ts` — `repo.update(code, patch)`; null → error
- [ ] 3.5 [GREEN] `src/application/use-cases/ListIClassStatusCatalog.ts` — wrapper `repo.list()`
- [ ] 3.6 [RED] `src/__tests__/application/IngestClosedServiceOrders.statusCapture.test.ts` — OS no-terminal con tarea → catálogo auto-poblado (tracked=false) + tarea con iclassStatusCode; OS sin tarea → no escribe; sin cambio → idempotente; transición → avanza; guard '7' sigue cortando mirror; SIN statusCatalog inyectado → legacy intacto
- [ ] 3.7 [GREEN] `src/application/use-cases/IngestClosedServiceOrders.ts` — inyectar `statusCatalog?` en `IngestClosedOptions`; subir el lookup de tarea ANTES del guard terminal; capturar (upsert catálogo + setIClassStatus condicional); preservar el guard `'7'`

## Phase 4: Routes + DTO + Wiring

- [ ] 4.1 [GREEN] `src/application/dto/iclassStatus.dto.ts` — `toStatusCatalogDTO(entry)` (con `effectiveLabel`) + zod `UpdateStatusSchema` (`displayLabel?` string|null, `color?` hex|null, `tracked?` bool)
- [ ] 4.2 [GREEN] `src/application/dto/scheduling.dto.ts` — exponer `iclassStatus` en el task DTO
- [ ] 4.3 [RED] `src/__tests__/infrastructure/iclassStatuses.routes.test.ts` (supertest, in-memory) — GET 200 shape ISO + 403 sin `iclass.read`; POST sync 200 counts (gate manage) + 502 IClass caído; PATCH happy + 404 + 400 zod
- [ ] 4.4 [GREEN] router admin iclass (`iclass-closure.routes.ts` o el admin router) — `GET /statuses` (gate `iclass.read`), `POST /statuses/sync` + `PATCH /statuses/:statusCode` (gate `iclass.manage`); firma +3 use cases + `requireIClassRead`
- [ ] 4.5 [RED] extender `src/__tests__/infrastructure/scheduling.routes.test.ts` — el task DTO incluye `iclassStatus` resuelto (tracked y no-tracked, null sin code)
- [ ] 4.6 [GREEN] task routes / mapeo de DTO — incluir `iclassStatus` resuelto en detalle y listado
- [ ] 4.7 [RED] `src/__tests__/infrastructure/app-composition.iclassStatuses.test.ts` (patrón composition-root) — app monta `/api/admin/iclass/statuses` con wiring real AND `IngestClosedServiceOrders` recibe el statusCatalog
- [ ] 4.8 [GREEN] `src/infrastructure/http/app.ts` — wiring: `iclassStatusCatalogRepo`, `syncIClassStatuses`, `listIClassStatusCatalog`, `updateIClassStatusCatalog`; pasar al router con `requirePerm('iclass','read')`; inyectar `statusCatalog` en `IngestClosedServiceOrders`

## Phase 5: Frontend (wire contract frozen)

- [ ] 5.1 `src/types/iclassStatus.ts` — wire type `IClassStatusCatalogItem { statusCode, iclassLabel, displayLabel, effectiveLabel, color, tracked, lastSyncedAt }`
- [ ] 5.2 `src/types/scheduling.ts` (Task type FE) — agregar `iclassStatus?: { code, label, color, tracked } | null`
- [ ] 5.3 `src/api/iclassStatuses.api.ts` — `BASE='/admin/iclass/statuses'`: `getIClassStatuses()`, `syncIClassStatuses()`, `updateIClassStatus(code, patch)`
- [ ] 5.4 `src/hooks/useIClassStatuses.ts` — `useIClassStatuses()` (queryKey `['iclass-statuses']`), `useSyncIClassStatuses()`, `useUpdateIClassStatus()` (invalidan `['iclass-statuses']` + `['scheduling']`/`['tasks']`)
- [ ] 5.5 [RED] `src/__tests__/components/IClassStatusMappingBody.test.tsx` (vitest) — tabla con catálogo, edit displayLabel/color → PATCH, toggle tracked → PATCH, sync → POST + feedback counts
- [ ] 5.6 [GREEN] sub-tab de config "Estados de IClass" (espejo de la página de result-codes mapping) — tabla con statusCode + iclassLabel (read-only), input displayLabel, color picker, toggle tracked, botón "Sincronizar desde IClass"; bajo `Can permission="iclass.manage"`
- [ ] 5.7 [RED] test del badge (vitest) — badge visible solo si `iclassStatus?.tracked`; usa label+color; oculto si !tracked o null
- [ ] 5.8 [GREEN] badge del estado de IClass en el detalle de tarea + card del listado — render condicional a `iclassStatus?.tracked`, con label y color del DTO
