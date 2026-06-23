# Spec: radius-accounting-ingest-scheduler

**Capability**: `radius-accounting-ingest-scheduler`
**Type**: New (scheduler + use case — mirrors existing ingest scheduler pattern)
**Change**: `network-audit-pages`
**Scheduler**: `src/infrastructure/scheduling/RadiusAccountingIngestScheduler.ts`
**Bootstrap**: `src/infrastructure/scheduling/bootstrapRadiusAccountingIngest.ts`
**Use case**: `src/application/use-cases/IngestRadiusAccounting.ts`
**Wiring**: `src/infrastructure/http/app.ts` (minimal — one scheduler registration)

> Pattern reference: `GestionRealIngestScheduler` + `bootstrapGestionRealIngest`. This scheduler
> mirrors that pattern exactly: `setInterval` + `inFlight` guard + `DistributedLock` + feature flag.

---

## 1. Scheduler Structure

### REQ-SCHED-1: Scheduler class follows the established pattern

**Given** the `GestionRealIngestScheduler` as the canonical pattern
**When** `RadiusAccountingIngestScheduler` is implemented
**Then** it MUST have:
- A constructor accepting `(ingest: IngestRadiusAccounting, opts: IngestSchedulerOptions, lock: DistributedLock)`
- A `private inFlight = false` flag
- A `start(): void` method that calls `runOnce()` immediately then sets `setInterval`
- A `stop(): void` method that calls `clearInterval`
- A `runOnce(): Promise<IngestRunSummary>` method (exported for tests)
- Error swallowing on each tick (one bad cycle MUST NOT kill the timer)

#### Scenario: inFlight guard prevents overlapping runs

**Given** `RadiusAccountingIngestScheduler` has started and the current `runOnce()` is still executing
**When** the interval fires again
**Then** the new tick MUST immediately return `{ skipped: true }` without calling `IngestRadiusAccounting.run()`

### REQ-SCHED-2: Distributed lock prevents cross-replica overlap

**Given** two instances of Prominense running (horizontal scaling scenario)
**When** both instances tick at the same time
**Then** only the instance that acquires the `DistributedLock` for key `'radius-accounting-ingest'` SHALL execute `IngestRadiusAccounting.run()`
**And** the other instance MUST skip that tick gracefully (return `{ skipped: true }`)

### REQ-SCHED-3: Lock key is distinct from all other schedulers

**Given** 7 existing schedulers each using a unique lock key
**When** `RadiusAccountingIngestScheduler` is implemented
**Then** the lock key MUST be `'radius-accounting-ingest'` and MUST NOT reuse any existing key

### REQ-SCHED-4: Timer does not prevent Node.js process exit

**Given** the scheduler is started in `app.ts`
**When** the ingest is running normally
**Then** `timer.unref()` MUST be called after `setInterval` so the timer does not keep the event loop alive

---

## 2. Ingest Use Case

### REQ-INGEST-1: `IngestRadiusAccounting` is an application-layer use case

**Given** the hexagonal architecture convention
**When** `IngestRadiusAccounting` is implemented
**Then** it MUST live in `src/application/use-cases/IngestRadiusAccounting.ts`
**And** it MUST depend only on port interfaces: `RadiusOrchestratorGateway`, `RadiusEventRepository`, `DistributedLock`
**And** it MUST NOT import from `@infrastructure/*`

### REQ-INGEST-2: Incremental cursor — reads only new events

**Given** `IngestRadiusAccounting.run()` is called
**When** the use case starts
**Then** it MUST read the cursor (latest `sourceUniqueId` or `startedAt`) from the last successfully persisted `RadiusEvent`
**And** it MUST pass that cursor as a filter to `RadiusOrchestratorGateway.listAccounting()` to request only events newer than the cursor
**And** if no cursor exists (first run), it MUST fetch from the beginning (no `from` filter applied, or `from` = epoch)

#### Scenario: first run with empty table

**Given** the `RadiusEvent` table is empty
**When** `IngestRadiusAccounting.run()` executes
**Then** it MUST call `listAccounting({})` (no cursor filter)
**And** it MUST upsert all returned events
**And** after the run, the cursor MUST be the `startedAt` of the latest persisted event

#### Scenario: incremental run with existing cursor

**Given** the latest `RadiusEvent` has `startedAt = 2026-06-22T10:00:00Z`
**When** `IngestRadiusAccounting.run()` executes
**Then** it MUST call `listAccounting({ from: '2026-06-22T10:00:00Z' })`
**And** MUST NOT re-fetch events already in the table

### REQ-INGEST-3: Upsert is idempotent by `sourceUniqueId`

**Given** an event with `sourceUniqueId = 'abc123'` already exists in `RadiusEvent`
**When** the ingest receives the same event from the orchestrator again
**Then** the upsert MUST update the existing row (e.g. `stoppedAt` may now be set)
**And** MUST NOT create a duplicate row
**And** MUST NOT throw a unique constraint error

#### Scenario: session that was active becomes closed

**Given** `RadiusEvent` has row `{ sourceUniqueId: 'abc123', stoppedAt: null, eventType: 'start' }`
**And** the orchestrator now returns `{ uniqueId: 'abc123', stoppedAt: '2026-06-22T11:30:00Z' }`
**When** the ingest upserts the event
**Then** the existing row MUST be updated: `stoppedAt = 2026-06-22T11:30:00Z`, `eventType = 'stop'`
**And** no new row is created

