# Spec — gestion-real-sync-config

**Capability**: `gestion-real-sync-config`
**Type**: Canonical (accumulated from `gr-clients-sync-config-page` + `gr-sync-config-enhancements`)
**Changes**: `gr-clients-sync-config-page` (base), `gr-sync-config-enhancements` (adds resync-all + reset)
**Layer**: Domain port + Application use-cases + Infrastructure routes + Scheduler/bootstrap
**Routes**:
`GET /api/gestion-real/sync/config` (RBAC `gestionReal:read`),
`PUT /api/gestion-real/sync/config` (RBAC `gestionReal:write`),
`GET /api/gestion-real/sync/status` (RBAC `gestionReal:read`),
`POST /api/gestion-real/sync/resync-all` (RBAC `gestionReal:write`),
`POST /api/gestion-real/sync/reset` (RBAC `gestionReal:write`)

---

## Purpose

Provide a typed, editable config store for the GR **client sync** (`intervalMs` + `estados`) plus a
runtime on/off `gestion-real-sync` feature flag, exposed through RBAC-guarded HTTP endpoints. This
replaces ENV-only configuration (`GR_SYNC_INTERVAL_MS`, `GR_SYNC_ESTADOS`, and the runtime aspect of
`GR_SYNC_ENABLED`) with DB-backed config an operator edits without a redeploy. All endpoints return
DTOs, never raw Prisma entities. Use-cases depend only on ports.

---

## 1. Config Store Shape

### REQ-CFG-1: Single typed config record

The system MUST persist a single config record (`id = "singleton"`) with the fields below. `estados`
MUST be stored as a comma-joined `String` (e.g. `"1,2,3,4,6"`), matching how the codebase already
represents this exact set in env (`GR_SYNC_ESTADOS`). The DTO boundary owns the `string ⇄ string[]`
mapping; the domain/DTO surface exposes `estados` as `string[]`.

The runtime on/off control is NOT stored here — it is the `gestion-real-sync` feature flag (the
single runtime gate, checked inside the sync use-case). This config holds only operational tuning.

| Field | Storage type | DTO type | Meaning |
|-------|--------------|----------|---------|
| `intervalMs` | `Int` (default 180000) | `number` | Scheduler tick interval |
| `estados` | `String` (default `"1,2,3,4,6"`) | `string[]` | GR estado codes to scan |

#### Scenario: First read returns defaults when no record exists

- GIVEN no config record has been persisted yet
- WHEN the config is read
- THEN a default record is returned: `intervalMs = 180000`, `estados = ["1","2","3","4","6"]`
- AND these defaults are identical to the current env defaults (so a fresh deploy is behavior-neutral)

---

## 2. GET Config

### REQ-GETCFG-1: Returns the current config as a DTO

`GET /api/gestion-real/sync/config` MUST respond HTTP 200 with a config DTO containing `intervalMs`
(number) and `estados` (`string[]`). It MUST NOT return a raw Prisma entity (no `id`, no `updatedAt`,
no comma-joined string).

#### Scenario: Read current config

- GIVEN a persisted config `{ intervalMs: 300000, estados: "1,3,6" }`
- WHEN `GET /api/gestion-real/sync/config` is called by a user with `gestionReal:read`
- THEN the response is HTTP 200 with `{ intervalMs: 300000, estados: ["1","3","6"] }`

---

## 3. Update Config

### REQ-PUTCFG-1: Updates interval and/or estados (partial patch)

`PUT /api/gestion-real/sync/config` MUST accept a validated PARTIAL body and update the persisted
config, responding HTTP 200 with the updated config DTO. Omitted fields are left untouched; a
provided `estados` array REPLACES the stored set (not merged).

#### Scenario: Update changes the interval

- GIVEN config `{ intervalMs: 180000, estados: ["1","2","3","4","6"] }`
- WHEN `PUT` with `{ intervalMs: 300000 }` by a user with `gestionReal:write`
- THEN the response is HTTP 200 with `intervalMs = 300000` AND `estados` unchanged (`["1","2","3","4","6"]`)

#### Scenario: Update replaces the estados set

