# Tasks: Closure-Detected Equipment Returns to Depot (EPIC #38, Wave 4)

## Phase 1 — Schema + Migration (Foundation)

- [x] 1.1 `prisma/schema.prisma`: add `ReturnSuggestion` model (all fields per design), `inventoryReturnsProcessed Boolean @default(false)` on `IClassServiceOrder`, `isRemovalCode Boolean @default(false)` on `IClassResultCode`, `sourceRef String?` + partial `@@unique([sourceRef])` on `InventoryMovement`
- [x] 1.2 `prisma/migrations/20260612000000_iclass_returns/migration.sql`: hand-author idempotent SQL — `CREATE TABLE "ReturnSuggestion"` (+ indexes + `@@unique([serviceOrderId, serialNumber])`), `ALTER TABLE "IClassServiceOrder" ADD COLUMN "inventoryReturnsProcessed"`, `ALTER TABLE "IClassResultCode" ADD COLUMN "isRemovalCode"`, `ALTER TABLE "InventoryMovement" ADD COLUMN "sourceRef"` + `CREATE UNIQUE INDEX ... WHERE "sourceRef" IS NOT NULL`
- [x] 1.3 `prisma/seed.ts`: seed `isRemovalCode=true` for "Retiro completo Servicio Fibra" and "Retiro completo Servicio Wireless" via upsert on `IClassResultCode`
- [x] 1.4 Run `npx prisma generate` (no `migrate` against DB); verify `tsc --noEmit` passes

## Phase 2 — Domain + Ports

- [x] 2.1 `src/domain/entities/return-suggestion.ts`: `ReturnSuggestion` interface, `ReturnSuggestionStatus` union, `ReturnResolution` union, `createReturnSuggestion` factory, `normalizeSerial(s)` pure helper (trim/uppercase/strip non-alphanumeric)
- [x] 2.2 `src/domain/ports/ReturnSuggestionRepository.ts`: interface with `create`, `get`, `listPending`, `listByTask`, `setStatus`, `findBySourceRef`
- [x] 2.3 `src/domain/ports/InventoryAssetRepository.ts` (+ `PrismaInventoryAssetRepository` + `InMemoryInventoryAssetRepository`): add `findByNormalizedSerial(serial: string): Promise<InventoryAsset | null>` — installed-only match
- [x] 2.4 `src/domain/ports/InventoryMovementRepository.ts` (+ Prisma + in-memory adapters): accept optional `sourceRef` on movement input; Prisma adapter catches P2002 on sourceRef unique → idempotent return of existing movement
- [x] 2.5 `src/domain/ports/IClassResultCodeRepository.ts` (+ adapters): surface `isRemovalCode: boolean` on the resolved result-code row
- [x] 2.6 `src/domain/ports/ClosedServiceOrderRepository.ts` (+ `PrismaClosedServiceOrderRepository` + `InMemoryClosedServiceOrderRepository`): add `inventoryReturnsProcessed` to `ClosureSideEffect` union + side-effect state; add `markInventoryReturnsProcessed(soId)` method

## Phase 3 — Staging Side-Effect (TDD — no stock mutation)

- [x] 3.1 RED: `src/__tests__/application/StageReturnSuggestions.test.ts` — write failing tests for: (a) completed retiro + matched serial → `pending` suggestion, no movement; (b) completed retiro + unmatched serial → `needs_review`; (c) serial matches non-installed asset → `needs_review`; (d) non-completed retiro (Pendente) → zero suggestions, flag stays false; (e) re-stage with `inventoryReturnsProcessed=true` → zero suggestions; (f) partial crash recovery: unique `@@(serviceOrderId, serialNumber)` silently deduplicates
- [x] 3.2 GREEN: `src/application/use-cases/StageReturnSuggestions.ts` — reads `OcrExtraction` serials for task, calls `findByNormalizedSerial` (installed-only), creates `ReturnSuggestion` records via port, calls `markInventoryReturnsProcessed`; never touches stock
- [x] 3.3 RED → GREEN: `src/__tests__/infrastructure/IngestClosedServiceOrders.test.ts` additions — (a) completed-retiro SO triggers `processInventoryReturns` + sets flag; (b) re-closure with flag=true → no re-stage; (c) non-retiro SO → side-effect skipped; (d) unchanged SO with `inventoryReturnsProcessed=false` → re-attempted (REQ-IDEMP-1)
- [x] 3.4 `src/application/use-cases/IngestClosedServiceOrders.ts`: add `processInventoryReturns` block in `runClosureSideEffects` — gate on `soType===RETIROS` + `rc.isRemovalCode===true` + `!inventoryReturnsProcessed`; delegate to `StageReturnSuggestions`; add `inventoryReturnsProcessed` to the unchanged-SO re-eval list (mirrors `inventoryBuilt`)
- [x] 3.5 `src/infrastructure/adapters/in-memory/InMemoryReturnSuggestionRepository.ts`: implement all port methods in-memory (used by tests)
- [x] 3.6 `src/infrastructure/adapters/prisma/PrismaReturnSuggestionRepository.ts`: Prisma adapter implementing the port

