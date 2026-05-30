# Design: Scheduling Tasks Enrich

## Technical Approach

We extend the `ScheduledTask` Prisma model with two datetime columns (`startDate`, `endDate`), five FK columns (`customerId`, `serviceId`, `partnerId`, `reporterId`, `assigneeId`), two integer columns (`travelTimeTo`, `travelTimeFrom`), and a `TaskWatcher` pivot table for the watchers M:N relation. Legacy denormalized columns (`scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`, `status`) are retained as deprecated read-only for one release — same pattern as change 1's `status` column. The domain entity grows accordingly, the port input types widen (no new methods), and the two existing use cases (`CreateTask`, `UpdateTask`) gain deterministic FK validation. The Prisma adapter's `INCLUDE` adds JOINs for the new relations and derives `customerName`/`assigneeName` from the joined rows; watcher writes happen inside a transaction (scalar update + `TaskWatcher.deleteMany` + `TaskWatcher.createMany`) when `watcherIds` is present. The HTTP route file gains a `REFERENCE_TO_CODE` map to translate `ReferenceNotFoundError.kind` to the right HTTP `code`. The migration is **schema-additive + data-additive**: a `DO $$ ... $$` block parses the legacy `scheduledDate || 'T' || scheduledTime` strings into `startDate` and sets `endDate = startDate + (estimatedHours * INTERVAL '1 hour')` for legacy rows; on parse failure a NOTICE is logged and the row's new columns remain NULL.

## Architecture Decisions

### AD-1: Legacy columns are retained as deprecated for one release (mirrors change 1)

The columns `scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`, `status` are NOT dropped. Reasoning:

- **Cheap rollback.** A `git revert` of the merge commit must keep working without a DB roll-back. The legacy code path still reads/writes these columns.
- **Migration safety.** If the data backfill misses rows (unparseable strings), the legacy values remain available for manual reconciliation.
- **Consistency.** Change 1 used the same pattern for `status` — future maintainers see one deprecation policy across the scheduling domain.

**Trade-off**: ≈80 bytes of payload bloat per task for one release. Trivial. A dedicated cleanup change will drop the columns once all consumers have migrated.

### AD-2: Data migration parses `scheduledDate + scheduledTime` best-effort; logs NOTICE on failure

The migration's `DO $$ ... $$` block iterates rows where `startDate IS NULL AND scheduledDate IS NOT NULL`. Each row:

1. Build a candidate ISO string: `scheduledDate || 'T' || COALESCE(scheduledTime, '00:00') || ':00'`.
2. Attempt `startDate := candidate::timestamp` inside a per-row `BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE NOTICE` block.
3. On success, also set `endDate := startDate + (estimatedHours * INTERVAL '1 hour')`.
4. On failure, leave both NULL and emit `RAISE NOTICE 'scheduling-tasks-enrich: could not parse startDate for task %', task_id`.

Alternatives considered:

- **Fail the whole migration on the first parse error.** Rejected — production may have one bad row from a manual SQL fix, and we don't want to wedge the deploy.
- **Pre-clean the data manually before migrating.** Rejected — discovery would be slower than letting Postgres tell us.
- **Use a TypeScript script + Prisma client to do the backfill outside the migration.** Rejected — splits the deploy across two steps and breaks the "one migration applies cleanly" property required for fresh DBs.

The choice keeps the migration atomic AND tolerant.

### AD-3: `endDate` for legacy rows defaults to `startDate + estimatedHours` (NOT NULL)

Two options for legacy rows once `startDate` is parsed:

- **(A) `endDate = startDate + (estimatedHours * INTERVAL '1 hour')`** — gives the API a complete temporal envelope immediately.
- **(B) Leave `endDate` NULL and let users fill it in.**

**Decision**: ship (A). Justification: Splynx (and the change-4 task detail page) display the end time as a first-class field. NULL would be a worse UX than a derived value that's almost-certainly correct (`estimatedHours` is the field operators have been entering all along).

Trade-off: if `estimatedHours` was wrong, the derived `endDate` is wrong too. Acceptable — users can edit the field. The data isn't load-bearing for billing.

### AD-4: Replace-set semantics for `watcherIds` mirrors `ProjectPartner` from change 2

