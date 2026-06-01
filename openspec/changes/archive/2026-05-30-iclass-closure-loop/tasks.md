# Tasks: IClass Closure Loop

> Archivado 2026-05-30. Todas completas, shipeadas a prod. Strict TDD (adapters in-memory).

## Fase 1 — Schema & migración (aditiva)
- [x] 6 tablas + back-relations (ScheduledTask, Stage) + seed idempotente del flag `iclass-closure-loop` (OFF). Migración `20260529210000_iclass_closure_loop` generada por `migrate diff`.

## Fase 2 — Dominio
- [x] Entidades `ClosedServiceOrder` (+Summary +5 hijos), `IClassResultCode`. Ports `ClosedServiceOrderRepository`, `IClassResultCodeRepository`. `IClassPort` +6 read methods. `SchedulingRepository.findTaskBySequenceNumber` + `listTasksInIClassStage`. Error `IClassResultCodeNotFoundError`.

## Fase 3 — Catálogo result-codes (TDD)
- [x] InMemory + Prisma `IClassResultCodeRepository`; use-cases `SyncIClassResultCodes` (preserva mapping), `ListIClassResultCodes`, `AssignResultCodeStage` (valida Stage/result-code → 404).

## Fase 4 — IClassClient read + parsers (TDD, fixtures reales)
- [x] `listServiceOrders`, `getServiceOrderHistory/Checklists/Materials/EquipmentEvents`, `listResultCodes` + `fetchAllPages` (paginación, 204→[], rate-limit retry). 7 parsers puros. Fake InMemoryIClassClient.

## Fase 5 — IngestClosedServiceOrders (TDD)
- [x] Filtra status 7, matchea por codigo↔seq, idempotencia, fan-out, deriva closedAt, resuelve mapping, espeja + mueve task. `processSummary` público.

## Fase 6 — Backfill (TDD)
- [x] `BackfillClosedServiceOrders` reusa processSummary; itera tareas en "Registrado en IClass" por serviceOrderCode.

## Fase 7 — Prisma adapters + rutas + status
- [x] `PrismaClosedServiceOrderRepository` (upsert transaccional, BigInt↔string). Router `iclass-closure.routes` (sync/list/assign + status + backfill). `GetClosureStatus`.

## Fase 8 — Scheduler + bootstrap + wiring
- [x] `IClassClosureScheduler` (flag-gated, lock) + `bootstrapIClassClosure` + main.ts + app.ts.

## Fase 9 — Frontend
- [x] Subpages "Cierre de OS" (toggle flag + botón "Reconciliar ahora") y "Mapeo de resultados" (select stage por workflow, auto-save, sync). Hooks + api + Vitest.

## Fase 10 — Quality gates + deploy
- [x] tsc 0, suite verde. Deployado BE+FE a prod (varios commits). Bugfix post-deploy: sync de result-codes vía `tipoOs.id` (`9aa4be67`).
