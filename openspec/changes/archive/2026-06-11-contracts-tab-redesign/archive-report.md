# Archive Report: contracts-tab-redesign (#42 — FE only)

**Status**: SHIPPED ✅  
**Date Archived**: 2026-06-11  
**Change Type**: Frontend UI redesign  
**Artifact Store**: openspec (file-based)

---

## Delivery Status

**Shipped**: FE PR #81 (2026-06-11)

### Gate Results
- **Tests**: Vitest 2408 passed, 0 failed ✅
- **Typecheck**: Clean (`tsc --noEmit`) ✅
- **Review**: Approved with 3 warnings fixed ✅

### Review Findings (Resolved)
| Issue | Status | Fix |
|-------|--------|-----|
| Alert components → toast error pattern | ✅ Fixed | Replaced alert() calls with `mapError` toast pattern for consistency with page |
| Service add/remove controls visibility | ✅ Fixed | Gating test updated to verify `clients.write` permission properly hides mutation controls |
| Error code messaging for SERVICE_CATALOG_NON_DELETABLE | ✅ Fixed | Message now clearly states "OTROS no se puede eliminar" (constraint, not a conflict) |

---

## What Shipped

### FE Deliverables
- **ContractsTab rewrite**: Cards layout with inline name edit, service chips, address ("Instalación"), equipment integration
- **ServiceInventorySection**: CSS Module extraction, removed banned `borderLeft` inline style
- **ServiceCatalogBody**: ABM (list/create/update/delete) cloning DeviceTypesBody patterns, tab in CustomersSettingsPage, gated `Can clients.manage`
- **Type fixes**: `Contract.id: string` (was lying as number), added `name`, `services[]`, `ip` fields
- **Hooks + APIs**: `useServiceCatalog`, `useContractServices`, `patchContractName`, service-catalog and contract-services endpoints

### BE Alignment
- No backend changes required; relies on BE specs `contract-naming`, `contract-services`, `contract-service-catalog` (shipped earlier)
- Wire contract verified: all 11 endpoints confirmed in `contractServices.routes.ts`, `serviceCatalog.routes.ts`, and `clients.routes.ts` via origin/main

---

## Architecture Decisions Implemented

| Decision | Choice | Rationale |
|----------|--------|-----------|
| AD-1: Component structure | Subfolder `tabs/contracts/` with presentational components | Mirrored SchedulingTaskDetailPage precedent; separation of container (queries) and presentational |
| AD-2: Name edit pattern | Click-to-edit inline (pencil icon, Enter saves, Esc cancels) | Ban on "modal as first thought"; single-field editing doesn't warrant modal overhead |
| AD-3: Services data source | Embedded in `GET /api/clients/:id/contracts` response | Contract-side eager loading; avoids N+1 queries and dual source of truth |
| AD-4: Service picker | Popover inline (outside-click pattern) | Lightweight contextual action; ban on modal-first design |
| AD-5: Service toggle | Toggle chip to change active/inactive status | 2 state transitions don't warrant menu; visual state IS the feedback |
| AD-6: ServiceInventorySection | 1:1 CSS Module extraction from inline styles | Test protection (existing test guards against regression in Fase 1) |
| AD-7: Remove CRUD stub UI | Delete create/edit/delete contract actions entirely | Stub never persisted; only consumer was dead code (ServicesTab.tsx) |
| AD-8: Status pill | Reuse `StatusBadge` atom with token overrides | Existing component + tokens; consistency with design system |
| AD-9: Settings ABM | `ServiceCatalogBody` in CustomersSettingsPage tabs (lazy, hash-sync) | Established pattern: Tecnologías gated by `contracts.read` on same tab layer |

---

## Key Learnings & Gotchas

### 1. Toast Error Pattern Is Local, Not Global
**Discovery**: Expected a global toast context for error handling. Found each feature implements its own `mapError` function.

**Impact**: ServiceCatalogBody and ContractServiceChips use local `mapError` closures to map BE error codes (409, 422) to user-facing messages.

**Lesson**: No centralized error toast context exists; patterns are scattered per feature. Consider building one when consolidating these patterns across the app.

---

### 2. CRUD Stub Was Never Persisted
**Discovery**: Contract create/edit/delete endpoints write to an in-memory override store (`contractsOverrideStore`), but `GET /api/clients/:id/contracts` always reads Prisma (never merges the stub data).

**Impact**: The old UI exposed a false creation/deletion flow that had zero persistent effect. Removing it is a UX fix, not a regression.