### REQ-INGEST-4: `nasId` is resolved on ingest

**Given** an incoming `AccountingEvent` with `nasIp = '10.75.0.5'`
**When** the use case processes the event
**Then** it MUST look up the matching `NasServer` by `nasIpAddress = '10.75.0.5'`
**And** if found, `nasId` MUST be set to that `NasServer.id`
**And** if not found, `nasId` MUST be stored as `null` (unresolved — not an error)

### REQ-INGEST-5: Batch page processing

**Given** the orchestrator returns paginated results
**When** the ingest use case runs
**Then** it MUST process page 1, upsert events, then request page 2 (if `hasNext = true`), and continue until `hasNext = false`
**And** each page MUST be committed to the DB before requesting the next page (fail-safe progress)

### REQ-INGEST-6: Orchestrator unreachable is tolerated

**Given** `RadiusOrchestratorGateway.listAccounting()` throws `OrchestratorUnreachableError`
**When** `IngestRadiusAccounting.run()` catches the error
**Then** it MUST log the error and return a result indicating failure
**And** it MUST NOT throw — the scheduler swallows the error and retries on the next tick

---

## 3. Retention / Purge

### REQ-PURGE-1: Purge step runs at the end of each ingest cycle

**Given** `IngestRadiusAccounting.run()` has finished upserting events
**When** the purge step executes
**Then** it MUST delete `RadiusEvent` rows where `startedAt < (now() - retentionMonths)`
**And** `retentionMonths` MUST default to 12
**And** `retentionMonths` MUST be configurable via env var `RADIUS_EVENT_RETENTION_MONTHS`

#### Scenario: default 12-month retention

**Given** `RADIUS_EVENT_RETENTION_MONTHS` is not set
**And** today is 2026-06-22
**When** the purge runs
**Then** rows with `startedAt < 2025-06-22` MUST be deleted
**And** rows with `startedAt >= 2025-06-22` MUST NOT be deleted

#### Scenario: custom 6-month retention

**Given** `RADIUS_EVENT_RETENTION_MONTHS = 6`
**And** today is 2026-06-22
**When** the purge runs
**Then** rows with `startedAt < 2025-12-22` MUST be deleted

### REQ-PURGE-2: Purge uses bounded DELETE (Phase 1)

**Given** Phase 1 does not use PostgreSQL range partitions
**When** the purge runs
**Then** it MUST execute a single `DELETE FROM "RadiusEvent" WHERE "startedAt" < $cutoff`
**And** this is acceptable for Phase 1 volumes; partitioning is deferred to Phase 2 if volume warrants it

### REQ-PURGE-3: Purge failure does not abort the ingest

**Given** the purge DELETE fails (e.g. timeout)
**When** the error is caught
**Then** the ingest run MUST still return a successful result (upserted events are committed)
**And** the purge error MUST be logged but MUST NOT surface to the scheduler as a fatal failure

---

## 4. Bootstrap and Wiring

### REQ-BOOT-1: `bootstrapRadiusAccountingIngest` wires the scheduler

**Given** the bootstrap pattern from `bootstrapGestionRealIngest.ts`
**When** `bootstrapRadiusAccountingIngest` is implemented
**Then** it MUST accept `{ prisma, radiusGateway, lock, intervalMs }` and return a started `RadiusAccountingIngestScheduler`
**And** `intervalMs` MUST default to a configurable value (SHOULD be 5 minutes = 300000 ms)

### REQ-BOOT-2: `app.ts` wiring is minimal

**Given** the known God Object at `src/infrastructure/http/app.ts` (617 lines, flagged as `known_debt`)
**When** the scheduler is registered
**Then** `app.ts` MUST add at most ONE import and ONE call to `bootstrapRadiusAccountingIngest`
**And** it MUST NOT refactor or reorganize existing wiring in `app.ts` (out of scope for this EPIC)

---

## 5. Testing

### REQ-TEST-1: `IngestRadiusAccounting` is testable with in-memory adapters

**Given** `InMemoryRadiusOrchestratorGateway.listAccounting` seeded with `AccountingEvent[]`
**And** an `InMemoryRadiusEventRepository` (upsert + findLatestCursor)
**When** `IngestRadiusAccounting.run()` is called in a unit test
**Then** the events MUST be upserted to the in-memory repository
**And** no HTTP call MUST be made

### REQ-TEST-2: Idempotency is verified in a unit test

**Given** the in-memory repository already contains `sourceUniqueId = 'abc123'`
**And** the in-memory gateway returns the same event again
**When** `IngestRadiusAccounting.run()` runs twice
**Then** the repository MUST contain exactly ONE row with `sourceUniqueId = 'abc123'`

---

## Appendix: Scheduler Options

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `intervalMs` | `number` | 300000 (5 min) | From env `RADIUS_INGEST_INTERVAL_MS` |
| `silent` | `boolean` | `false` | Suppress console in tests |
| `retentionMonths` | `number` | 12 | From env `RADIUS_EVENT_RETENTION_MONTHS` |