`UPDATE /api/scheduling/:id { watcherIds: [...] }` follows the exact same contract as `PUT /api/projects/:id { partnerIds: [...] }`:

- Field PRESENT → the array is authoritative; we `deleteMany` then `createMany` inside a transaction.
- Field OMITTED → the existing set is untouched.
- Field PRESENT, empty array → the set is cleared.

Alternatives rejected:

- **Sub-resource routes** (`POST /api/scheduling/:id/watchers`, `DELETE .../watchers/:adminId`) — multiplies URLs by 2× without adding capability. Splynx's UI sends the whole task at once anyway.
- **Append-only semantics** — confusing: how does the user remove a watcher? Forces a parallel `removeWatcher` route.

Trade-off: a partial array silently drops watchers not included. Documented in REQ-WATCHER-1 and in the frontend coordination notes.

### AD-5: Priority enum stays `low/normal/high/urgent` — Splynx labels are presentation-only

Splynx's UI uses `Baja/Media/Alta`. The temptation is to align. We reject:

- The consolidated spec already locked `low/normal/high/urgent` in `REQ-VAL-1`. Changing it ripples into every existing consumer.
- The Splynx labels are Spanish display strings, not a value set. The frontend can map `low → Baja`, `normal → Media`, etc. — one i18n dictionary, no backend churn.
- Splynx's set is 3 values (Baja/Media/Alta); ours is 4 (low/normal/high/urgent). Collapsing loses information.

**Decision**: backend enum unchanged. Frontend handles the label mapping. Documented for future-us so nobody re-litigates this.

### AD-6: `description` accepts HTML; server does NOT sanitize

We accept any string (including HTML) in `description` and store/return it byte-identical. We do NOT:

- Sanitize on write (e.g. via DOMPurify-server, sanitize-html).
- Wrap plain text in `<p>` tags.
- Validate the HTML at all (beyond `z.string().nullable().optional()`).

Reasoning:

- **Single source of truth for sanitization.** The backend cannot know how the frontend will render the value (raw HTML? plain text mode? markdown-converted?). Forcing a sanitization policy here locks in a contract that doesn't survive renderer changes.
- **Composability.** Other consumers (an admin email, a PDF export) may want the raw HTML and apply different sanitization.
- **Defense-in-depth lives at the rendering layer.** Frontend MUST use DOMPurify (or equivalent). Coordination notes call this out.

Trade-off: a misbehaving frontend can introduce XSS. Mitigation: this is documented in REQ-RICH-DESC-1 as a non-goal and the frontend coordination explicitly requires DOMPurify. If we ever expose a non-Web consumer that renders HTML without sanitization, that consumer takes responsibility.

### AD-7: `assigneeId` FK replaces the denormalized `assignedTo`/`assignedToId` pair

Today `assignedTo: string?` carries the display name and `assignedToId: string?` carries the admin id — two fields that must be kept in sync by the writer. We promote to a single `assigneeId String? FK Admin`. The display name comes from the JOIN at read time (`assigneeName`).

Alternatives:

- **Keep the denormalized pair and add `assigneeId` alongside.** Rejected — three fields for one concept is worse.
- **Drop the legacy pair immediately.** Rejected — breaks the deprecation pattern from change 1.

**Decision**: add `assigneeId` (FK), keep the legacy pair as deprecated. The mapper populates `assigneeName` from the JOIN; if `assigneeId` is NULL but the legacy `assignedTo` is set, the mapper returns the legacy value (read-only fallback during deprecation). Writes always go through `assigneeId`.

### AD-8: `customerName` is derived from JOIN, not stored

Same shape as AD-7 for the customer relation. `customerId` is the FK; `customerName` is computed at read time from `Client.name`. The legacy `clientId`/`clientName` columns remain populated for the deprecation window. The mapper prefers the JOIN value over the legacy column when both are set.

### AD-9: FK validation order is deterministic and documented

The use cases (`CreateTask`, `UpdateTask`) validate FK existence in this exact order:

1. `customerId`
2. `serviceId`
3. `partnerId`
4. `reporterId`
5. `assigneeId`
6. `watcherIds[*]` (in array order)

