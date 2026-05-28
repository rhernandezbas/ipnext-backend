# Spec: IClass SO Type Catalog

**Capability**: `iclass-so-type-catalog` (NEW)
**Change**: `iclass-so-type-mapping`
**Summary**: A cached catalog of IClass Service Order types, synchronized on demand by an admin endpoint. Types are soft-deleted (`active: false`) when absent from IClass during sync, so that Projects referencing them retain a valid FK. A list endpoint exposes active types for FE consumption.

---

## Overview

The catalog is the backend's local copy of IClass SO types for thirdParty IPNX. It is seeded and updated by a manual sync endpoint (no automatic cron). Because Projects can hold a FK to a catalog entry, removals from IClass side are modeled as soft-deletes: the row persists with `active = false`. The FE dropdown filters to active-only; business logic that already holds an inactive FK continues to work until the Project is explicitly updated.

---

## 1. Domain Model

### REQ-CAT-1: `IClassSoType` entity

The domain MUST expose an `IClassSoType` entity with at minimum:

```ts
interface IClassSoType {
  id: string;
  code: string;          // IClass `codigo`, trimmed — unique identifier
  description: string;   // IClass `descricao`, trimmed
  active: boolean;       // false = no longer present in IClass (soft-delete)
  lastSyncedAt: Date;    // timestamp of last sync that included this entry (not `syncedAt`)
  createdAt: Date;
  updatedAt: Date;
}
```

`code` MUST be unique within the DB (unique constraint on the `IClassSoType` table). 

**Note on `thirdPartyId`**: The catalog is inherently scoped to a single thirdParty (config-driven, from `ICLASS_THIRD_PARTY_ID`). The implementation **does not store** `thirdPartyId` per entry; it is encapsulated in the `IClassClient` constructor. This is consistent with AD-2 (adapter is a "dumb transport" that owns config) and REQ-SYNC-2 (thirdPartyId comes from injected config, not per-call). See design § AD-2 for rationale.

### REQ-CAT-2: `IClassSoTypeRepository` port

The domain MUST define a port:

```ts
interface IClassSoTypeRepository {
  upsertByCode(entry: UpsertIClassSoTypeInput): Promise<{ status: 'created' | 'updated' | 'reactivated' }>;
  markInactiveExcept(presentCodes: string[]): Promise<number>;
  list(filter?: { active?: boolean }): Promise<IClassSoType[]>;
  getById(id: string): Promise<IClassSoType | null>;
  getByCode(code: string): Promise<IClassSoType | null>;
}

interface UpsertIClassSoTypeInput {
  code: string;
  description: string;
}
```

**Implementation notes:**
- `upsertByCode` returns a status object indicating whether the row was created, updated, or reactivated (previously marked `active: false`). This enables the sync use case to report accurate summary counts.
- `markInactiveExcept` takes only `presentCodes` (no thirdPartyId parameter) because the catalog is single-thirdParty, scoped at config-load time. It returns the count of rows marked inactive.
- `list` filter omits `thirdPartyId` for the same reason — the entire table is for one thirdParty.

The Prisma adapter MUST implement this port. An in-memory adapter MUST also be provided for tests.

---

## 2. Sync Use Case

### REQ-SYNC-1: `SyncIClassSoTypes` fetches and upserts all types

**Given** the use case is invoked
**When** `IClassPort.listServiceOrderTypes()` returns N entries
**Then** the use case MUST call `repository.upsertByCode` for each returned entry
**And** the use case MUST call `repository.markInactiveExcept(returnedCodes)` once with the full set of codes from the response
**And** the use case MUST return a summary object containing **at minimum** `{ synced: number; deactivated: number }` (may include additional fields like `created`, `updated`, `reactivated` for transparency)

#### Scenario: Full sync with 3 new types

**Given** the catalog is empty
**And** IClass returns 3 types: `["A", "B", "C"]`
**When** sync runs
**Then** the repository MUST contain 3 active entries
**And** the returned summary MUST be `{ synced: 3, deactivated: 0 }`

#### Scenario: Idempotent re-sync produces the same result

**Given** the catalog already contains `["A", "B", "C"]` all active
**And** IClass returns the same 3 types
**When** sync runs again
**Then** all 3 entries MUST remain active with updated `syncedAt`
**And** the summary MUST be `{ synced: 3, deactivated: 0 }`