**Lesson**: Stub endpoints without persistence are technical debt. Future: mark with a flag feature gate or deprecation notice rather than leaving in code.

---

### 3. Clone Verb + Error Code Drift (DeviceTypes → ServiceCatalog)
**Discovery**: Copied `DeviceTypesBody` but discovered naming convention differences:
- DeviceTypes uses **PUT** for updates; ServiceCatalog uses **PATCH** (verified in routes).
- DeviceTypes returns 409 for duplicate name; ServiceCatalog also uses 409 but DELETE uses 422 for "in use" (not 409).

**Impact**: Direct copy-paste would have broken. Design spec verifies the correct verbs and codes per endpoint.

**Lesson**: When cloning, verify the full wire contract (verbs + error codes) before copy-pasting. Don't assume patterns are consistent across adapters.

---

### 4. BE `toService` Mapper Doesn't Include `technology` Field
**Discovery**: `PrismaCustomerRepository.ts:57-83` (`toService` mapper) doesn't include `technology` in the contract DTO. FE spec includes it in the wire contract.

**Status**: Out of scope for this FE change; BE should update mapper separately. FE assumes `technology` will arrive when BE is fixed.

**Lesson**: Wire contracts should be verified against BE mappers, not just routes. A route existing doesn't guarantee the field is included in the DTO.

---

## Specs Synced to Main

| Domain | Action | Requirements |
|--------|--------|--------------|
| `contracts-tab-ui` | **Created** | 9 requirements (CTU-1 through CTU-9): type safety (UUID string id), card layout, inline name edit, service chip CRUD, empty states, CSS Module extraction, ServiceCatalogBody ABM, lazy tab with hash sync |

**Main Spec Location**: `openspec/specs/contracts-tab-ui/spec.md`

---

## Archive Contents

```
openspec/changes/archive/2026-06-11-contracts-tab-redesign/
├── proposal.md          ✅ Scope, resolved questions, approach
├── design.md            ✅ Wire contract, architecture decisions, visual spec
├── specs/
│   └── contracts-tab-ui/spec.md  ✅ 9 requirements, scenarios, constraints
├── tasks.md             ✅ 15-item task checklist (all shipped)
└── explore.md           ✅ Research + alternatives evaluated
```

---

## Source of Truth Updated

The following spec now reflects the new behavior:
- **`openspec/specs/contracts-tab-ui/spec.md`** — Complete FE UI spec for contracts tab redesign

---

## Test Coverage

### Shipped Tests
- **`ContractsTab.test.tsx`**: Card render, name edit inline, service add/toggle/remove, permissions gating
- **`ServiceCatalogBody.test.tsx`**: List/create/edit/delete ABM, 409 conflict handling, 422 delete guards, `clients.manage` gating
- **`CustomersSettingsPage.test.tsx`**: "Servicios" tab visible with permission, hash `#servicios` sync
- **`ServiceInventorySection.test.tsx`**: Regression — no `borderLeft`, equipment display intact
- **Wire tests**: `serviceCatalog.api.test.ts`, `contractServices.api.test.ts`, `customers.api.test.ts` (patchContractName)

### Coverage
- Vitest: 2408 passed / 0 failed
- No critical issues, no warnings in final gates

---

## Debt and Follow-up Items

| Item | Severity | Owner | Notes |
|------|----------|-------|-------|
| `BE toService` doesn't map `technology` field | Medium | Backend | FE spec assumes `technology` will be populated; currently missing from contract DTO. Update `PrismaCustomerRepository.ts:toService` mapper to include it. |
| Centralize toast error handling | Low | Frontend Architecture | Today each feature has its own `mapError`. Consider building a global error context or shared hook for consistency. |
| Mark stub endpoints as deprecated | Low | Backend | Contract CRUD stub is dead code. Use a feature flag or deprecation notice instead of leaving in codebase. |

---

## Rollback Plan

- **If needed**: Revert FE PR #81. No migrations, no backend dependencies.
- **Data safety**: No data operations; change is UI-only and spec-driven.

---

## SDD Cycle Complete

✅ **Explored** → ✅ **Proposed** → ✅ **Specified** → ✅ **Designed** → ✅ **Tasked** → ✅ **Applied** → ✅ **Verified** → ✅ **Archived**

The change has been fully planned, implemented, verified against spec, and archived.  
Ready for the next change.

---

**Archived by**: sdd-archive  
**Timestamp**: 2026-06-11 07:40 UTC  
**Artifact Store**: openspec (file-based)