The first missing reference throws `ReferenceNotFoundError(kind, id)`. Tests assert that when multiple references are missing, the error reflects the FIRST in this order (REQ-FK-ORDER-1).

Reasoning:

- **Determinism enables testable error UX.** Non-deterministic order means flaky tests AND inconsistent error messages for users.
- **Cheap-first order.** Customer/service/partner are entity-level FKs; watchers are an array — checking them last avoids paying for the array walk when an earlier FK already fails.

### AD-10: Watchers table uses `Cascade` on Admin delete (NOT `Restrict`)

Compare to change 2's `ProjectPartner`, where partner deletion is `Restrict` (partners are master data). For `TaskWatcher`:

- Watchers are pure join rows with no independent business meaning — they're "this admin is interested in this task".
- If an admin is deleted, the watcher row is meaningless.
- `Restrict` would prevent admin deletion across the system whenever the admin watches any task — operationally painful.

**Decision**: `TaskWatcher.adminId` `ON DELETE Cascade`. `TaskWatcher.taskId` likewise `Cascade` (deleting the task removes the watcher rows).

## Data Flow

```
Client → POST /api/scheduling { title, customerId, assigneeId, watcherIds: [...], startDate, endDate, ... }
         │
         ▼
      auth middleware ──── 401 if no/bad cookie ──── done
         │
         ▼
      zod safeParse  ──── 400 VALIDATION_ERROR ──── done
                       (catches: malformed datetime, endDate<startDate, negative travel time, missing required)
         │
         ▼
   CreateTask use case (deterministic FK validation)
         │
         ├── customerRepo.findById(customerId)    ──── null → throw ReferenceNotFoundError('customer')
         ├── serviceRepo.findById(serviceId)      ──── null → throw …('service')
         ├── partnerRepo.findById(partnerId)      ──── null → throw …('partner')
         ├── adminRepo.findById(reporterId)       ──── null → throw …('reporter')
         ├── adminRepo.findById(assigneeId)       ──── null → throw …('assignee')
         ├── for w in watcherIds: adminRepo.findById(w)  ──── null → throw …('watcher')
         │
         ▼
   schedulingRepo.createTask(input)            (transaction: insert ScheduledTask + insertMany TaskWatchers)
         │
         ▼
   route → 201 + body (with customerName/assigneeName resolved via JOIN)
```

`PUT /:id` follows the same flow with conditional FK lookups (skip the check for FKs not present in the body). Catch block translates `ReferenceNotFoundError.kind` via `REFERENCE_TO_CODE`.

## File Changes

| File | Action | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | Modified | Add 9 columns + 5 FKs to `ScheduledTask`; new `TaskWatcher` model; add back-relations on `Client/Service/Partner/Admin` |
| `prisma/migrations/<ts>_scheduling_tasks_enrich/migration.sql` | New | DDL + `DO $$ ... $$` datetime backfill |
| `src/domain/entities/scheduling.ts` | Modified | Add `startDate/endDate/customerId/customerName/serviceId/partnerId/reporterId/assigneeId/assigneeName/watcherIds/travelTimeTo/travelTimeFrom`; mark legacy fields `@deprecated` |
| `src/domain/ports/SchedulingRepository.ts` | Modified | Widen `createTask`/`updateTask` input types |
| `src/domain/errors/scheduling.ts` | Modified | Add `ReferenceNotFoundError { kind: 'customer'\|'service'\|'partner'\|'reporter'\|'assignee'\|'watcher', id: string }` |
| `src/application/dto/scheduling.dto.ts` | Modified | Add new fields; `endDateAfterStart` superRefine; deprecated fields stay optional |
| `src/application/use-cases/CreateTask.ts` | Modified | Deterministic FK validation in canonical order |
| `src/application/use-cases/UpdateTask.ts` | Modified | Conditional FK validation; pass `watcherIds` through |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modified | New `INCLUDE`; mapper rewrite; transactional watcher write |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | Modified | Mirror new fields + watcher array (FK validation happens in use case) |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified | Factory accepts lookup repos; `REFERENCE_TO_CODE` translation |
| `src/infrastructure/http/app.ts` | Modified | Pass `clientRepo/serviceRepo/partnerRepo/adminRepo` to scheduling router — **flagged: god object** |
| `src/__tests__/application/use-cases/CreateTask.test.ts` | Modified | FK error cases (one per kind); FK order test (REQ-FK-ORDER-1) |
| `src/__tests__/application/use-cases/UpdateTask.test.ts` | Modified | Watcher replace-set; endDate<startDate; travel time |
| `src/__tests__/infrastructure/adapters/prisma/PrismaSchedulingRepository.test.ts` | New | Mapper test (legacy-row + FK-resolved + watchers) |
| `src/__tests__/infrastructure/http/routes/scheduling.routes.test.ts` | Modified | New-field 201; FK 404 codes; replace-set; datetime echo; legacy fields still returned |
| `src/__tests__/infrastructure/http/scheduling-composition.test.ts` | New | Route-shadowing sanity test |

