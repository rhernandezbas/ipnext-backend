# Design: IClass Closure Loop

> Archivado 2026-05-30. Refleja la implementación shipeada a prod.

## Key architecture decisions

- **AD-1 — Polling, no webhooks.** IClass v2 no expone hooks (verificado). Scheduler in-process `IClassClosureScheduler` re-lee el flag `iclass-closure-loop` cada tick (toggle sin redeploy). Lock advisory `iclass-closed` (distinto de `gr-sync`/`gr-ingest`).
- **AD-2 — Join `codigo ↔ sequenceNumber`.** Enviamos `soCode = sequenceNumber`; IClass lo preserva como `codigo`. Solo se procesan OS con codigo numérico que matchea una tarea local; las de codigo==id (creadas en IClass) se skipean (`skippedNotOurs`).
- **AD-3 — Mapping configurable (no hardcode).** `IClassResultCode.mappedStageId → Stage` (FK, onDelete SetNull), asignable por API/UX. Espeja `Project.iclassSoTypeId`. Sin mapeo → la tarea NO se mueve (queda como está). Elegido porque los tipos de resultado son Sucesso/Pendente/Improdutiva/etc. — no un binario.
- **AD-4 — Idempotencia por `iclassUpdatedAt`** (`alteradoPor.data`). Si ya se espejó con el mismo timestamp, se skipea antes de traer sub-recursos.
- **AD-5 — Ids IClass como `string`** en dominio (pesquisaId supera 2^53); el adapter Prisma convierte a BigInt.
- **AD-6 — closedAt derivado del history** (status 7); firstClosedAt (4) y approvedAt (50) idem. La OS no trae closeDate top-level.
- **AD-7 — Result-code catalog sync vía `tipoOs.id`.** Los endpoints de tipos no exponen id numérico ni motivosFechamento poblado; el id solo está en `tipoOs.id` del listado de OS. El sync descubre soType ids de OS recientes (ventana 28 días) y trae `/serviceordertypes/{id}/resultcodes`.
- **AD-8 — Backfill reusa el motor.** `BackfillClosedServiceOrders` itera tareas en "Registrado en IClass", consulta por `serviceOrderCode` exacto y reusa `IngestClosedServiceOrders.processSummary`. Steady-state bootstrapea ventana de 25 días en el primer run.

## Persistence

6 tablas aditivas: `IClassServiceOrder` (+ `rawDetail` JSON), `IClassResultCode` (catálogo + mappedStageId), `IClassSoStatusHistory`, `IClassSoChecklist` + `IClassSoChecklistAnswer` (con `photoMissing`), `IClassSoMaterial`, `IClassSoEquipmentEvent`. `ScheduledTask` gana back-relation `iclassClosedOrder`; `Stage` gana back-relation a result-codes. Estado del run en `SyncState` key `iclass-closed`. Flag seed idempotente OFF.

## Gotcha documentado

Fotos/firmas NO expuestas por la API v2 (probado: `/photos`, `/anexos` → 500). Se registra la pregunta del checklist con `photoMissing: true`; la imagen vive solo en el portal IClass. NO hay scraping de HTML.

## Test strategy

Parsers puros testeados contra payloads REALES capturados en vivo. Use-cases con adapters in-memory (NO Prisma mocks). Scheduler con InMemoryDistributedLock + InMemoryFeatureFlagRepository. Rutas con supertest + errorHandler real. FE con Vitest (hooks mockeados).
