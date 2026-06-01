# Spec — gestion-real-sync-config (delta: resync-all + reset endpoints)

**Capability**: `gestion-real-sync-config`
**Type**: Modified (adds RBAC-guarded operations to the existing capability)
**Change**: `gr-resync-all` (folder `gr-sync-config-enhancements`)
**Layer**: Infrastructure routes + wiring + application orchestrator use case (`ResyncAllGr`)
**New route (primary)**: `POST /api/gestion-real/sync/resync-all` (RBAC `gestionReal:write`)
**New route (kept from prior scope)**: `POST /api/gestion-real/sync/reset` (RBAC `gestionReal:write`)
**Reused, unchanged**: `GET /api/clients/stats` (estado breakdown — consumed by FE, no spec delta here)

---

## Purpose

Expose a single "Re-sincronizar todo" action through the RBAC-guarded GR sync router so the config page can
trigger a FULL re-sync of clients AND contracts under the `gestionReal:write` permission. `resync-all`
orchestrates two existing/new building blocks: it resets the `gr-clients` cursor (full client re-backfill
next tick, via the existing `ResetGrClientsCursor`) and arms the `gr-contracts-backfill` watermark at offset
0 (via `ArmGrContractsBackfill` — see the `gr-contract-backfill` capability spec).

This is a DELTA on `gestion-real-sync-config` (defined by `gr-clients-sync-config-page`: `GET /config`,
`PUT /config`, `GET /status` and their RBAC rules — all unchanged). The simpler clients-only
`POST /sync/reset` from the prior scope is KEPT for back-compat. No schema or migration change.

---

## 1. Resync-All Endpoint

### REQ-RESYNCALL-1: Resync-all resets clients AND arms the contract backfill

`POST /api/gestion-real/sync/resync-all` MUST, for an authorized caller, invoke `ResyncAllGr.execute()`,
which MUST:
- reset the `gr-clients` SyncState cursor to `null` (forcing a full client backfill next tick), AND
- arm the `gr-contracts-backfill` SyncState at offset 0 (so subsequent ticks drain the contract backfill).

It MUST respond HTTP 200 with a summary indicating both actions, e.g.
`{ clients: { entity: "gr-clients", cursor: null }, contractsBackfill: { armed: true, offset: 0 }, message: <string> }`.
The endpoint takes NO request body; any body is ignored. The operation MUST be idempotent — calling it twice
leaves the client cursor null and the backfill armed at 0.

#### Scenario: Authorized resync-all arms both backfills

- GIVEN a user granted `gestionReal:write`
- AND a persisted `gr-clients` SyncState with a non-null cursor
- AND any prior `gr-contracts-backfill` state
- WHEN `POST /api/gestion-real/sync/resync-all` is called
- THEN the response is HTTP 200 with a summary containing the client reset and the contract-backfill arming
- AND the persisted `gr-clients` cursor is now `null`
- AND the persisted `gr-contracts-backfill` watermark is armed at offset 0

#### Scenario: Resync-all is idempotent

- GIVEN a user granted `gestionReal:write`
- AND `gr-clients` cursor already `null` and `gr-contracts-backfill` already armed at 0
- WHEN `POST /api/gestion-real/sync/resync-all` is called again
- THEN the response is HTTP 200 (no error); both watermarks remain reset/armed at 0

---

## 2. RBAC Enforcement (resync-all)

### REQ-RESYNCALL-RBAC-1: Resync-all requires `gestionReal:write`

`POST /api/gestion-real/sync/resync-all` MUST be guarded by `auth → requirePerm('gestionReal', 'write')`. A
user with only `gestionReal:read`, or with no `gestionReal` permission and not `super_admin`, MUST receive
HTTP 403 `{ "code": "PERMISSION_DENIED", "module": "gestionReal", "action": "write" }` and NEITHER watermark
MUST change. A `super_admin` short-circuits to allow.

#### Scenario: Write permission allows resync-all (200)

- GIVEN a user granted `gestionReal:write`
- WHEN `POST /api/gestion-real/sync/resync-all` is called
- THEN the response is HTTP 200 with a summary and a `message`

#### Scenario: Read-only permission denied (403)