## Interfaces / Contracts

```ts
// src/domain/entities/scheduling.ts (delta)
export interface ScheduledTask {
  // ... existing fields ...

  // NEW — datetime envelope
  startDate: string | null;        // ISO 8601 with offset
  endDate: string | null;          // ISO 8601 with offset

  // NEW — FK relations
  customerId: string | null;
  customerName: string | null;     // derived from Client.name via JOIN
  serviceId: string | null;
  partnerId: string | null;
  reporterId: string | null;
  assigneeId: string | null;
  assigneeName: string | null;     // derived from Admin.name via JOIN

  // NEW — watchers
  watcherIds: string[];            // empty array when none

  // NEW — travel
  travelTimeTo: number | null;     // minutes
  travelTimeFrom: number | null;   // minutes

  // DEPRECATED (still returned for one release)
  /** @deprecated use startDate */
  scheduledDate: string | null;
  /** @deprecated use startDate */
  scheduledTime: string | null;
  /** @deprecated use customerId */
  clientId: string | null;
  /** @deprecated derived customerName is authoritative */
  clientName: string | null;
  /** @deprecated derived assigneeName is authoritative */
  assignedTo: string | null;
  /** @deprecated use assigneeId */
  assignedToId: string | null;
}

// src/domain/ports/SchedulingRepository.ts (delta)
export interface CreateTaskInput extends Omit<ScheduledTask,
  'id' | 'sequenceNumber' | 'stageCategory' | 'status' | 'customerName' | 'assigneeName'
> {
  watcherIds?: string[];
}
export interface UpdateTaskInput extends Partial<CreateTaskInput> {}

export interface SchedulingRepository {
  listTasks(): Promise<ScheduledTask[]>;
  getTask(id: string): Promise<ScheduledTask | null>;
  createTask(data: CreateTaskInput): Promise<ScheduledTask>;
  updateTask(id: string, data: UpdateTaskInput): Promise<ScheduledTask | null>;
  deleteTask(id: string): Promise<boolean>;
  moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null>;
  /** @deprecated */
  updateTaskStatus(id: string, status: TaskStatus): Promise<ScheduledTask | null>;
}

// src/domain/errors/scheduling.ts (addition)
export type ReferenceKind = 'customer' | 'service' | 'partner' | 'reporter' | 'assignee' | 'watcher';
export class ReferenceNotFoundError extends Error {
  constructor(public readonly kind: ReferenceKind, public readonly id: string) {
    super(`${kind} not found: ${id}`);
    this.name = 'ReferenceNotFoundError';
  }
}

// src/application/dto/scheduling.dto.ts (delta)
export const CreateTaskSchema = z.object({
  // ... existing fields (kept, with deprecated ones still optional) ...

  startDate:      z.string().datetime({ offset: true }).nullable().optional(),
  endDate:        z.string().datetime({ offset: true }).nullable().optional(),
  customerId:     z.string().min(1).nullable().optional(),
  serviceId:      z.string().min(1).nullable().optional(),
  partnerId:      z.string().min(1).nullable().optional(),
  reporterId:     z.string().min(1).nullable().optional(),
  assigneeId:     z.string().min(1).nullable().optional(),
  watcherIds:     z.array(z.string().min(1)).optional(),
  travelTimeTo:   z.number().int().nonnegative().nullable().optional(),
  travelTimeFrom: z.number().int().nonnegative().nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.startDate && v.endDate) {
    if (new Date(v.endDate).getTime() < new Date(v.startDate).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'endDate must be greater than or equal to startDate',
      });
    }
  }
});

// Route error mapping
const REFERENCE_TO_CODE: Record<ReferenceKind, string> = {
  customer: 'CUSTOMER_NOT_FOUND',
  service:  'SERVICE_NOT_FOUND',
  partner:  'PARTNER_NOT_FOUND',
  reporter: 'REPORTER_NOT_FOUND',
  assignee: 'ASSIGNEE_NOT_FOUND',
  watcher:  'WATCHER_NOT_FOUND',
};
```

