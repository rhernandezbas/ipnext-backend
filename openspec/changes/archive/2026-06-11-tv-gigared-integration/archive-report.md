# Archive Report: TV Gigared Integration (#47)

**Date Archived**: 2026-06-11  
**Change Name**: tv-gigared-integration  
**Status**: SHIPPED  

---

## Shipping Summary

### Deployment Timeline

1. **BE PR #111** (merged 2026-06-11)
   - Adapter `GigaredClient` + ports `GigaredPort`, `GigaredConfigRepository`
   - 10 use cases: config, summary, accounts, customer lookup, link, register, add/remove services, OTT, reconcile
   - Router `/api/gigared/*` with RBAC guards (`tv.read/write/manage`)
   - Migration `20260630000000_gigared_tv`: table + RBAC module + feature flag
   - Tests: composition seam, routes (supertest), use cases (in-memory), adapter (axios mocked)
   - **Gate Status**: 3597 lines of TypeScript (no failures; tsc clean)

2. **FE PR #86** (merged 2026-06-11)
   - Page `/admin/crm/tv`: paginatable accounts table with email/status filters
   - Tab `TvTab` in `CustomerDetailPage`: link/register flows, servicios, OTT toggle
   - Tab `GigaredTvBody` in `CustomersSettingsPage`: config editor, connection test
   - Banner `GigaredNotConfigured` for degradation (503 → banner + link to settings)
   - **Gate Status**: 2534 lines of code (no failures; typecheck clean)

3. **Database Migration**
   - `20260630000000_gigared_tv` applied successfully
   - Dry-run verified (no breaking changes, idempotent)
   - Table `GigaredConfig` created with singleton row pattern
   - RBAC module `tv` with read/write/manage permissions
   - Feature flag `gigared-integration` set to OFF
   - Grants assigned to `super_admin` AND `administrador` (dual-role approach)

4. **Feature Flag**
   - `gigared-integration` **OFF** (kill switch engaged)
   - All routes except `/config` and `/summary` return 503 until flag is ON
   - Flag is probe-exempt per spec: `/summary` validates key without flag (pre-deployment test path)

---

## Review & Issues Addressed

### Critical Backend Issues (Found & Fixed)

**C1: API Key Audit Masking (Resolved)**
- **Issue**: Full API key was being logged in cleartext in audit events before masking
- **Fix**: Audit middleware now masks `apiKey` → `***` BEFORE event persistence
- **Verification**: `AuditEvent.beforeJson` in test confirms key is masked; `apiKeyLast4` is NOT masked (public)

**C2: CIC_ALREADY_LINKED False Positive (Resolved)**
- **Issue**: The task originally claimed the feature was ready; re-verification found implementation gap
- **Resolution**: Implemented proper 409 check in `LinkCustomerToCic` use case
  - Checks if `internal_id` is non-empty AND different from `customerId` → 409 with `linkedInternalId` returned
  - Idempotent case: if `internal_id` equals `customerId`, returns 200 (no patch performed)
  - Only free accounts (empty internal_id) proceed to patch

### Critical Frontend Issues (Found & Fixed)

**C3: DTO Field Name Drift (Resolved)**
- **Issue**: Design said `last4`; spec clarified to `apiKeyLast4`
- **Fix**: All FE components now use `apiKeyLast4` (matches backend DTO)
- **Verification**: Type boundaries confirmed in wire tests

**C4: Ghost Error Codes Removed (Resolved)**
- **Issue**: FE had hardcoded error handlers for codes that backend doesn't emit (e.g., `GIGARED_ACCOUNT_EXISTS`, `TV_NOT_LINKED`)
- **Fix**: Removed ghost handlers; now handle only real codes: `GIGARED_NOT_CONFIGURED`, `GIGARED_UNAVAILABLE`, `GIGARED_AUTH_FAILED`, `GIGARED_NOT_FOUND`, `GIGARED_REJECTED`, `CIC_NOT_FOUND`, `CIC_ALREADY_LINKED`, `TV_CATALOG_MISSING`, `TV_LOCAL_SYNC_FAILED`
- **Verification**: Spec ↔ implementation alignment re-confirmed post-fix