- GIVEN a user granted only `gestionReal:read`
- WHEN `POST /api/gestion-real/sync/resync-all` is called
- THEN the response is HTTP 403 with `{ "code": "PERMISSION_DENIED", "module": "gestionReal", "action": "write" }`
- AND the `gr-clients` cursor and `gr-contracts-backfill` watermark are unchanged (the use case is NOT invoked)

#### Scenario: No permission and not super_admin denied (403)

- GIVEN a user with no `gestionReal` permission and no `super_admin` role
- WHEN `POST /api/gestion-real/sync/resync-all` is called
- THEN the response is HTTP 403 with `{ "code": "PERMISSION_DENIED" }`

#### Scenario: super_admin short-circuit allows resync-all

- GIVEN a user with the `super_admin` role and NO explicit `gestionReal` permission
- WHEN `POST /api/gestion-real/sync/resync-all` is called
- THEN the response is HTTP 200 (super_admin bypasses the permission lookup)

### REQ-RESYNCALL-AUTH-1: Resync-all requires authentication

`POST /api/gestion-real/sync/resync-all` MUST require an authenticated session (`auth` runs BEFORE
`requirePerm`). A request with no `auth_token` cookie MUST receive HTTP 401 `{ "code": "UNAUTHORIZED" }` and
NEITHER watermark MUST change.

#### Scenario: No auth cookie → 401

- GIVEN a request with no `auth_token` cookie
- WHEN `POST /api/gestion-real/sync/resync-all` is called
- THEN the response is HTTP 401 with `{ "code": "UNAUTHORIZED" }`
- AND both watermarks are unchanged

---

## 3. Simple Reset Endpoint (kept — clients only, back-compat)

### REQ-RESET-1: Reset clears only the gr-clients cursor

`POST /api/gestion-real/sync/reset` MUST, for a `gestionReal:write` caller, invoke `ResetGrClientsCursor.execute()`
and respond HTTP 200 `{ entity: "gr-clients", cursor: null, message: <string> }`, leaving the
`gr-contracts-backfill` watermark UNTOUCHED. It is idempotent and guarded the same way as resync-all
(`auth → requirePerm('gestionReal','write')`; 403 read-only/no-perm; 401 no auth). This endpoint is RETAINED
for the narrow "just re-backfill clients" case; `resync-all` is the broader action.

#### Scenario: Authorized reset clears only the client cursor

- GIVEN a user granted `gestionReal:write` and a non-null `gr-clients` cursor plus an armed `gr-contracts-backfill`
- WHEN `POST /api/gestion-real/sync/reset` is called
- THEN the response is HTTP 200 with `{ entity: "gr-clients", cursor: null }` and a `message`
- AND the `gr-clients` cursor is `null`
- AND the `gr-contracts-backfill` watermark is UNCHANGED (reset does not arm the contract backfill)

#### Scenario: Reset RBAC (read-only → 403)

- GIVEN a user granted only `gestionReal:read`
- WHEN `POST /api/gestion-real/sync/reset` is called
- THEN the response is HTTP 403 `{ "code": "PERMISSION_DENIED", "action": "write" }` and the cursor is unchanged

---

## 4. Status Breakdown by Estado (reuse — NO backend delta)

### REQ-BREAKDOWN-1: Breakdown is served by the existing client-stats endpoint

The config page's estado breakdown (Activos / Deudor / Inactivo / Incobrable / Bajas) MUST be sourced from
the EXISTING `GET /api/clients/stats` endpoint, which already returns
`{ total, active, late, inactive, blocked, baja }` (`GetClientStats` → `PrismaCustomerRepository.stats` /
`foldClientStats`). NO new backend endpoint, use-case, or data shape is introduced for the breakdown in this
change. Page-label mapping:

| Page label | stats field |
|------------|-------------|
| Activos    | `active`    |
| Deudor     | `late`      |
| Inactivo   | `inactive`  |
| Incobrable | `blocked`   |
| Bajas      | `baja`      |

This requirement is informational: it pins the contract the FE batch consumes and records that NO backend
work is needed. There is no new server-side scenario to test for the breakdown.

#### Scenario: Breakdown data already available (no backend change)

- GIVEN the existing `GET /api/clients/stats` endpoint
- WHEN the config page needs the estado breakdown
- THEN it reads `{ total, active, late, inactive, blocked, baja }` from that endpoint
- AND no new backend endpoint is added by this change