## Testing Strategy

| Layer | Tool | Focus |
|-------|------|-------|
| Unit (use cases) | Jest + `InMemorySchedulingRepository` + lookup repos | Deterministic FK order, every `*_NOT_FOUND` code, watcher replace-set, endDate<startDate, travel-time bounds |
| Unit (DTO) | Jest | Schema rejects malformed datetime, negative travel-time, non-integer travel-time, endDate<startDate; accepts new fields as null |
| Unit (adapter mapper) | Jest | `toTask` for legacy-only row (new FKs NULL); for FK-resolved row (customerName from JOIN); for row with watchers populated |
| Integration (routes) | Supertest | Auth (smoke — covered by base spec), 201 with new fields, 404 with each FK code, replace-set semantics, datetime echo, legacy fields still returned alongside new ones |
| Composition | Supertest | Mount `schedulingRouter` only + any future sibling stub — route-shadowing sanity (change 1 lesson) |
| Type | `tsc --noEmit` | DIP preservation (no `@infrastructure/*` imports from application) |
| End-to-end smoke | curl scripts (tasks.md Smoke) | Real DB roundtrip post-deploy |

Strict TDD: each new test starts red, then the implementation makes it green. The mapper test predates the adapter rewrite. The route-level FK error test predates the route changes.

## Migration / Rollout

### Up SQL (sketch — `prisma migrate dev` generates the DDL; the `DO $$ ... $$` block is hand-appended)

```sql
-- DDL ------------------------------------------------------------
ALTER TABLE "ScheduledTask" ADD COLUMN "startDate"      TIMESTAMP(3);
ALTER TABLE "ScheduledTask" ADD COLUMN "endDate"        TIMESTAMP(3);
ALTER TABLE "ScheduledTask" ADD COLUMN "customerId"     TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "serviceId"      TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "partnerId"      TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "reporterId"     TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "assigneeId"     TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "travelTimeTo"   INTEGER;
ALTER TABLE "ScheduledTask" ADD COLUMN "travelTimeFrom" INTEGER;

ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Client"("id")  ON DELETE SET NULL,
  ADD CONSTRAINT "ScheduledTask_serviceId_fkey"
    FOREIGN KEY ("serviceId")  REFERENCES "Service"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "ScheduledTask_partnerId_fkey"
    FOREIGN KEY ("partnerId")  REFERENCES "Partner"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "ScheduledTask_reporterId_fkey"
    FOREIGN KEY ("reporterId") REFERENCES "Admin"("id")   ON DELETE SET NULL,
  ADD CONSTRAINT "ScheduledTask_assigneeId_fkey"
    FOREIGN KEY ("assigneeId") REFERENCES "Admin"("id")   ON DELETE SET NULL;

CREATE INDEX "ScheduledTask_startDate_idx"   ON "ScheduledTask"("startDate");
CREATE INDEX "ScheduledTask_endDate_idx"     ON "ScheduledTask"("endDate");
CREATE INDEX "ScheduledTask_customerId_idx"  ON "ScheduledTask"("customerId");
CREATE INDEX "ScheduledTask_serviceId_idx"   ON "ScheduledTask"("serviceId");
CREATE INDEX "ScheduledTask_partnerId_idx"   ON "ScheduledTask"("partnerId");
CREATE INDEX "ScheduledTask_assigneeId_idx"  ON "ScheduledTask"("assigneeId");
CREATE INDEX "ScheduledTask_reporterId_idx"  ON "ScheduledTask"("reporterId");

CREATE TABLE "TaskWatcher" (
  "taskId"  TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  CONSTRAINT "TaskWatcher_pkey" PRIMARY KEY ("taskId", "adminId"),
  CONSTRAINT "TaskWatcher_taskId_fkey"
    FOREIGN KEY ("taskId")  REFERENCES "ScheduledTask"("id") ON DELETE CASCADE,
  CONSTRAINT "TaskWatcher_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "Admin"("id")         ON DELETE CASCADE
);
CREATE INDEX "TaskWatcher_adminId_idx" ON "TaskWatcher"("adminId");

-- Data backfill --------------------------------------------------
-- Idempotent: only updates rows where startDate is still NULL.
-- Uses DO $$ ... $$ pattern per change-1 lesson (NEVER ON CONFLICT ON CONSTRAINT).
-- Per-row EXCEPTION block tolerates unparseable legacy strings; emits NOTICE for ops visibility.
DO $$
DECLARE
  rec RECORD;
  candidate_text TEXT;
  parsed_start TIMESTAMP;
BEGIN
  FOR rec IN
    SELECT "id", "scheduledDate", "scheduledTime", "estimatedHours"
    FROM "ScheduledTask"
    WHERE "startDate" IS NULL
      AND "scheduledDate" IS NOT NULL
  LOOP
    candidate_text := rec."scheduledDate" || 'T' || COALESCE(rec."scheduledTime", '00:00') || ':00';
    BEGIN
      parsed_start := candidate_text::timestamp;
      UPDATE "ScheduledTask"
      SET "startDate" = parsed_start,
          "endDate"   = parsed_start + (COALESCE(rec."estimatedHours", 1) * INTERVAL '1 hour')
      WHERE "id" = rec."id";
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'scheduling-tasks-enrich: could not parse startDate for task % (input: %)', rec."id", candidate_text;
    END;
  END LOOP;
END $$;
```