#### Scenario: Soft-delete of types no longer in IClass

**Given** the catalog contains active entries `["A", "B", "C"]`
**And** IClass now returns only `["A", "B"]` (C was removed)
**When** sync runs
**Then** entries `A` and `B` MUST be `active: true`
**And** entry `C` MUST be `active: false` (soft-deleted, NOT physically removed)
**And** the summary MUST be `{ synced: 2, deactivated: 1 }`

#### Scenario: Reactivation of a previously soft-deleted entry

**Given** entry `"C"` exists with `active: false`
**And** IClass now returns `["A", "B", "C"]` again
**When** sync runs
**Then** entry `C` MUST have `active: true` after the upsert

### REQ-SYNC-2: Sync is scoped to `thirdPartyId` from config

The `thirdPartyId` is injected into the `IClassClient` at construction time (via `IClassClientOptions.thirdPartyId`) and is used internally by `listServiceOrderTypes()`. The use case calls `IClassPort.listServiceOrderTypes()` without arguments; the adapter handles `thirdPartyId` internally. This respects AD-2 (the adapter owns config, the caller does not pass per-call configuration).

---

## 3. List Use Case

### REQ-LIST-CAT-1: `ListIClassSoTypes` returns filtered results

**Given** the catalog contains 3 active and 2 inactive entries
**When** `ListIClassSoTypes` is called with `{ active: true }`
**Then** it MUST return exactly 3 entries, all with `active: true`

**Given** the same catalog
**When** called with no filter
**Then** it MUST return all 5 entries

---

## 4. HTTP Endpoints

### REQ-HTTP-SYNC-1: `POST /api/admin/iclass/so-types/sync` triggers sync

**Given** an authenticated admin request to `POST /api/admin/iclass/so-types/sync`
**When** the sync completes successfully
**Then** the response MUST be HTTP 200
**And** the body MUST contain **at minimum** `{ synced: number, deactivated: number }` (may include additional transparency fields)

#### Scenario: Sync returns summary counts

**Given** IClass returns 26 types and 2 previous entries were removed
**When** the endpoint is called
**Then** the response MUST include `synced: 26` and `deactivated: 2` (may also include `created`, `updated`, `reactivated` for transparency)

### REQ-HTTP-SYNC-2: `POST /api/admin/iclass/so-types/sync` requires admin auth

**Given** an unauthenticated request to `POST /api/admin/iclass/so-types/sync`
**When** processed
**Then** the server MUST respond HTTP 401 with `{ code: "UNAUTHORIZED" }`

### REQ-HTTP-LIST-1: `GET /api/admin/iclass/so-types` supports `?active=true` filter

**Given** an authenticated admin request to `GET /api/admin/iclass/so-types?active=true`
**When** processed
**Then** the server MUST respond HTTP 200
**And** the body MUST be `{ items: [...] }` where `items` is an array of `IClassSoType` objects with every entry having `active: true`

**Given** a request to `GET /api/admin/iclass/so-types` (no filter)
**When** processed
**Then** the body MUST be `{ items: [...] }` containing all entries (active and inactive)

### REQ-HTTP-LIST-2: `GET /api/admin/iclass/so-types` requires admin auth

**Given** an unauthenticated request
**When** processed
**Then** the server MUST respond HTTP 401 with `{ code: "UNAUTHORIZED" }`

---

## 5. Response Shape

### REQ-SHAPE-CAT-1: `IClassSoType` response object

Every `IClassSoType` returned by any endpoint MUST include:

| Field | Type | Nullable |
|-------|------|----------|
| `id` | `string` | No |
| `code` | `string` | No |
| `description` | `string` | No |
| `active` | `boolean` | No |
| `lastSyncedAt` | `string (ISO 8601)` | No |
| `createdAt` | `string (ISO 8601)` | No |
| `updatedAt` | `string (ISO 8601)` | No |

**Note**: `thirdPartyId` is NOT returned in responses because the catalog is single-thirdParty, configured at the adapter level. This is consistent with REQ-SYNC-2 (thirdPartyId is config-driven, not per-entry).

---

## Appendix: Error Contracts

| Scenario | HTTP | `code` |
|----------|------|--------|
| Unauthenticated | 401 | `UNAUTHORIZED` |
| IClass unavailable during sync | 502 | `ICLASS_UNAVAILABLE` |
