# Tasks: Inventory Foundation (EPIC #38, Wave 1)

> Strict TDD: RED → GREEN → REFACTOR. Schema/migration must land before code that compiles against it.
> HIGH-CARE tasks touch the live #19 confirm/replace path — regression must stay green.

---

## Phase 1 — Schema + Migration

- [x] 1.1 Add `StockLocation` model to `prisma/schema.prisma` (`type` enum DEPOSITO|CLIENTE|TECNICO, nullable `contractId`, nullable `technicianId`, `code String?`, `@@unique([type,contractId])`, `@@unique([type,technicianId])`).
- [x] 1.2 Add `InventoryAsset` model (`serialNumber` unique, `mac?`, `deviceTypeId→DeviceTypeCatalog`, `status` enum available|installed|removed|damaged|retired, `currentLocationId→StockLocation`, `source` OCR|MANUAL|ICLASS, `sourceTaskId?→ScheduledTask`).
- [x] 1.3 Add `MaterialStock` model (`materialCatalogId→MaterialCatalog`, `locationId→StockLocation`, `qty Float`, `@@unique([materialCatalogId,locationId])`).
- [x] 1.4 Add `InventoryMovement` model (all fields per D2 port shape: type, assetId?, materialCatalogId?, qty?, from/toLocationId?, taskId?, technicianId?, source, occurredAt, note?).
- [x] 1.5 Add `assetId String?` + FK `@relation` to `InventoryAsset` on `ContractInstalledItem`.
- [x] 1.6 Add `/// @deprecated W1 — superseded by InventoryAsset/MaterialStock; no live writer` doc-comments to `InventoryItem`, `InventoryProduct`, `InventoryUnit` models (D5).
- [x] 1.7 Run `npx prisma migrate dev --name inventory_foundation` to generate `migration.sql` (schema DDL only; do NOT apply to real DB — generate file).
- [x] 1.8 Hand-augment `migration.sql` with idempotent data steps: (a) INSERT DEPOSITO (`WHERE NOT EXISTS code='DEPOSITO'`); (b) INSERT CLIENTE locations for each distinct `contractId` in CII with no CLIENTE (`WHERE NOT EXISTS`); (c) INSERT `InventoryAsset` per CII where `assetId IS NULL` (status=installed, currentLocationId=CLIENTE loc, serialNumber/mac/deviceTypeId from name→id/source/sourceTaskId preserved, OTROS fallback); (d) UPDATE `CII.assetId` for those rows; (e) INSERT INSTALL movement per migrated asset where no prior INSTALL exists (`WHERE NOT EXISTS`).
- [x] 1.9 Write `src/__tests__/infrastructure/migration-data-transform.test.ts`: assert idempotency logic (re-run produces 0 new inserts), DEPOSITO exists, 56 assets created with `status=installed`, 56 INSTALL movements seeded, `CII.assetId` populated — using an in-memory / SQLite-free harness (or document as a manual-check task if harness unavailable).

---

## Phase 2 — Domain Entities + Ports + Errors