**C5: HTTP Status 207 Removal from Routes (Resolved)**
- **Issue**: FE had hardcoded route status expectations that would fail on 207 responses
- **Fix**: FE wire boundaries updated to handle 207 `AddTvServiceResult` with `local: 'failed'` + `localError` detail
- **Verification**: 207 scenario end-to-end tested (Gigared OK + local reconcile fails → 207 + retryable state preserved)

---

## Parallel Build Drift Pattern (Discovery)

During the review loop, we detected a systematic pattern:
- **Spec contract** (10 routes, pinned codes, 503/502/404/422/409 only)
- **Design decisions** (D1–D8: architecture, retry, gating, reconcile, migration strategy)
- **As-built code** had drifted subtly from both in places (field names, error codes, reconcile ownership)

**Root Cause**: When building in parallel (BE + FE both reading spec, then implementing independently), without live alignment checkpoints, spec ↔ code drift accumulates.

**Mitigation for Future Changes**:
1. **Freeze one contract** (choose spec OR design, not both diverging)
2. **Live wire boundary test** (build and test the HTTP boundary first, before use cases/components)
3. **Checkpoint before implementation** (one team writes the wire seam, the other implements against it)

**Learning Applied**: The specs have now been **realigned to as-built**, so the frozen contract going forward is the **as-built wire contract in design.md** (not the original spec, which had ambiguities).

---

## Key Design Insights Captured

### D1: Per-Request Config Lookup
- `GigaredClient` reads `apiKey`/`baseUrl` PER REQUEST via `GigaredConfigRepository.get()`
- Cost: sub-millisecond lookup vs. external calls (hundreds of ms)
- Benefit: PUT takes effect immediately, zero cache invalidation bugs, multi-instance safe

### D2: Guard Not-Configured at Router Middleware
- `createGigaredReadyMiddleware` (flag ON + key ≠ '') applied to all routes except `/config`
- `GigaredClient` throws `GigaredNotConfiguredError` if key is empty at call time (carriage-race safety)
- Single seam, single test, no code duplication

### D3: Single Additive Migration
- One migration file (`20260630000000_gigared_tv`) with table + RBAC + flag
- No BEGIN/COMMIT (Prisma wraps)
- Idempotent on conflict (precedent: `20260619000000_uisp_mirror`)

### D4: Flag in Config DTO
- `/api/gigared/config` GET/PUT reads/writes the `gigared-integration` feature flag
- Operator only needs `tv.manage` (not `admin.flags`) to toggle integration
- Self-contained config tab

### D5: Internal ID as Binding
- Binding is `internal_id = customer.id` (UUID stored in Gigared)
- No CIC persistence in our DB (Gigared is source of truth)
- Lookup: `GET /accounts/{customer.id}?use_internal_id=true`
- Avoids desync between our DB and Gigared account metadata

### D6: Reconcile on Every Mutation
- After each service add/remove, read the account and reconcile the local TV `ContractService`
- **D6.1**: On add → upsert single managed row (notes = "CIC {cic} · {service names}")
- **D6.2**: On remove → if services remain, update notes; if empty, set `status = 'inactive'` (not deleted — history)
- Deterministic, idempotent, enables retry-by-repost

### D7: Idempotent Rejected-But-Assigned
- If Gigared rejects a service add but the account already carries that `serviceId`, treat as success
- Re-POST is safe: checks Gigared first, sees it's there, skips the add, runs reconcile → idempotent

