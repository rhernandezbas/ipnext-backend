# Spec — gestion-real-ingest-config

**Capability**: `gestion-real-ingest-config`
**Type**: New (full capability — no prior spec exists)
**Change**: `gestion-real-installation-ingest`
**Layer**: Domain port + Application use-cases + Infrastructure routes
**Routes**: `GET /api/gestion-real-ingest/config`, `PUT /api/gestion-real-ingest/config`,
`GET /api/gestion-real-ingest/status`, `GET /api/gestion-real-ingest/needs-review`

---

## Purpose

Provide a typed, editable config store for the ingest engine plus read endpoints the future
"Gestión Real" FE subpage consumes. Config controls whether the ingest runs, how often, and which
local `Project` each technology maps to. All endpoints return DTOs, never raw Prisma entities. Use
cases depend only on ports.

---

## 1. Config Store Shape

### REQ-CFG-1: Single typed config record

The system MUST persist a single config record with the fields below. Project mappings MUST be
real FKs to `Project` (NOT free-text names) because destination projects live in prod and may be
renamed. Both project FKs are nullable.

| Field | Type | Nullable | Meaning |
|-------|------|----------|---------|
| `enabled` | `boolean` | No | Master on/off for the ingest |
| `intervalMs` | `number` (int) | No | Scheduler tick interval |
| `fiberProjectId` | `string` (FK→Project) | Yes | Target project for FIBER tasks |
| `wirelessProjectId` | `string` (FK→Project) | Yes | Target project for WIRELESS tasks |
| `windowMonths` | `number` (int) | No | Date-window depth (`fechaDesde` = now − N months) |

#### Scenario: First read returns defaults when no record exists

- GIVEN no config record has been persisted yet
- WHEN the config is read
- THEN a default record is returned (`enabled = false`, sensible default `intervalMs`/`windowMonths`, project FKs `null`)

---

## 2. GET Config

### REQ-GETCFG-1: Returns the current config as a DTO

`GET /api/gestion-real-ingest/config` MUST respond HTTP 200 with a config DTO containing
`enabled`, `intervalMs`, `fiberProjectId`, `wirelessProjectId`, and `windowMonths`. It MUST NOT
return a raw Prisma entity.

#### Scenario: Read current config

- GIVEN a persisted config `{ enabled: true, intervalMs: 180000, fiberProjectId: "p-fiber", wirelessProjectId: "p-wifi", windowMonths: 12 }`
- WHEN `GET /api/gestion-real-ingest/config` is called
- THEN the response is HTTP 200 with those fields as a DTO

---

## 3. Update Config

### REQ-PUTCFG-1: Updates enabled / interval / project mapping

`PUT /api/gestion-real-ingest/config` MUST accept a validated body and update the persisted config,
responding HTTP 200 with the updated config DTO. It MUST allow changing `enabled`, `intervalMs`,
`fiberProjectId`, `wirelessProjectId`, and `windowMonths`.

#### Scenario: Update changes the target project

- GIVEN config `fiberProjectId = "p-old"`
- WHEN `PUT /api/gestion-real-ingest/config` with `{ fiberProjectId: "p-new" }`
- THEN the response is HTTP 200 with `fiberProjectId = "p-new"`
- AND a subsequent ingest of a FIBER order targets `p-new`

#### Scenario: Invalid body is rejected

- GIVEN a `PUT` body with `intervalMs: "soon"` (wrong type)
- WHEN the request is processed
- THEN the response is HTTP 400 with `{ "code": "VALIDATION_ERROR" }`

### REQ-PUTCFG-2: Project FK must reference an existing Project

When `fiberProjectId` or `wirelessProjectId` is provided non-null, it MUST reference an existing
`Project`. A non-existent project FK MUST be rejected with HTTP 404 and MUST NOT persist the change.

#### Scenario: Non-existent project FK rejected

- GIVEN no `Project` with id `"ghost"`
- WHEN `PUT /api/gestion-real-ingest/config` with `{ wirelessProjectId: "ghost" }`
- THEN the response is HTTP 404 with `{ "code": "PROJECT_NOT_FOUND" }`
- AND the config is unchanged

#### Scenario: Clearing a mapping with null is allowed

- GIVEN config `wirelessProjectId = "p-wifi"`
- WHEN `PUT` with `{ wirelessProjectId: null }`
- THEN the response is HTTP 200 with `wirelessProjectId = null` (no project lookup performed)

---

## 4. Sync Status

### REQ-STATUS-1: Returns last run time and run counts

`GET /api/gestion-real-ingest/status` MUST respond HTTP 200 with a DTO containing the last run
timestamp and the counts from that run: `created`, `skippedDuplicate`, `skippedUnmirrored`, and
`unclassified`.

#### Scenario: Status reflects the last run

- GIVEN the last ingest created 5 tasks, skipped 2 duplicates, skipped 1 unmirrored, and flagged 3 unclassified
- WHEN `GET /api/gestion-real-ingest/status` is called
- THEN the response is HTTP 200 with `{ lastRunAt, created: 5, skippedDuplicate: 2, skippedUnmirrored: 1, unclassified: 3 }`

#### Scenario: Status before any run

- GIVEN the ingest has never run
- WHEN `GET /api/gestion-real-ingest/status` is called
- THEN the response is HTTP 200 with `lastRunAt = null` and all counts `0`

---

## 5. Needs-Review List

### REQ-REVIEW-1: Lists unclassified needs-review tasks

`GET /api/gestion-real-ingest/needs-review` MUST respond HTTP 200 with an array of the
needs-review `ScheduledTask` DTOs — those created by the ingest with `projectId = null` and the
`[REVISAR - Logística]` title prefix.

#### Scenario: Returns only needs-review tasks

- GIVEN one needs-review task (no project, REVISAR prefix) and one normal fiber task (with project)
- WHEN `GET /api/gestion-real-ingest/needs-review` is called
- THEN the response is HTTP 200 with an array of exactly one task (the needs-review one)

#### Scenario: Empty when nothing needs review

- GIVEN no needs-review tasks exist
- WHEN `GET /api/gestion-real-ingest/needs-review` is called
- THEN the response is HTTP 200 with an empty array `[]`