- GIVEN config `estados = ["1","2","3","4","6"]`
- WHEN `PUT` with `{ estados: ["1","6"] }`
- THEN the response is HTTP 200 with `estados = ["1","6"]`
- AND a subsequent read returns `["1","6"]` (replacement, not merge)

### REQ-PUTCFG-2: Body validation

`intervalMs` MUST be a positive integer. `estados` MUST be an array of allowed GR estado codes
(`"1"`, `"2"`, `"3"`, `"4"`, `"6"` — note `5` is intentionally NOT allowed). An invalid body MUST be
rejected with HTTP 400 `{ "code": "VALIDATION_ERROR" }` and MUST NOT persist any change.

#### Scenario: Wrong type rejected

- GIVEN a `PUT` body with `intervalMs: "soon"`
- WHEN the request is processed
- THEN the response is HTTP 400 with `{ "code": "VALIDATION_ERROR" }`
- AND the config is unchanged

#### Scenario: Unknown estado code rejected

- GIVEN a `PUT` body with `estados: ["1", "9"]` (`9` is not a valid GR estado)
- WHEN the request is processed
- THEN the response is HTTP 400 with `{ "code": "VALIDATION_ERROR" }`
- AND the config is unchanged

#### Scenario: Non-positive interval rejected

- GIVEN a `PUT` body with `intervalMs: 0`
- WHEN the request is processed
- THEN the response is HTTP 400 with `{ "code": "VALIDATION_ERROR" }`

---

## 4. Sync Status

### REQ-STATUS-1: Returns the existing GR sync status view

`GET /api/gestion-real/sync/status` MUST respond HTTP 200 with the existing `GetGestionRealSyncStatus`
view (`entity`, `cursor`, `lastRunAt`, `lastResult`, `itemsSynced`, `hasRun`, `clientCount`,
`contractCount`). This reuses the existing use-case unchanged; only the route and its RBAC guard are
new.

#### Scenario: Status reflects the mirror state

- GIVEN the GR mirror has run at least once
- WHEN `GET /api/gestion-real/sync/status` is called by a user with `gestionReal:read`
- THEN the response is HTTP 200 with `hasRun = true` and the persisted `lastRunAt` / counts

#### Scenario: Status before any run

- GIVEN the sync has never run (no `gr-clients` SyncState)
- WHEN `GET /api/gestion-real/sync/status` is called
- THEN the response is HTTP 200 with `hasRun = false`, `lastRunAt = null`, `itemsSynced = 0`

---

## 5. RBAC Enforcement

### REQ-RBAC-1: Read endpoints require `gestionReal:read`

`GET /sync/config` and `GET /sync/status` MUST be guarded by `requirePerm('gestionReal', 'read')`. A
user without that permission (and not `super_admin`) MUST receive HTTP 403
`{ "code": "PERMISSION_DENIED" }`. A `super_admin` role short-circuits to allow.

#### Scenario: Read denied without permission

- GIVEN a user with no `gestionReal` permission and no `super_admin` role
- WHEN `GET /api/gestion-real/sync/config` is called
- THEN the response is HTTP 403 with `{ "code": "PERMISSION_DENIED", "module": "gestionReal", "action": "read" }`

#### Scenario: Read allowed with permission

- GIVEN a user granted `gestionReal:read`
- WHEN `GET /api/gestion-real/sync/config` is called
- THEN the response is HTTP 200 with the config DTO

#### Scenario: super_admin short-circuit

- GIVEN a user with the `super_admin` role and NO explicit `gestionReal` permission
- WHEN `GET /api/gestion-real/sync/status` is called
- THEN the response is HTTP 200 (super_admin bypasses the permission lookup)

### REQ-RBAC-2: Write endpoint requires `gestionReal:write`

`PUT /sync/config` MUST be guarded by `requirePerm('gestionReal', 'write')`. A user with only
`gestionReal:read` MUST receive HTTP 403; a user with `gestionReal:write` is allowed.

#### Scenario: Write denied for read-only user

- GIVEN a user granted only `gestionReal:read`
- WHEN `PUT /api/gestion-real/sync/config` with `{ intervalMs: 300000 }` is called
- THEN the response is HTTP 403 with `{ "code": "PERMISSION_DENIED", "module": "gestionReal", "action": "write" }`
- AND the config is unchanged