### H1: Inactivate, Never Delete
- When last service is removed, set `status = 'inactive'` on the managed row
- History is preserved; subsequent adds re-activate the row
- A manually created TV row (not managed by Gigared — notes don't start with "CIC ") is never touched

### H2: Ownership via Notes Prefix
- Reconcile ONLY modifies rows whose `notes` start with `"CIC "`
- Manual TV entries (e.g., from #42 UI, notes = null or custom) are left untouched
- Prevents collisions between manual and Gigared-managed slots

### M1: Probe Exempt from Flag
- `/api/gigared/summary` is the "test connection" endpoint
- Flag-exempt, key-required (validates key BEFORE toggling flag ON)
- Allows operator to load key in config, test it, then activate integration

### Audit Masking Whitelist Strategy (Post-Deploy Lesson)
- New credentials should ALWAYS have an audit masking whitelist in middleware
- Fields like `apiKey`, `password`, `api_secret` mapped to `***` before event persistence
- Public metadata (like `apiKeyLast4`, `email`) explicitly NOT masked
- Pattern: `{ apiKey: '***', apiKeyLast4: '1234' }` in cleartext (audit trail is safe)

---

## Post-Deploy Activation Steps

**Current State**: Feature shipped with flag OFF and no API key loaded.

**Activation Sequence**:
1. **Load API Key** (Ejecutivo de Cuentas Gigared provides)
   - Navigate to `/admin/customers/settings` → "Gigared TV" tab
   - Paste API key into "Nueva clave API" field
   - Click **Guardar**

2. **Validate Connection**
   - Same tab: Click **Probar conexión**
   - Success: "Conectado. Cuentas registradas: {N}, servicios: {M}"
   - Failure: "Autenticación fallida: la clave API es inválida"

3. **Toggle Feature ON**
   - Same tab: Toggle **Integración activa** → Guardar
   - Flag `gigared-integration` flips to ON

4. **Smoke Test**
   - Browse to `/admin/crm/tv` → should load accounts table
   - Pick a customer, open `CustomerDetailPage` → tab "TV" should appear
   - Try linking/registering an account (requires test accounts in Gigared)

5. **Role Assignment** (if needed)
   - Visit `/admin/roles` → edit `administrador` role
   - Assign `tv:read`, `tv:write`, `tv:manage` (or use existing super_admin)
   - Test operator user can access TV pages

---

## Artifacts Moved to Archive

Location: `openspec/changes/archive/2026-06-11-tv-gigared-integration/`

Contents:
- ✅ `proposal.md` — intent, scope, capabilities, risks, rollback, success criteria
- ✅ `explore.md` — investigation notes (API contract exploration, existing patterns)
- ✅ `design.md` — architecture decisions (D1–D8, H1–H2, M1), wire contract, data flow, file changes
- ✅ `tasks.md` — 63 tasks across 6 phases, all checked ✅
- ✅ `specs/` directory (3 domains):
  - `gigared-config/spec.md` — config singleton, GET/PUT routes, readiness gating, migration
  - `gigared-accounts/spec.md` — proxy, GET /accounts & /summary, error mapping
  - `gigared-customer-tv/spec.md` — per-customer activation, link/register, services, OTT, ownership & reconcile rules

---

## Main Specs Synced

The delta specs (realigned to as-built) have been promoted to the source of truth:

| Domain | Location | Action |
|--------|----------|--------|
| `gigared-config` | `openspec/specs/gigared-config/spec.md` | Created — 121 lines, config singleton + routes + gating |
| `gigared-accounts` | `openspec/specs/gigared-accounts/spec.md` | Created — 132 lines, proxy + summary + error mapping |
| `gigared-customer-tv` | `openspec/specs/gigared-customer-tv/spec.md` | Created — 217 lines, activation, reconcile, ownership rules |

---

## Dependencies & Flags

- **Feature Flag**: `gigared-integration` (OFF, kill switch ready)
- **Dependencies**: API key from Gigared executive (post-deploy)
- **Catalog**: TV item in ServiceCatalog must exist (seeded by #43)
- **Roles**: `super_admin` + `administrador` have grants for `tv:read/write/manage`

---

## SDD Cycle Status

✅ **Exploration** — investigated API contract, existing patterns, legacy code  
✅ **Proposal** — defined intent, scope, capabilities, risks  
✅ **Specification** — wrote delta specs (3 domains), realigned to as-built  
✅ **Design** — architecture decisions (D1–D8, H1–H2, M1), wire contract, error mapping  
✅ **Tasks** — 63 tasks, all implemented  
✅ **Implementation** — code shipped (BE PR #111, FE PR #86)  
✅ **Verification** — critical issues found and fixed (C1–C5), specs realigned  
✅ **Archive** — change moved, specs synced to main, report documented  

**Ready for next change.**

---

## Next Steps

- **Waiting**: API key from Gigared executive
- **Once key arrives**: Follow post-deploy activation steps (load key → test → toggle ON)
- **Future V2 candidates**: CIC persistence, webhook support, API key rotation from UI, pgcrypto encryption

---

**Archived by**: sdd-archive agent  
**Artifact Store**: openspec (file-based)  
**Change Status**: COMPLETE, INERT (flag OFF), SAFE TO DEPLOY