- [x] 2.1 Create `src/domain/entities/stock-location.ts` — `StockLocation` entity; constructor validates type+FK combos; throws `InvalidLocationTypeError` / `MissingLocationFkError` on violations. Tests: scenarios SL-invalid-type, SL-cliente-without-contractId.
- [x] 2.2 Create `src/domain/entities/inventory-asset.ts` — `InventoryAsset` entity with `status` transitions map (valid: available→installed, installed→available, installed→removed, any→damaged|retired); `applyTransition()` throws `InvalidStatusTransitionError` on invalid. Tests: scenarios IA-valid-transition, IA-invalid-transition-available→removed, IA-retired-blocks-sn-reuse (serial uniqueness scope).
- [x] 2.3 Create `src/domain/entities/material-stock.ts` — `MaterialStock` entity; decrement guard (throws `InsufficientStockError` if result < 0). Tests: scenarios MS-decrement-within-balance, MS-decrement-below-zero-rejected, MS-qty-zero-valid.
- [x] 2.4 Create `src/domain/entities/inventory-movement.ts` — `InventoryMovement` entity (immutable shape); XOR guard (`assetId` XOR `materialCatalogId+qty`); `qty > 0` guard; `InconsistentMovementError` on violation. Test: scenario IML-immutability-shape.
- [x] 2.5 Add `InsufficientStockError`, `InconsistentMovementError`, `DuplicateSerialNumberError`, `UnknownDeviceTypeError`, `InvalidStatusTransitionError`, `MovementImmutableError`, `InvalidLocationTypeError`, `MissingLocationFkError`, `DuplicateMaterialStockError` to `src/domain/errors/inventory.ts`.
- [x] 2.6 Create `src/domain/ports/StockLocationRepository.ts` — `findByCode`, `findByTypeAndContract`, `findByTypeAndTechnician`, `create`.
- [x] 2.7 Create `src/domain/ports/InventoryAssetRepository.ts` — `findById`, `findBySerialNumber`, `create`, `updateLocation`, `updateStatus`.
- [x] 2.8 Create `src/domain/ports/MaterialStockRepository.ts` — `findByMaterialAndLocation`, `upsert`, `decrement`, `increment`.
- [x] 2.9 Create `src/domain/ports/InventoryMovementRepository.ts` — `record(input: RecordMovementInput): Promise<InventoryMovement>` (atomic: movement + balance; exact D2 port shape).

---

## Phase 3 — In-Memory Adapters + Use Cases (TDD Core)

- [x] 3.1 Create `src/infrastructure/adapters/in-memory/InMemoryStockLocationRepository.ts` implementing the port; findByCode/findByTypeAndContract/findByTypeAndTechnician/create.
- [x] 3.2 Create `src/infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository.ts`; enforces `serialNumber` uniqueness (`DuplicateSerialNumberError`).
- [x] 3.3 Create `src/infrastructure/adapters/in-memory/InMemoryMaterialStockRepository.ts`; enforces `(materialCatalogId, locationId)` uniqueness; `decrement` throws `InsufficientStockError` on negative.
- [x] 3.4 Create `src/infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository.ts`; `record()` validates XOR + qty > 0, then mutates asset/materialStock and appends movement in one synchronous block (all-or-nothing on guard failure).
- [x] 3.5 [RED] Write `src/__tests__/application/ResolveDepotLocation.test.ts` — scenarios: depot-already-exists (idempotent), depot-does-not-exist-yet.
- [x] 3.6 [GREEN] Create `src/application/use-cases/ResolveDepotLocation.ts` — find-or-create by `code='DEPOSITO'` using `StockLocationRepository`.
- [x] 3.7 [RED] Write `src/__tests__/application/ResolveClientLocation.test.ts` — scenarios: resolve-existing-client-location, cliente-location-unique-per-contract.
- [x] 3.8 [GREEN] Create `src/application/use-cases/ResolveClientLocation.ts` — find-or-create by `(type:'CLIENTE', contractId)`.
- [x] 3.9 [RED] Write `src/__tests__/application/RecordInventoryMovement.test.ts` — cover all 14 scenarios: INSTALL(depot→client), RETURN(client→depot), CONSUME(decrement-stock, insufficient-stock), TRANSFER(between-locations), ADJUST(correct-material-qty), XOR-guard (asset XOR material), qty-not-positive guard, balance-matches-net-of-movements, failed-consume-leaves-balance-unchanged, failed-install-leaves-asset-unchanged, material-balance-matches-net, ledger-row-immutability.
- [x] 3.10 [GREEN] Create `src/application/use-cases/RecordInventoryMovement.ts` — orchestrates: (1) validate XOR + qty>0 (`InconsistentMovementError`); (2) for CONSUME/ISSUE read current qty → throw `InsufficientStockError` if negative; (3) call `movementRepo.record()` (which wraps the atomic balance update); return movement. Use only domain ports.
- [x] 3.11 [REFACTOR] Ensure all in-memory `record()` mirrors atomicity: throw before mutating either collection on guard failure (no partial state).

---

## Phase 4 — Prisma Adapters