**Critical**: NO `ON CONFLICT ON CONSTRAINT <index_name>` anywhere. NO new UNIQUE constraints. The backfill loops in pure PL/pgSQL with per-row exception handling.

### Down SQL (manual — header comment in the migration file, same style as change 2)

```sql
DROP TABLE IF EXISTS "TaskWatcher";
DROP INDEX IF EXISTS "ScheduledTask_startDate_idx";
DROP INDEX IF EXISTS "ScheduledTask_endDate_idx";
DROP INDEX IF EXISTS "ScheduledTask_customerId_idx";
DROP INDEX IF EXISTS "ScheduledTask_serviceId_idx";
DROP INDEX IF EXISTS "ScheduledTask_partnerId_idx";
DROP INDEX IF EXISTS "ScheduledTask_assigneeId_idx";
DROP INDEX IF EXISTS "ScheduledTask_reporterId_idx";
ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_assigneeId_fkey";
ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_reporterId_fkey";
ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_partnerId_fkey";
ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_serviceId_fkey";
ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_customerId_fkey";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "travelTimeFrom";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "travelTimeTo";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "assigneeId";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "reporterId";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "partnerId";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "serviceId";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "customerId";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "endDate";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "startDate";
```

### Rollout

1. Merge → `npm run prisma:migrate` in each environment. Verify the migration log for any `NOTICE` lines indicating unparseable rows; reconcile manually if needed.
2. Deploy app.
3. Run the smoke (see `tasks.md` Smoke section). Verify `startDate` round-trips as ISO, FK validation returns the right `*_NOT_FOUND` codes, watcher replace-set works.
4. Cleanup release (separate change): drop legacy columns after frontend has fully migrated and no `NOTICE` rows remain.

## Open Questions

- Should `endDate` automatically update when `startDate` changes via PUT? Decision: NO — `endDate` is independent once set. If the frontend wants to recompute, it sends both.
- Should we add a `?assigneeId=` / `?customerId=` filter on `GET /api/scheduling`? Out of scope here — change 6 (`scheduling-tasks-views`) handles multi-select filters.
- Should `reporterId` default to the authenticated user on create? Decision: NO in this change — the frontend can pass the value explicitly. A future change may add a server-side default.
- Should the watcher set notify on assignment (email/webhook)? Out of scope — separate change.
