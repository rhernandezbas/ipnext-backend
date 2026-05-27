# Design — scheduledtask-deprecated-cleanup

## Technical Approach

This is a debt-removal change, not a feature. The hard part is not the code — it is sequencing so that PROD data and a live frontend never observe a missing field. We use **expand/contract** (a.k.a. parallel-change). The "expand" half (new columns + the `scheduling-tasks-enrich` / `scheduling-foundation-stage-model` migrations) already shipped. This change completes the cycle: finish the expand (backfill the FKs that were never backfilled), then contract (stop writing, stop reading, drop).

The deprecated fields fall into three risk tiers, and the strategy differs per tier:

- **Tier A — `status` (derived, not stored read path)**. `status` is no longer a source of truth: `stageId` is. Both adapters DERIVE `status` from the stage on read (`PrismaSchedulingRepository.deriveLegacyStatus`, `InMemorySchedulingRepository.deriveLegacyStatus`). The physical `status` column still exists but is never read by the derivation. Dropping it is purely: stop deriving, remove from DTO/entity, drop column + `@@index([status])`. Lowest risk. The only consumer is the frontend dashboard, which must switch to `stageCategory`.
- **Tier B — `scheduledDate` / `scheduledTime` (already backfilled)**. The `scheduling-tasks-enrich` migration ran a `DO $$` block that parsed `scheduledDate`+`scheduledTime` into `startDate`/`endDate` for every row where `startDate` was null. So `startDate` coverage already exists. We RE-VERIFY (audit query) rather than trust, then drop + remove the `@@index([scheduledDate])`. The fallback read in `toTask` simply exposes the columns; no derivation depends on them. Medium-low risk.
- **Tier C — `clientId`/`clientName` and `assignedTo`/`assignedToId` (NEVER backfilled)**. There is **no migration** that copied `clientId`→`customerId` or `assignedToId`→`assigneeId`. The only thing bridging them is the RUNTIME fallback in `toTask` (`row.customer?.name ?? row.clientName`). If we drop the legacy columns without backfilling the FKs, any row created before the FK era — or via the legacy write path — loses its client/assignee linkage. Highest risk. Requires a real backfill migration in Phase 1.

## Architecture Decisions

### AD-1 — Expand/contract over big-bang drop

**Choice**: Four ordered phases, each independently deployable. Drop column is the LAST step, in its own migration, after both backend and frontend have stopped reading the column.

**Alternatives**:
- Big-bang: one PR that backfills, removes code, and drops columns. Rejected — couples a destructive DDL to a frontend that may not have deployed yet; no safe rollback window.
- Soft-delete the columns (rename to `_deprecated_*`). Rejected — keeps the noise, doesn't pay the debt, just renames it.

**Rationale**: The repo already uses parallel-change for `scheduling-tasks-enrich` ("retained as deprecated read-only for one release"). This change is the deferred contraction half. Each deploy is reversible until Phase 4.

### AD-2 — Backfill `customerId`/`assigneeId` via forward-only idempotent migration

**Choice**: A Phase-1 migration with a guarded UPDATE:

```sql
UPDATE "ScheduledTask"
SET "customerId" = "clientId"
WHERE "customerId" IS NULL AND "clientId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Client" c WHERE c."id" = "ScheduledTask"."clientId");

UPDATE "ScheduledTask"
SET "assigneeId" = "assignedToId"
WHERE "assigneeId" IS NULL AND "assignedToId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Admin" a WHERE a."id" = "ScheduledTask"."assignedToId");
```

**Why the EXISTS guard**: `customerId`/`assigneeId` are FKs (`ON DELETE SET NULL` against `Client`/`Admin`). Copying a `clientId` that no longer references a live `Client` would violate the FK and abort the migration on container boot. The guard skips dangling legacy values (they were already orphaned).

**`assignedTo` (free text) — best-effort name match**: separate, lower-confidence UPDATE that only fires for rows still lacking `assigneeId`:

```sql
UPDATE "ScheduledTask" t
SET "assigneeId" = a."id"
FROM "Admin" a
WHERE t."assigneeId" IS NULL
  AND t."assignedTo" IS NOT NULL
  AND LOWER(TRIM(a."name")) = LOWER(TRIM(t."assignedTo"));
```

Unmatched `assignedTo` free-text values are NOT recoverable as an FK — documented as accepted loss (these were already unstructured strings, never a real assignee link).

**Audit before drop**: Phase 1 also emits a NOTICE with the count of rows where a legacy column is populated but the new FK is still null after backfill — the gate for proceeding to Phase 4.

### AD-3 — `status` removal: stop deriving, not "stop storing"

**Choice**: Remove `deriveLegacyStatus` from both adapters and the `status` field from the entity + DTO in Phase 3. The `status` COLUMN is dropped in Phase 4.