- [x] 4.1 Create `src/infrastructure/adapters/prisma/PrismaStockLocationRepository.ts` — implements `StockLocationRepository` port; `findByCode` queries `code` field; `findByTypeAndContract` queries `@@unique` index.
- [x] 4.2 Create `src/infrastructure/adapters/prisma/PrismaInventoryAssetRepository.ts` — `create` wraps unique-constraint error → `DuplicateSerialNumberError`; `updateLocation` + `updateStatus` use `prisma.inventoryAsset.update`.
- [x] 4.3 Create `src/infrastructure/adapters/prisma/PrismaMaterialStockRepository.ts` — `upsert` on `(materialCatalogId, locationId)`; `decrement`/`increment` use `prisma.materialStock.update({ qty: { increment } })`.
- [x] 4.4 Create `src/infrastructure/adapters/prisma/PrismaInventoryMovementRepository.ts` — `record()` runs `prisma.$transaction(async tx => { create movement; update asset OR upsert materialStock })`. Serialized branch: `tx.inventoryAsset.update({ currentLocationId, status })`. Consumable branch: `tx.materialStock.upsert({ qty: { decrement } })` — negative guard read happens BEFORE tx (use case layer).
- [x] 4.5 Write `src/__tests__/infrastructure/PrismaInventoryMovementRepository.test.ts` (typed parity test): verify the adapter's `record()` signature accepts all 6 movement types; guard that `$transaction` is used (spy on `prisma.$transaction`). No Prisma mock — use in-memory adapter parity assertions.

---

## Phase 5 — Dual-Write Integration (HIGH-CARE)

- [x] 5.1 Add `assetId: string | null` to `src/domain/entities/contract-installed-item.ts` entity.
- [x] 5.2 Extend `ContractInstalledItemRepository` port + `InMemoryContractInstalledItemRepository` to persist and return `assetId`.
- [x] 5.3 Extend `PrismaContractInstalledItemRepository` to include `assetId` in `SELECT` + `INSERT`/`UPDATE`.
- [x] 5.4 [RED] Extend `src/__tests__/application/ConfirmInventorySuggestion.test.ts` — add HIGH-CARE scenarios: confirm-DEVICE→asset+movement+CII-created (SIM-asset-created), CII-still-queryable-after-confirm (SIM-cii-queryable), confirm-MATERIAL→no-asset-no-movement (SIM-material-no-asset), confirm-MATERIAL-unchanged, TaskHasNoContractError-unchanged. Existing passing tests MUST remain green.
- [x] 5.5 [GREEN] Modify `src/application/use-cases/ConfirmInventorySuggestion.ts` — DEVICE/add branch: (1) `resolveClientLocation(contractId)`, (2) `assetRepo.create(...)`, (3) `ciiRepo.create({...assetId: asset.id})`, (4) `recordMovement(INSTALL, assetId, toLocationId, taskId, source)`. DEVICE/replace branch: additionally mark replaced asset `removed`. MATERIAL branch: unchanged. Inject `StockLocationRepository`, `InventoryAssetRepository`, `InventoryMovementRepository` as constructor params. HIGH-CARE: preserve all existing behavior.
- [x] 5.6 Modify `src/infrastructure/http/app.ts` — wire `PrismaStockLocationRepository`, `PrismaInventoryAssetRepository`, `PrismaMaterialStockRepository`, `PrismaInventoryMovementRepository` into `ConfirmInventorySuggestion` DI constructor.
- [x] 5.7 [RED→GREEN] Extend `src/__tests__/infrastructure/iclass-closure.routes.test.ts` (or equivalent confirm route test) to assert: after DEVICE confirm, `assetId` is non-null on the CII response; one INSTALL movement exists (query via in-memory repos). HIGH-CARE: all pre-existing supertest assertions must stay green.

---

## Phase 6 — Full Verify

- [x] 6.1 Run `npx jest --runInBand` — all tests green, zero regressions on #19 path.
- [x] 6.2 Run `npx tsc --noEmit` — zero type errors.
- [x] 6.3 Audit 41-scenario coverage: verify each spec scenario maps to at least one passing test (checklist against `specs/*/spec.md` scenarios).
- [x] 6.4 Confirm World A has no new code writers: `grep -r 'InventoryItem\|InventoryProduct\|InventoryUnit' src/application src/infrastructure/adapters/prisma` returns only the deprecated-comment reads (no creates/updates).
