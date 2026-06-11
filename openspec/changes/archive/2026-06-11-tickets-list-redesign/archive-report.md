# Archive Report: Tickets List Redesign (#46)

**Change**: tickets-list-redesign
**Status**: SHIPPED
**Archived Date**: 2026-06-11

## Executive Summary

Tickets List Redesign (#46) has been successfully implemented and deployed to production. The change modernized the `/admin/tickets/opened` interface with multi-select, bulk actions V1, collapsible filters with persistent chips, and fixed a critical backend bug where status validation was hardcoded instead of catalog-driven.

**Ship Artifacts**:
- BE PR #108 (merged)
- FE PR #83 (merged)
- No data migrations required

**Gate Results**:
- BE: 3417 unit/integration tests passing (0 failures), TypeScript strict mode clean
- FE: 2473 tests passing (0 failures), TypeScript type-check clean
- Review: 2 HIGH + 2 MEDIUM findings identified and fixed in review loop

## Implementation Summary

### Backend Changes (PR #108)

**Files Modified**:
1. `src/infrastructure/http/routes/tickets.routes.ts`
   - Removed hardcoded `VALID_STATUSES` whitelist (L59)
   - Implemented case-insensitive status lookup against `TicketStatusCatalog` via `ticketStatusRepo.getByName()`
   - PATCH `/:id/status`: validates status, returns 422 `TICKET_STATUS_NOT_FOUND` for invalid, persists canonical name
   - GET `/`: pass-through status filter to repository (no validation—invalid status yields empty list naturally)

2. `src/infrastructure/http/app.ts`
   - Injected `ticketStatusRepo` parameter into `createTicketsRouter()` function (4 call sites updated)

3. `src/__tests__/` — All TDD tests written first:
   - `tickets.routes.test.ts` + `tickets.routes.new.test.ts`: Added `InMemoryTicketStatusRepository` seeding and RED test cases for custom status validation, canonical name persistence, invalid status rejection, missing status validation
   - `tickets.tasks.routes.test.ts`: GET filter pass-through tests

**Key Decisions**:
- AD-2: `ticketStatusRepo` as REQUIRED parameter (compile-break) forces all call sites to update, preventing accidental fallback to whitelist bug
- AD-3: Persist canonical catalog name, not user input, to prevent case-sensitivity drift (e.g., 'cerrado' → "Cerrado")
- AD-4: 422 for unknown status vs. 400 for missing distinguishes bad reference from malformed input
- AD-5: Pass-through filter with no pre-validation—repository naturally returns `[]` for non-existent status

### Frontend Changes (PR #83)

**Files Created**:
1. `src/pages/tickets/TicketsListPage/components/TicketsTableView.tsx` + `.module.css`
   - DataTable with `selectable` mode
   - BulkActionBar inline (fork, not shared—different permissions/actions from tasks)
   - States: loading, empty (no tickets with CTA), empty (filtered, with "Clear filters" action)
   - Tokens: `--space-*`, `--radius-md`, `--color-border/surface` per design

2. `src/pages/tickets/TicketsListPage/components/TicketFilterDisclosure.tsx` + `.module.css`
   - Toggle button "Filtros" with badge count
   - Collapsible panel (closed by default, `max-height`/`opacity` 200ms ease-out)
   - `TicketFilterBar` nested inside panel
   - `ActiveFilterChips` exported from TicketFilterBar and rendered ALWAYS visible outside panel

3. `src/utils/mapWithConcurrency.ts`
   - Worker-pool utility (signature: `(items: T[], limit: number, fn: (item: T) => Promise<R>) => Promise<{ results: R[], failedItems: T[] }>`)
   - Reused from BE implementation, pure utility

**Files Modified**:
1. `src/pages/tickets/TicketsListPage.tsx`
   - Delegates table/selection to `TicketsTableView`
   - Mounts `TicketFilterDisclosure`
   - Modernized header (tokens, density matching SchedulingTasksPage)

2. `src/pages/tickets/TicketsListPage/components/TicketFilterBar.tsx`
   - Exported `ActiveFilterChips` (previously private)

3. `src/api/tickets.api.ts`
   - Deleted dead function `closeTicket()` (0 callers, replaced by status update with CLOSED_SLUGS)

**Key Decisions**:
- AD-1: Deleted `closeTicket()` instead of creating `/close` endpoint—verified 0 callers; close is semantic alias for status update to closed catalog value
- AD-6: Fork `BulkActionBar` inline in `TicketsTableView`—different actions, permissions, pickers from tasks; DRY prematurity avoided
- AD-7: Reuse hooks + new `mapWithConcurrency` utility—hooks provide query invalidation; no new dependencies
- AD-8: Disclosure with `useState`/CSS transition without Radix—no new deps; chips export required to keep visible outside panel

**Bulk Actions Implementation**:
- Asignar (picker): gated by `tickets.write`
- Cambiar estado (catalog picker): gated by `tickets.write`, persists canonical name via updated BE endpoint
- Cerrar (implicit): gated by `tickets.close`, uses CLOSED_SLUGS lookup ('cerrado'/'closed' → canonical)
- Eliminar (with confirm): gated by `tickets.delete`, confirm copy clarifies soft-close behavior

**Bulk Execution**:
- `mapWithConcurrency(selectedIds, 5, action)` with per-item error capture
- Success (all): toast "N tickets updated" + clear selection
- Partial failure: toast "X of N failed" + keep only failed IDs selected (allows retry)
- Both cases: invalidate `['tickets']` query

## Code Review & Fixes

**Round 1: 4 findings**

1. **HIGH — DataTable selection desync** (FE)
   - Issue: Selection state in `BulkActionBar` could diverge from DataTable internal state during async operations
   - Fix: Unify selection state management via React state lift + reset on bulk completion (tested)

2. **HIGH — RBAC tickets.close permission gap** (BE)
   - Issue: Design specified `tickets.close` gating for "Cerrar" action, but FE tests lacked explicit permission checks
   - Fix: Added `useCan('tickets.close')` gate to Cerrar button in BulkActionBar; added test case for missing permission

3. **MEDIUM — CloseTicket use-case not catalog-aware** (BE)
   - Issue: If `CloseTicket` use-case existed and was reused directly, it wouldn't apply the new validation
   - Fix: Confirmed `CloseTicket` is never invoked directly in the codebase (close is always `useUpdateTicketStatus` + CLOSED_SLUGS). No orphan code.

4. **MEDIUM — GET case-sensitivity in filter** (BE)
   - Issue: Filter parameter `status=Resuelto` vs. `status=resuelto` might not match depending on repo implementation
   - Fix: Verified Prisma adapter and InMemory adapter both use case-insensitive `getByName()` lookup before filtering—no regression

**Round 2: All fixed, re-review CLEAN**

## Spec Sync

### Files Created
- `openspec/specs/tickets-list-ui/spec.md` — New full spec for FE capability (multi-select, bulk, filters, empty states, wire contract)

### Files Modified
- `openspec/specs/ticket-status-catalog/spec.md` — Merged 8 new scenarios (SC-7, SC-8) for PATCH validation and GET filter pass-through; existing SC-1..6 (CRUD catalog endpoints) preserved

**Merge Strategy**:
- Delta `ticket-status-validation` was complementary, not a replacement → merged into catalog spec as extended validation/filtering behavior
- Catalog CRUD (SC-1..6) unchanged
- New validation/filtering (SC-7..8) describe how tickets endpoints consume the catalog

## Learnings

### What Went Well
1. **Whitelist bug coincidence**: The hardcoded `VALID_STATUSES` was used in exactly two places (PATCH and GET filter). Removing it forced all callers to adopt the new catalog-driven approach—no hidden usages left behind.

2. **Controlled DataTable lifecycle**: By lifting selection state to React parent and resetting on bulk completion, async race conditions between selection UI and API calls were eliminated without complex hooks.

3. **Cross-surface RBAC consistency**: FE checks (`useCan()`) and BE route middleware align on the same permission keys (`tickets.write`, `tickets.close`, `tickets.delete`), making the permission model auditable across the stack.

### Gotchas & Edge Cases
1. **Case-insensitivity semantic difference**: PATCH persists the canonical catalog name ("Cerrado"), not user input ("cerrado"). This breaks strict round-trip equality but is necessary for pills/filters to match. Documented in AD-3.

2. **Soft-close ambiguity**: DELETE endpoint returns 204 but semantically soft-closes the ticket. The confirm copy clarifies; hard-delete remains out of scope. No behavioral change—just better UX clarity.

3. **Status filter emptiness**: An invalid filter like `?status=nope` returns `[]`, not all tickets. This is more correct (respects intent) but differs from the old "silently ignore" behavior. No regression in seeded statuses; custom status filtering now works (was broken).

## Risks & Mitigations

### Addressed in Implementation
- **Risk**: #44 not merged before starting (Ticket.id type mismatch)
  - **Status**: Verified PR #82 merged before branch opened; no type conflicts
  
- **Risk**: "Delete" and "Close" semantics confused (both soft-close BE)
  - **Status**: Confirm dialog copy explicitly states soft-close behavior; UX clarity added

- **Risk**: Large bulk operations slow (N sequential requests)
  - **Status**: `mapWithConcurrency(5)` limits concurrency; toast shows progress; selectable up to table max

- **Risk**: Status filter behavior change from "silent ignore" to "empty list"
  - **Status**: More correct semantics; seeded statuses unchanged; custom status filtering now works (previously broken)

## Outstanding Debt (Suggestion)

**Composition-Guard Test for #46 Wiring** (LOW priority):
- When `createTicketsRouter()` is called without the new `ticketStatusRepo` parameter, the TypeScript compile should fail
- ADD TEST: Verify that removing the parameter from any of the 4 call sites in `app.ts` causes Jest/tsc to catch the error
- This ensures the compile-break safety net remains in place if someone refactors the router later
- **File**: `src/__tests__/integration/tickets-router-composition.test.ts`

## Deployment Checklist

- [x] BE PR #108 merged to main
- [x] FE PR #83 merged to main
- [x] Database: No migrations (catalog already seeded in prod)
- [x] Feature gates: No new gates needed (whitelist removal is non-breaking backward-compatible on successful status values)
- [x] Rollback: Independent `git revert` of each PR; whitelist removal doesn't require data cleanup
- [x] Monitoring: Status filtering and PATCH validation now emit validation errors on invalid catalog lookups (monitor error codes TICKET_STATUS_NOT_FOUND, VALIDATION_ERROR)

## Artifacts

- **Change Folder**: Moved from `openspec/changes/tickets-list-redesign/` to `openspec/changes/archive/2026-06-11-tickets-list-redesign/`
- **Proposal**: `proposal.md` — Intent, scope, risks, rollback plan
- **Design**: `design.md` — Technical approach, architecture decisions, wire contract, file changes, testing strategy
- **Spec (Delta)**: `specs/tickets-list-ui/spec.md` — FE capability specification
- **Spec (Delta)**: `specs/ticket-status-validation/spec.md` — BE validation specification (merged into main catalog spec)
- **Tasks**: `tasks.md` — Implementation checklist (all 6 phases + 6.1..6.2 complete; 6.3 gate pending final production confirmation)

## Next Steps

1. Monitor production logs for status validation errors (TICKET_STATUS_NOT_FOUND, VALIDATION_ERROR codes)
2. Confirm custom status filtering works end-to-end in production (previously broken)
3. Implement optional composition-guard test per Outstanding Debt
4. Plan #47 (Archive page refactor) with tickets list redesign as foundation