#### Scenario: Write allowed with write permission

- GIVEN a user granted `gestionReal:write`
- WHEN `PUT /api/gestion-real/sync/config` with `{ intervalMs: 300000 }` is called
- THEN the response is HTTP 200 with `intervalMs = 300000`

---

## 6. Runtime Flag Gates the Sync

### REQ-FLAG-1: `gestion-real-sync` flag gates `SyncGestionRealClients`

`SyncGestionRealClients.execute()` MUST read the `gestion-real-sync` feature flag at the START of each
run. When the flag is absent or `enabled = false`, the use-case MUST be a NO-OP: it MUST NOT call the
GR port (`fetchClients`) and MUST NOT write `gr-clients` SyncState. It returns a zeroed/skipped result.
When the flag is `enabled = true`, the use-case runs the existing sync logic unchanged.

This mirrors `IngestGestionRealOrders`, which reads `gestion-real-ingest` per run so an operator can
flip it via the feature-flags endpoint without a redeploy.

#### Scenario: Flag off → no GR call, no state write

- GIVEN the `gestion-real-sync` flag is `enabled = false`
- WHEN `SyncGestionRealClients.execute()` runs
- THEN the GR port `fetchClients` is NOT called
- AND no `gr-clients` SyncState is written
- AND the result reports zero fetched/created/updated (skipped)

#### Scenario: Flag missing → treated as off

- GIVEN no `gestion-real-sync` flag row exists
- WHEN `SyncGestionRealClients.execute()` runs
- THEN it behaves as flag-off (no GR call, no state write)

#### Scenario: Flag on → runs normally

- GIVEN the `gestion-real-sync` flag is `enabled = true`
- AND the GR port returns one client
- WHEN `SyncGestionRealClients.execute()` runs
- THEN `fetchClients` is called AND the client is upserted AND `gr-clients` SyncState is saved

### REQ-FLAG-2: Flag seeded `true` (behavior-neutral deploy)

The `gestion-real-sync` flag MUST be seeded via an idempotent migration with `enabled = true`
(`ON CONFLICT DO NOTHING`), because the client sync is live in prod today and a `false` default would
silently stop it on deploy.

#### Scenario: Idempotent seed preserves an existing value

- GIVEN a deploy where `gestion-real-sync` already exists (e.g. an operator toggled it)
- WHEN the seed migration runs
- THEN the existing value is preserved (the seed does NOT overwrite it)

---

## 7. Scheduler / Bootstrap Reads DB Config

### REQ-BOOT-1: Bootstrap sources interval and estados from the config repo

`bootstrapGestionRealSync` MUST read `intervalMs` and `estados` from `GestionRealSyncConfigRepository`
(falling back to env defaults via the repo's default record) and build the scheduler + sync use-case
with those values. The read happens ONCE at bootstrap (not per scheduler tick), matching
`bootstrapGestionRealIngest`. `GR_SYNC_ENABLED` remains the boot-time master gate: when false, the
scheduler is not built at all (returns `null`) and the config/flag are irrelevant.

#### Scenario: Bootstrap uses persisted config

- GIVEN a persisted config `{ intervalMs: 300000, estados: ["1","6"] }` AND `GR_SYNC_ENABLED = true` AND GR creds present
- WHEN `bootstrapGestionRealSync()` runs
- THEN the scheduler is built with `intervalMs = 300000`
- AND the `SyncGestionRealClients` use-case is constructed with `estados = ["1","6"]`

#### Scenario: Master gate off → no scheduler

- GIVEN `GR_SYNC_ENABLED = false`
- WHEN `bootstrapGestionRealSync()` runs
- THEN it returns `null` (config and flag are never consulted)

---

> The sections below are ADDED by `gr-sync-config-enhancements` (delta type: Modified). They extend the base
> capability with RBAC-guarded resync-all + reset operations. The base config/status endpoints above are
> unchanged by that change.

---

## 8. Resync-All Endpoint

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

## 9. RBAC Enforcement (resync-all)

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

## 10. Simple Reset Endpoint (kept — clients only, back-compat)

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

## 11. Status Breakdown by Estado (reuse — NO backend delta)

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
