# Spec: radius-event-model

**Capability**: `radius-event-model`
**Type**: Additive (new Prisma model + migration — no existing model modified)
**Change**: `network-audit-pages`
**Schema**: `prisma/schema.prisma`
**Migration**: `prisma/migrations/<timestamp>_radius_event_model/migration.sql`

---

## 1. Prisma Model

### REQ-MODEL-1: `RadiusEvent` model added to schema

**Given** the existing `prisma/schema.prisma`
**When** this migration is applied
**Then** a new model `RadiusEvent` MUST exist with the following fields:

| Field | Prisma type | Nullable | Notes |
|-------|-------------|----------|-------|
| `id` | `String @id @default(uuid())` | No | Primary key |
| `sourceUniqueId` | `String @unique` | No | `acctuniqueid` from RADIUS — idempotency key |
| `username` | `String` | No | PPPoE username |
| `nasIpAddress` | `String` | No | `nasipaddress` from RADIUS |
| `nasId` | `String?` | Yes | FK to `NasServer.id`, resolved on ingest |
| `framedIp` | `String?` | Yes | `framedipaddress` |
| `macAddress` | `String?` | Yes | `callingstationid` (empty → stored as `null`) |
| `vlanId` | `Int?` | Yes | Parsed VLAN integer (orchestrator-side) |
| `startedAt` | `DateTime` | No | `acctstarttime` |
| `stoppedAt` | `DateTime?` | Yes | `acctstoptime`, `null` if session still active |
| `sessionTime` | `Int?` | Yes | `acctsessiontime` in seconds |
| `bytesIn` | `BigInt` | No | `acctinputoctets` (default 0) |
| `bytesOut` | `BigInt` | No | `acctoutputoctets` (default 0) |
| `eventType` | `String` | No | `'start' \| 'stop' \| 'interim'` derived on ingest |
| `createdAt` | `DateTime @default(now())` | No | Row insertion time (not session time) |

**And** the model MUST declare an optional relation to `NasServer`:

```prisma
nas  NasServer? @relation(fields: [nasId], references: [id], onDelete: SetNull)
```

#### Scenario: inserting a closed session event

**Given** a RADIUS `radacct` row with `acctuniqueid = 'abc123'`, `username = 'c001'`, `acctstarttime = '2026-06-22 10:00:00'`, `acctstoptime = '2026-06-22 10:45:00'`
**When** the ingest scheduler upserts the event
**Then** a `RadiusEvent` row with `sourceUniqueId = 'abc123'`, `username = 'c001'`, `startedAt = 2026-06-22T10:00:00Z`, `stoppedAt = 2026-06-22T10:45:00Z`, `eventType = 'stop'` MUST exist

#### Scenario: inserting an active session event

**Given** a RADIUS row with `acctstoptime = null`
**When** the ingest scheduler upserts the event
**Then** a `RadiusEvent` row with `stoppedAt = null`, `eventType = 'start'` MUST exist

### REQ-MODEL-2: `@unique` constraint on `sourceUniqueId`

**Given** a `RadiusEvent` row already exists with `sourceUniqueId = 'abc123'`
**When** the ingest scheduler attempts to insert another row with the same `sourceUniqueId`
**Then** the database MUST enforce a unique constraint violation
**And** the scheduler MUST handle this via `upsert` (not raw insert), making re-runs idempotent

---

## 2. Indexes

### REQ-INDEX-1: Index on `username`

**Given** the `ListRadiusEvents` use case filters by `username`
**When** the migration is applied
**Then** the `RadiusEvent` table MUST have an index: `@@index([username])`

### REQ-INDEX-2: Index on `nasIpAddress`

**Given** the ingest scheduler matches events to `NasServer` by `nasIpAddress`
**And** `ListRadiusEvents` filters by NAS
**When** the migration is applied
**Then** the table MUST have an index: `@@index([nasIpAddress])`

### REQ-INDEX-3: Composite index on `startedAt` and `stoppedAt`

**Given** the query API filters by date range on `startedAt`
**And** the audit page sorts by `startedAt DESC`
**When** the migration is applied
**Then** the table MUST have an index: `@@index([startedAt])` and `@@index([stoppedAt])`

### REQ-INDEX-4: Index on `vlanId`

**Given** the query API accepts a `vlanId` filter
**When** the migration is applied
**Then** the table MUST have an index: `@@index([vlanId])`

### REQ-INDEX-5: Index on `nasId`

**Given** the audit use case scopes events to a specific `NasServer`
**When** the migration is applied
**Then** the table MUST have an index: `@@index([nasId])`

---

## 3. Migration

### REQ-MIGRATION-1: Migration is additive — no existing model is modified

**Given** the existing `NasServer` model (which gets a new relation back-reference)
**When** the migration runs
**Then** it MUST only CREATE the `RadiusEvent` table and ADD the `nasServer` back-reference field
**And** it MUST NOT alter any columns on `NasServer`, `PppoeService`, or any other existing table

### REQ-MIGRATION-2: Migration generated via `prisma migrate dev`

**Given** the schema change to `prisma/schema.prisma`
**When** the migration file is created
**Then** it MUST be generated with `npm run prisma:migrate` (NEVER hand-edited SQL)
**And** the migration timestamp folder MUST follow the existing naming convention

### REQ-MIGRATION-3: `NasServer` back-reference is optional

**Given** `RadiusEvent.nasId` is nullable
**When** Prisma generates the `NasServer` relation
**Then** the back-reference on `NasServer` MUST be: `radiusEvents RadiusEvent[]`
**And** no existing `NasServer` row requires modification

---

## 4. Domain Entity

### REQ-ENTITY-1: `RadiusEvent` domain entity in `src/domain/entities/`

**Given** the hexagonal architecture convention
**When** the model is added
**Then** a TypeScript interface `RadiusEvent` MUST be created in `src/domain/entities/radius-event.ts`
**And** it MUST mirror the Prisma model fields using domain types (no Prisma imports):

```ts
export type RadiusEventType = 'start' | 'stop' | 'interim';

export interface RadiusEvent {
  id: string;
  sourceUniqueId: string;
  username: string;
  nasIpAddress: string;
  nasId: string | null;
  framedIp: string | null;
  macAddress: string | null;
  vlanId: number | null;
  startedAt: string;       // ISO 8601
  stoppedAt: string | null;
  sessionTime: number | null;
  bytesIn: bigint;
  bytesOut: bigint;
  eventType: RadiusEventType;
  createdAt: string;       // ISO 8601
}
```

**And** the entity MUST NOT import from `@infrastructure/*` or `@prisma/client`

---

## 5. Retention Boundary

### REQ-RETENTION-1: `createdAt` is NOT the retention cursor — `startedAt` is

**Given** the purge step targets events older than a configurable window
**When** the purge logic determines which rows to delete
**Then** it MUST use `startedAt < retentionCutoff` (session start date), not `createdAt`
**And** this is important because a batch ingest of old events could otherwise be purged immediately

---

## Appendix: `eventType` Derivation

| Condition | `eventType` |
|-----------|-------------|
| `stoppedAt IS NULL` | `'start'` |
| `stoppedAt IS NOT NULL` | `'stop'` |
| Interim update (orchestrator signals it) | `'interim'` |

> Phase 1 simplification: treat all `stoppedAt IS NULL` as `'start'` and all `stoppedAt IS NOT NULL` as `'stop'`.
> `'interim'` is reserved for Phase 2 if the orchestrator exposes interim records.