**Rationale**: `status` is already derived on read from `stageId`+stage name. There is no write path that the derivation depends on, so removing the derivation is safe the moment the frontend stops reading `task.status`. The frontend already has `stageCategory` (`'nuevo' | 'enProgreso' | 'hecho'`) exposed on every task; the dashboard's `status === 'in_progress'` / `'completed'` filters map to `stageCategory === 'enProgreso'` / `'hecho'`.

### AD-4 — Keep the NEW names; no cosmetic rename

**Choice**: `customerId`/`assigneeId`/`startDate` stay as-is. We do not rename them back to `clientId`/`assignedTo`/`scheduledDate`.

**Rationale**: The new names are the intended end state (FKs + datetime). A rename would be a second migration with its own coordination cost for zero functional gain.

### AD-5 — Two migrations, not one

**Choice**: `..._scheduledtask_backfill_fks` (Phase 1, additive data) and `..._scheduledtask_drop_deprecated` (Phase 4, destructive DDL) are SEPARATE migration directories, deployed in different releases.

**Rationale**: `migrate deploy` runs all pending migrations on container boot. If backfill and drop were in one migration, the very first deploy after merge would drop the columns immediately — defeating the safe window and racing the frontend. Splitting them lets Phase 1 ship and bake while the frontend catches up; Phase 4 ships only after the frontend PR is live.

### AD-6 — Frontend lockstep (stop-read before drop)

**Choice**: Backend Phase 3 (stop reading legacy fields, remove from DTO) and the frontend's stop-reading change land in the SAME release window; backend Phase 4 (DROP) lands strictly AFTER.

**Rationale**: Mirrors the `scheduling-checklists` lockstep contract. The DTO removal of `status`/`scheduledDate`/`clientName`/`assignedTo` makes those fields disappear from the API response. If the frontend still reads `task.scheduledDate` it gets `undefined` — the calendar fallback (`new Date(\`${task.scheduledDate}T...\`)`) would produce `Invalid Date`. So the frontend must drop its fallbacks first or simultaneously.

## Frontend Coordination Contract

The frontend reads deprecated fields in exactly these places (verified in `ipnext-frontend/src`):

| File:line | Legacy read | Replacement |
|-----------|-------------|-------------|
| `SchedulingDashboardPage.tsx:40-41` | `t.status === 'in_progress' / 'completed'` | `t.stageCategory === 'enProgreso' / 'hecho'` |
| `SchedulingDashboardPage.tsx:45` | sort by `scheduledDate` | sort by `startDate` |
| `SchedulingCalendarPage/index.tsx:51-52` | `task.scheduledDate` + `scheduledTime` → Date | `task.startDate` (already ISO) |
| `SchedulingCalendarPage/index.tsx:66` | `task.clientName` fallback | `task.customerName` |
| `KanbanCard.tsx:44-45` | `task.clientName` fallback | `task.customerName` |
| `types/scheduling.ts:64-79` | declares all 6 legacy fields | remove |

These changes are mechanical and must merge before backend Phase 4.

## Migration Plan (hand-written SQL — applied via `migrate deploy`)

### Phase 1 — `<ts>_scheduledtask_backfill_fks/migration.sql`

```sql
-- Phase 1: complete the expand. Backfill customerId/assigneeId from legacy
-- columns. Forward-only, idempotent (WHERE new FK IS NULL). No DROP here.

-- customerId <- clientId (only if the referenced Client still exists)
UPDATE "ScheduledTask" t
SET "customerId" = t."clientId"
WHERE t."customerId" IS NULL
  AND t."clientId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Client" c WHERE c."id" = t."clientId");

-- assigneeId <- assignedToId (only if the referenced Admin still exists)
UPDATE "ScheduledTask" t
SET "assigneeId" = t."assignedToId"
WHERE t."assigneeId" IS NULL
  AND t."assignedToId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Admin" a WHERE a."id" = t."assignedToId");

-- assigneeId <- assignedTo (free text, best-effort name match)
UPDATE "ScheduledTask" t
SET "assigneeId" = a."id"
FROM "Admin" a
WHERE t."assigneeId" IS NULL
  AND t."assignedTo" IS NOT NULL
  AND LOWER(TRIM(a."name")) = LOWER(TRIM(t."assignedTo"));

-- Audit: report rows that still have legacy data but no new FK (Phase 4 gate)
DO $$
DECLARE orphan_clients INT; orphan_assignees INT;
BEGIN
  SELECT COUNT(*) INTO orphan_clients
  FROM "ScheduledTask"
  WHERE "customerId" IS NULL AND "clientId" IS NOT NULL;

  SELECT COUNT(*) INTO orphan_assignees
  FROM "ScheduledTask"
  WHERE "assigneeId" IS NULL AND ("assignedToId" IS NOT NULL OR "assignedTo" IS NOT NULL);

  RAISE NOTICE 'scheduledtask-backfill: % rows with clientId but no customerId; % rows with legacy assignee but no assigneeId',
    orphan_clients, orphan_assignees;
END $$;
```

