# Proposal: Closure-Detected Equipment Returns to Depot (EPIC #38, Wave 4)

> **PREMISE PIVOT (confirmed by human).** IClass returns HTTP 204 on every equipment/material
> endpoint for IPNEXT — the `IClassSoEquipmentEvent` source is empty BY SOURCE, not a bug.
> W4 is re-scoped: the trigger is a **closure-detected RETIRO** (completed-removal result code) +
> **OCR serials** from checklist photos, NOT consuming IClass equipment events.
> **HIGH-RISK** (mutates stock) — mitigated by **semi-automatic staging + operator confirm**.

## Intent

When a `RETIROS DE EQUIPOS` SO closes with a **completed-removal** result code, the removed device
must come back into our depot as `available` stock. Today that return is invisible to inventory —
the W1 ledger has the `RETURN→DEPOSITO` primitive but no caller. W4 wires the closure pipeline to
**stage** a return suggestion per removed device, which an operator reviews and confirms before any
stock mutation happens. No silent auto-mutation from a fuzzy external signal.

## Scope

### In Scope
- Closure side-effect `processInventoryReturns` in `IngestClosedServiceOrders.runClosureSideEffects`: completed-retiro → STAGE one pending return per removed-device serial. Never mutates stock.
- New dedicated staging model `ReturnSuggestion` (taskId, serviceOrderId, serialNumber, matchedAssetId nullable, status `pending|confirmed|discarded|needs_review`).
- Confirm use case `ConfirmAssetReturn` → `RecordInventoryMovement(RETURN, asset→DEPOSITO)` via `UnitOfWork` (atomic) → asset `available` at depot. No-match path: operator create-at-depot / link / discard.
- Per-SO idempotency flag `inventoryReturnsProcessed` on `IClassServiceOrder` (mirrors `inventoryBuilt`); optional `sourceRef` natural key on `InventoryMovement` for confirm-step safety.
- Migration: the per-SO flag + the `ReturnSuggestion` table (+ optional `sourceRef`).
- FE: a "Devoluciones pendientes" review/confirm surface (reuse #35 pending-list + #19 confirm UX).

### Out of Scope
- INSTALL movements (owned by #19 — zero double-count, see explore §4).
- Consuming/persisting `IClassSoEquipmentEvent` (dead source; table left as-is).
- `move`/replace (TRANSFER) flows — no live signal exists.
- Fully-automatic stock mutation without operator confirm (rejected: HIGH-RISK).

## Capabilities

### New Capabilities
- `inventory-returns`: closure-detected RETIRO staging, the `ReturnSuggestion` lifecycle, and operator-confirmed `RETURN→DEPOSITO` movement.

### Modified Capabilities
- `iclass-closure`: adds `processInventoryReturns` side-effect + `inventoryReturnsProcessed` per-SO marker to the closure pipeline.

## Approach

1. **Detect (closure side-effect)**: gate on `soTypeDescription = RETIROS` **AND** a completed-removal result code (`resultCodeType = 'Sucesso'` + configurable removal-code set via `IClassResultCode`) — a `Cliente Ausente` / `Falha` retiro stages nothing. Skip if `inventoryReturnsProcessed`.
2. **Stage**: per OCR serial on the task → `ReturnSuggestion` with `matchedAssetId` = `findBySerialNumber(serial)` or null (`needs_review`). Set flag true. Never mutate stock.
3. **Confirm**: operator confirms → `ConfirmAssetReturn` runs `ResolveDepotLocation` + `RecordInventoryMovement(RETURN)` in a `UnitOfWork`; asset → `available`@depot, surfaces in `GetDepotStock` for free. No-match → create/link/discard.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `application/use-cases/IngestClosedServiceOrders.ts` | Modified | New `processInventoryReturns` side-effect, gated by completed-removal code + per-SO flag |
| `application/use-cases/ConfirmAssetReturn.ts` | New | Operator confirm → `RETURN→DEPOSITO` via `UnitOfWork` |
| `application/use-cases/StageReturnSuggestions.ts` | New | Build pending returns from OCR serials |
| `domain/ports/ReturnSuggestionRepository.ts` (+ Prisma/in-memory) | New | Persist/list pending returns |
| `domain/ports/ClosedServiceOrderRepository.ts` (+ adapters) | Modified | `inventoryReturnsProcessed` flag get/set |
| `prisma/schema.prisma` + migration | New | `ReturnSuggestion` table, `inventoryReturnsProcessed`, optional `sourceRef`+`@@unique` |
| `infrastructure/http/routes/serviceInventory.routes.ts` | Modified | List + confirm/discard pending returns |
| `ipnext-frontend` returns review panel | New | "Devoluciones pendientes" list + confirm card |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Stock mutation from a non-removal retiro (`Cliente Ausente`) | High | Gate on completed-removal **result code** (`Sucesso` + mapped set), not SO type alone |
| Re-closure double-returns the same asset | High | Per-SO `inventoryReturnsProcessed` flag (primary) + optional `sourceRef` unique on movement |
| OCR serial misread returns the WRONG asset | Med | Staging + operator confirm; match only `installed` assets |
| Removal-code set ambiguity | Med | Confirm exact completed-removal codes vs `IClassResultCode`/`DeviceTypeCatalog` data in design |
| Stakeholders expect IClass-event consumption | Low | Proposal documents the pivot; populating IClass's module is an upstream config change |

## Rollback Plan

Feature-flag `iclass-inventory-returns` defaults OFF — disabling stops staging immediately.
The migration is additive (new table + nullable columns), reversible by drop. Confirmed returns
are real ledger movements: reverse via a compensating `RecordInventoryMovement` (ISSUE back to
client) — the ledger is append-only by design, so we compensate, not delete.

## Dependencies

- W1 primitives (shipped): `RecordInventoryMovement(RETURN)`, `ResolveDepotLocation`, `findBySerialNumber`, `UnitOfWork`, `GetDepotStock` (W3).
- #19 OCR channel (`OcrExtraction`) for device serials; #35 pending-list / #19 confirm UX for FE reuse.

## Success Criteria

- [ ] A completed RETIRO with a matched OCR serial stages exactly one `pending` `ReturnSuggestion`; a `Cliente Ausente` retiro stages nothing.
- [ ] Re-closing the same SO re-stages nothing (`inventoryReturnsProcessed` honored).
- [ ] Operator confirm fires one atomic `RETURN→DEPOSITO`; asset becomes `available`@depot and appears in `GetDepotStock`.
- [ ] A no-match serial stages `needs_review`; operator can create-at-depot / link / discard — never auto-created.
- [ ] No INSTALL movement is ever produced by W4.
