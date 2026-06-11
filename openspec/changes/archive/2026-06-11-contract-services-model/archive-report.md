# Archive Report: contract-services-model (#43)

**Change**: `contract-services-model` (#43)  
**Date Archived**: 2026-06-11  
**Status**: SHIPPED TO PRODUCTION

---

## Deployment Summary

### Backend (Node/TypeScript)
- **PR**: #106 (merged to main, 2026-06-11)
- **Migrations**: 
  - `20260625000000_contract_name` — ALTER TABLE Contract ADD COLUMN name TEXT
  - `20260626000000_service_catalog` — CREATE ServiceCatalog + ContractService tables
  - `20260627000000` — (optional schema refinement if needed)
- **Tests**: Jest 3372/0 (all passing)
- **Type Check**: tsc clean
- **Deployed**: 2026-06-11
- **Pre-deploy Validation**: Dry-run migrations applied and rolled back successfully

### Notes
- BE-only change (#42 UI, #47 TV metadata pending)
- Forward-ready for #42 ContractServicesTab UI and #47 TV service linking

---

## Change Scope

### What Was Implemented

**Data Model**: Three new entities enabling contract service management:
- `ServiceCatalog` — Editable catalog of service types (INTERNET, TV, VOZ, CAMARAS, OTROS), mirroring DeviceTypeCatalog pattern
- `ContractService` — Pivot table linking contracts to services with status (active|inactive) and notes
- `Contract.name` — Nullable manual identifier, excluded from GR sync (pattern: `technology`)

**API Endpoints**:
- `GET /api/service-catalog` — List catalog entries (clients.read)
- `POST /api/service-catalog` — Create entry (clients.manage)
- `PATCH /api/service-catalog/:id` — Update entry (clients.manage)
- `DELETE /api/service-catalog/:id` — Delete entry; OTROS protected, in-use → 422 (clients.manage)
- `POST /api/contracts/:contractId/services` — Add service to contract (clients.write)
- `PATCH /api/contracts/:contractId/services/:id` — Update service status/notes (clients.write)
- `DELETE /api/contracts/:contractId/services/:id` — Remove service, idempotent 204 (clients.write)
- `PATCH /api/contracts/:id { name }` — Set/clear contract name, persists to DB (clients.write)

**Response Enhancements**:
- `GET /api/clients/:id/contracts` — Additive: includes `name: string|null` + `services[]` eager, no N+1

**RBAC Integration**:
- Catálogo ABM gated to `clients.manage` (seeded via 20260529 migration)
- Service CRUD + name update gated to `clients.write` (existing)
- All endpoints enforce two-layer auth (authMiddleware + requirePerm)

---

## Specs Synced to Main

| Capability | File | Action | Details |
|---|---|---|---|
| `contract-service-catalog` | `openspec/specs/contract-service-catalog/spec.md` | CREATED | 5 requirements: list, create, update, delete, idempotent seed |
| `contract-services` | `openspec/specs/contract-services/spec.md` | CREATED | 4 requirements: add, update, remove, additive contract shape |
| `contract-naming` | `openspec/specs/contract-naming/spec.md` | CREATED | 4 requirements: nullable name field, PATCH to persist, GR guard, address semantics doc |

---

## Key Architecture Decisions

### 1. ServiceCatalog as Dedicated Port
**Decision**: Introduced `ServiceCatalogRepository` port in domain, mirroring `DeviceTypeCatalogRepository` pattern.

**Why**: Catalog is a shared resource across multiple features (contracts, future TV metadata). Dedicated port enables independent testing, caching strategy (future), and clear separation from contract-specific operations.

---

### 2. ContractService Pre-Check + P2002 Mapping
**Decision**: `PrismaContractServiceRepository.getByPair()` pre-checks `(contractId, serviceCatalogId)` existence before insert. If race occurs (P2002), adaptor maps to `ContractServiceDuplicateError` → 409.

**Why**: In-memory parity trivial with pre-check. P2002 catch handles the race scenario where duplicate posted between check and insert. Avoids leaking DB-specific Prisma error to application layer.

---

### 3. Contract Name Excluded from GR Sync
**Decision**: `PrismaClientMirrorRepository.upsertContract` data object omits `name` (pattern: `technology`). Comment guards against accidental inclusion.

**Why**: GR sync is read-only mirror; manual name is user domain. Separating allows GR to evolve without trampling operator-set names.

---

### 4. Address Semantics Documented, Not Changed
**Decision**: Spec CN-4 documents existing behavior: `Contract.address/lat/lng` always written by upsertContract (GR wins). No code change.

**Why**: Clarifies for future maintainers and UI (#42): client address = billing, contract address = installation. Pinning this avoids regression when features reference it.

---

### 5. Two-Layer Permission Guards on All Routes
**Decision**: Every endpoint requires both `authMiddleware` (JWT validation) AND `requirePerm('clients', 'read'|'write'|'manage')`.

**Why**: Ensures FE `can()` checks are enforceable. No fallback to unauthenticated or default-permission access. Precedent: DeviceTypeCatalog routes.

---

## Implementation Summary

### Domain Layer
- ✅ `ServiceCatalog` entity (id, name, label, active, sortOrder, createdAt, updatedAt)
- ✅ `ContractService` entity (id, contractId, serviceCatalogId, status, notes, createdAt)
- ✅ `ContractServiceView` DTO (id, contractId, serviceCatalogId, name, label, status, notes, createdAt)
- ✅ 8 typed domain errors (ServiceCatalogNotFoundError, ServiceCatalogNameConflictError, ServiceCatalogInUseError, ServiceCatalogProtectedError, ServiceCatalogInactiveError, ContractServiceDuplicateError, ContractServiceNotFoundError, ContractNotFoundError)
- ✅ `ServiceCatalogRepository` port
- ✅ `ContractServiceRepository` port
- ✅ `ContractRepository.updateName(id, name)` extension

### Application Layer (Use Cases & DTOs)
- ✅ `ListServiceCatalog`, `CreateServiceCatalog`, `UpdateServiceCatalog`, `DeleteServiceCatalog` (UPPERCASE normalization, OTROS guard, in-use count)
- ✅ `AddContractService`, `UpdateContractService`, `RemoveContractService` (inactive reactivation allowed, idempotent delete)
- ✅ `UpdateContractName` (empty string → null normalization)
- ✅ Contract DTOs updated with `name` and `services[]` (eager include, no N+1)
- ✅ 5 Zod schemas (CreateServiceCatalog, UpdateServiceCatalog, AddContractService, UpdateContractService, UpdateContractName)

### Infrastructure Layer
- ✅ `PrismaServiceCatalogRepository` (Prisma-based, pattern: DeviceTypeCatalog)
- ✅ `PrismaContractServiceRepository` (P2002 → DuplicateError mapping, pre-check + race guard)
- ✅ `InMemoryServiceCatalogRepository` (full port parity for tests)
- ✅ `InMemoryContractServiceRepository` (full port parity for tests)
- ✅ `PrismaContractRepository` += `updateName()` (catches P2025 → null)
- ✅ `PrismaCustomerRepository.listContracts` += eager include for services
- ✅ `PrismaClientMirrorRepository.upsertContract` comment guard (name field excluded)
- ✅ 2 routers: `serviceCatalog.routes.ts`, `contractServices.routes.ts` (with `requirePerm` two-layer auth)
- ✅ App.ts wiring: instantiate repos/UCs, mount routers, wire contractLookup

### Schema & Migrations
- ✅ `20260625000000_contract_name` — ALTER TABLE Contract ADD COLUMN name TEXT
- ✅ `20260626000000_service_catalog` — CREATE ServiceCatalog + UNIQUE(name) + seed 5 entries (ON CONFLICT DO NOTHING) + CREATE ContractService + FK CASCADE/RESTRICT + UNIQUE(contractId, serviceCatalogId) + INDEX contractId
- ✅ Prisma schema: models `ServiceCatalog`, `ContractService`, `Contract.name` added, relations pinned

### Tests (7.1 & 7.2 gates met)
- ✅ Jest 3372/0 passing
- ✅ Use case tests: ListServiceCatalog, CreateServiceCatalog, UpdateServiceCatalog, DeleteServiceCatalog, AddContractService, UpdateContractService, RemoveContractService, UpdateContractName (in-memory adapters)
- ✅ Route integration tests: serviceCatalog.routes.test.ts (SC-1.1–SC-4.4), contractServices.routes.test.ts (CSV-1.1–CSV-3.2, CN-2.1–CN-2.4)
- ✅ Regression tests: clients.contracts.shape.test.ts (name + services[] additive)
- ✅ Static composition tests: contract-services-composition.test.ts (requirePerm wiring, UpdateContractName UC wiring, router mounting)
- ✅ Data-block pinning: PrismaClientMirrorRepository.upsertData.test.ts (name/technology NOT in data object)
- ✅ tsc --noEmit: 0 type errors

---

## Review & QA History

### Adversarial Review Cycle

**Review 1 Pass**:
- Flagged: clients.manage grant migration missing (fix: created dedicated 20260606 migration to grant write/delete/manage to clients module)
- Flagged: P2002 race condition not documented (fix: design decision #2 added; adapter maps P2002 → DuplicateError; scenario CSV-1.2 documents behavior)
- Flagged: UpdateDeviceType same gap (debt noted for future; UpdateDeviceType has identical P2002 swallow → 404 risk; documented in knowngaps)

**Review 2 Re-check**:
- ✅ RBAC grants applied via dedicated migration
- ✅ P2002 race documented and handled in adapter + test scenario
- ✅ All permission guards two-layer enforced
- ✅ Address semantics pinned in spec CN-4

**Result**: CLEAN (no blocking issues)

---

## Known Gaps & Future Work

### 1. UpdateDeviceType Has Same P2002 Gap
Identical race condition exists in `UpdateDeviceType` (catch P2002 → 404 instead of merging with duplicate error). Defer to follow-up refactor covering all catalog updates.

### 2. Contract Update Endpoint Scope
`PATCH /api/contracts/:id` currently only supports `name`. Future updates (e.g., status, plan override) would be additive; endpoint signature supports `{ name?, ...future }`.

### 3. Bulk Service Operations
Delete multiple services or activate/deactivate in bulk gated to future feature. Current API supports individual service updates.

---

## Deployment & Rollback

### Pre-Deploy Verification
- ✅ Migration dry-run: applied and rolled back successfully
- ✅ Jest 3372/0 all passing
- ✅ tsc clean
- ✅ Permissions: clients.manage grant verified in 20260606 migration

### Deployment Steps
1. Deploy backend (migrations + code)
2. Verify migrations applied: `ServiceCatalog`, `ContractService` tables present; `Contract.name` column present
3. Verify seed: INTERNET, TV, VOZ, CAMARAS, OTROS entries in ServiceCatalog
4. Smoke test: `GET /api/service-catalog` returns 5 entries; `GET /api/clients/:id/contracts` includes `name` + `services[]`

### Rollback Plan
- Rollback migrations: `npm run prisma:migrate resolve --rolled-back-to 20260624`
- Rollback code to prior main commit
- Verify data consistency post-rollback

---

## Artifacts & Source of Truth

| Path | Purpose |
|------|---------|
| `/openspec/changes/archive/2026-06-11-contract-services-model/` | Archived change folder with proposal, design, specs, tasks |
| `/openspec/specs/contract-service-catalog/spec.md` | NEW: Service catalog capability spec (source of truth) |
| `/openspec/specs/contract-services/spec.md` | NEW: Contract services capability spec (source of truth) |
| `/openspec/specs/contract-naming/spec.md` | NEW: Contract naming capability spec (source of truth) |

---

## Next Steps

### Ready for:
- ✅ #42: ContractServicesTab UI (depends on these endpoints)
- ✅ #47: TV service metadata and linking (depends on ContractService pivot)

### No Blockers
SDD cycle complete. Feature operational in production.

---

## Sign-Off

**SDD Cycle**: Complete  
**Specs**: Synced to main (3 new capability specs)  
**Code**: Deployed to production (PR #106)  
**Status**: DONE