## Phase 4 — ConfirmAssetReturn + Routes (TDD — mutation path)

- [x] 4.1 RED: `src/__tests__/application/ConfirmAssetReturn.test.ts` — write failing tests for: (a) matched `return` → 1 RETURN movement, asset `available`@depot, suggestion `confirmed`; (b) double-confirm → idempotent no-op (sourceRef unique); (c) `link` resolution → RETURN for chosen asset; (d) `create`-at-depot → new asset `available`@depot, no movement, suggestion `confirmed`; (e) `discard` → `discarded`, no movement; (f) atomic rollback on movement failure; (g) `inventory.write` permission required
- [x] 4.2 GREEN: `src/application/use-cases/ConfirmAssetReturn.ts` — handles `return`/`link`/`create`/`discard` resolutions; `return`+`link` run `RecordInventoryMovement(RETURN)` + `computeAssetEffect` inside `UnitOfWork` with `sourceRef = iclass:return:{serviceOrderId}:{normalizedSerial}`; `create` creates asset at DEPOSITO (OTROS fallback deviceType) without movement; all stamp suggestion status
- [x] 4.3 RED → GREEN: route tests added in `src/__tests__/infrastructure/inventory.routes.test.ts` (the W4 routes live on the GLOBAL `/api/inventory` router, not the task-scoped serviceInventory alias) — (a) `GET /returns/pending` returns list, requires `inventory.read`; (b) `POST /returns/:id/confirm` fires RETURN, 200, asset in GetDepotStock; (c) second `POST /returns/:id/confirm` → 409; (d) `POST /returns/:id/discard` → suggestion `discarded`; + 403/400/404 guards
- [x] 4.4 `src/infrastructure/http/routes/inventory.routes.ts`: add `GET /returns/pending` (`inventory.read`), `POST /returns/:id/confirm` (`inventory.write`), `POST /returns/:id/discard` (`inventory.write`)
- [x] 4.5 `src/infrastructure/http/app.ts`: wire `PrismaReturnSuggestionRepository`, `ListPendingReturns`, `ConfirmAssetReturn`; `StageReturnSuggestions` + `featureFlags` wired in `closureSideEffects.ts`; feature-flag `iclass-inventory-returns` (default OFF) guards the side-effect at runtime via `IngestClosedServiceOrders`

## Phase 5 — Frontend (Batch B)

- [x] 5.1 api fns — implemented in dedicated `src/api/returns.api.ts` (`getPendingReturns`, `confirmReturn(id, {resolution, linkedAssetId})`, `discardReturn(id)`) instead of bolting onto `serviceInventory.api.ts`; matches the W4 BE contract `/inventory/returns/*`. Types in `src/types/returns.ts`. (5 api tests)
- [x] 5.2 hooks — `src/hooks/useReturns.ts` exports `usePendingReturns` (mirrors `useDepotStock`), `useConfirmReturn`, `useDiscardReturn`; both mutations invalidate `PENDING_RETURNS_QUERY_KEY` on success. Tests mock `@/api/returns.api` inline (project convention — no `__mocks__` dir for hooks). (3 hook tests)
- [x] 5.3 RED — `src/__tests__/pages/inventory/InventoryReturnsPendingPage.test.tsx`: pending + needs_review rows, confirm/discard fire hooks, empty/loading/error, permission gating. (Row logic lives inline in the page, not a separate `components/returns/` card — single cohesive page mirroring the `InventoryDepotPage` sibling, avoids nested-card anti-pattern.)
- [x] 5.4 GREEN — page renders matched `pending` rows (blue "Match encontrado" pill + "Confirmar devolución" → resolution 'return') and `needs_review` rows (amber "Sin match — revisar" pill + "Crear en depósito"/'create', "Vincular a equipo"/'link', "Descartar"/discard). impeccable applied: restrained product register, reuses the depot page's token vocabulary, primary empty state. (9 page tests)
- [x] 5.5 `src/pages/inventory/InventoryReturnsPendingPage.tsx` (+ `.module.css`): global "Devoluciones pendientes" page at `/admin/inventory/returns` (lazy, `inventory.read`). Registered in `App.tsx`; nav entry added as a "Devoluciones" sidebar child under Inventario (the Depot page itself has no sidebar link, so the sidebar is the discoverable entry point).

## Phase 6 — Verify

- [x] 6.1 BE: `npx jest --runInBand` — 2777 passed, 0 failed, 86 skipped (350/356 suites). All W4 spec scenarios covered (StageReturnSuggestions 7, closure integration 5, ConfirmAssetReturn 8, routes 8, entity 6).
- [x] 6.2 BE: `npx tsc --noEmit` — clean (exit 0). `npx prisma validate` 🚀, `npx prisma generate` OK (no DB).
- [ ] 6.3 FE: `npx vitest run` — all new component/hook tests pass
- [ ] 6.4 FE: `npm run typecheck` — clean
- [ ] 6.5 Manual smoke: seed dev DB, trigger a test RETIRO closure via the closure loop, confirm a suggestion via the FE page, verify asset appears in `GetDepotStock`