### Phase 4 — `<ts>_scheduledtask_drop_deprecated/migration.sql`

```sql
-- Phase 4: contract. Drop deprecated columns + stale indexes.
-- DESTRUCTIVE. Take a DB snapshot before applying in PROD.

DROP INDEX IF EXISTS "ScheduledTask_status_idx";
DROP INDEX IF EXISTS "ScheduledTask_scheduledDate_idx";

ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "status";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "scheduledDate";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "scheduledTime";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "clientId";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "clientName";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "assignedTo";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "assignedToId";
```

### Down SQL (manual rollback for Phase 4 — schema only, data NOT recoverable)

```sql
ALTER TABLE "ScheduledTask" ADD COLUMN "status"        TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "ScheduledTask" ADD COLUMN "scheduledDate" TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "scheduledTime" TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "clientId"      TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "clientName"    TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "assignedTo"    TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "assignedToId"  TEXT;
CREATE INDEX "ScheduledTask_status_idx"        ON "ScheduledTask"("status");
CREATE INDEX "ScheduledTask_scheduledDate_idx" ON "ScheduledTask"("scheduledDate");
```

## Code Change Map

| File | Phase | Action |
|------|-------|--------|
| `prisma/migrations/<ts>_scheduledtask_backfill_fks/migration.sql` | 1 | new — backfill + audit |
| `src/application/dto/scheduling.dto.ts` | 2 | remove legacy input fields from `CreateTaskBaseSchema` |
| `src/infrastructure/http/routes/scheduling.routes.ts` | 2 | remove legacy fields from `normalized`/create mapping |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | 2 | remove legacy keys from `_buildCreateData`/`_buildUpdateData` |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | 2 | remove legacy keys from create/update |
| `src/domain/entities/scheduling.ts` | 3 | remove `status`, `TaskStatus`, `assignedTo`, `assignedToId`, `clientId`, `clientName`, `scheduledDate`, `scheduledTime` |
| `src/application/dto/scheduling.dto.ts` | 3 | remove `TaskStatusSchema`, `UpdateStatusSchema` |
| `src/application/use-cases/UpdateTaskStatus.ts` | 3 | delete file |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | 3 | remove `deriveLegacyStatus`, `clientName`/`assignedTo` fallbacks, `status` from `toTask` |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | 3 | remove `deriveLegacyStatus`, `status` from task shape |
| `src/infrastructure/http/routes/scheduling.routes.ts` | 3 | remove `PATCH /:id/status` route + `UpdateStatusSchema` import |
| `src/infrastructure/http/app.ts` | 3 | remove `UpdateTaskStatus` instantiation + injection ⚠ |
| `prisma/schema.prisma` | 4 | drop 6 columns + `@@index([status])`, `@@index([scheduledDate])` |
| `prisma/migrations/<ts>_scheduledtask_drop_deprecated/migration.sql` | 4 | new — drop DDL |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | 2-3 | drop assertions on legacy fields + status route |
| `src/__tests__/infrastructure/scheduling.routes.filter.test.ts` | 2-3 | adapt fixtures |
| `src/__tests__/infrastructure/scheduling-composition.test.ts` | 3 | assert `PATCH /:id/status` is gone |
| `src/__tests__/application/dto/scheduling.dto.test.ts` | 2-3 | drop legacy field / status schema cases |

## Testing Strategy (STRICT TDD per phase)

| Phase | Test focus | Type |
|-------|-----------|------|
| 1 | Backfill SQL on a seeded fixture DB: task with `clientId` only → `customerId` populated; task with dangling `clientId` → left null; `assignedTo` name match. Run via a throwaway integration script or PrismaScheduling integration test. | Integration |
| 2 | `CreateTaskSchema.safeParse({ ...legacyField })` now strips/rejects legacy fields; create task does not persist them | Unit (zod) + adapter unit (InMemory) |
| 2 | Route create/update: legacy field in body is ignored, response unaffected | supertest |
| 3 | `toTask`/`makeTask` no longer expose `status`/`clientName`/`assignedTo`; `customerName` comes only from JOIN | Unit (InMemory + Prisma mapper test) |
| 3 | `PATCH /api/scheduling/:id/status` returns 404 and does NOT shadow `GET /:id` | supertest (composition) |
| 3 | `tsc --noEmit` green after entity/DTO field removal (compile-driven coverage) | type check |
| 4 | Post-drop: full scheduling route suite green against a migrated DB | Integration |

## Open Questions

1. **PROD row counts**: how many `ScheduledTask` rows currently have `clientId` set but `customerId` null, and `assignedTo` free text? The Phase-1 audit NOTICE answers this; Phase 4 is gated on it being 0 (or an accepted residue for unmatchable free-text `assignedTo`).
2. **Is `PATCH /:id/status` still called by any external integration?** Grep of frontend shows no caller; confirm no third-party hits it before removal (deprecated route already warns in logs).
