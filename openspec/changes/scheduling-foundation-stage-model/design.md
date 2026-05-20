# Design: Scheduling Foundation — Stage Model

## Technical Approach

Introduce four Prisma models — `Workflow`, `Stage`, `ProjectCategory`, `ProjectType` — and replace `ScheduledTask.status: String` with a `stageId: String` FK to `Stage`. A single Prisma migration runs the DDL changes and an in-migration SQL backfill that maps every existing `status` value to the matching Stage in a "Default" workflow seeded by `prisma/seed.ts`. The legacy `status` column is **retained** for one release as a derived value (read-only from the application layer's perspective) so that frontends and any out-of-band tooling continue to function while they migrate. Backend code reads only from `stageId`; the response payload exposes both `stageId`/`stageCategory` (new) and `status` (deprecated alias derived from the Stage). The deprecated `PATCH /:id/status` route stays alive as a shim that internally calls the new `MoveTaskToStage` use case.

The capability ships strictly to the backend: Prisma schema, migration, seed, four domain entity files, four ports, four Prisma adapters (with **coherent naming** — explicitly avoiding the `Prisma*` → `InMemory*` class-name debt called out in `openspec/config.yaml#known_debt.naming-mismatch`), four in-memory adapters, 18 use cases, two zod DTO files, two routers, and ~30 lines of wiring in `app.ts`. Strict TDD: every use case has a failing test first against the in-memory port; every route has a failing supertest first.

The change explicitly avoids touching `Project` enrichment, `scheduledDate/Time` migration, and any frontend work — those are sibling changes 2, 3, and 6 in `md/splynx-scheduling/OVERVIEW.md`.

## Architecture Decisions

### Decision 1 — `Stage.category` stored as a Postgres enum

- **Choice**: Define `Stage.category` as a Prisma enum `StageCategory { nuevo enProgreso hecho }` mapped to a Postgres `ENUM` type. The domain entity uses a TypeScript string-literal union `'nuevo' | 'enProgreso' | 'hecho'`.
- **Alternatives**: (a) plain `String` column with app-layer validation; (b) FK to a `StageCategory` lookup table.
- **Rationale**: The three categories are a closed set baked into the UI (the three columns of every Splynx Project list and Kanban view). A Postgres enum gives DB-level integrity at no cost. A lookup table is overkill for three rows; a free `String` repeats the original `status` mistake. Domain layer uses the string-literal union so application code stays Prisma-agnostic — the Prisma adapter is the only place where the enum mapping lives.

### Decision 2 — `ScheduledTask.status` is **kept** during this change

- **Choice**: The migration adds `stageId String NOT NULL` (after backfill) and **does not drop** the existing `status: String` column. The application layer ignores `status` on writes (it is no longer in the Prisma payload sent on update/create) but the column persists. On read, the Prisma adapter computes the `status` response field from the joined `Stage.category` and `Stage.name` (REQ-STAGE-DEP-3) — the DB column itself is no longer the source of truth and may drift; we do NOT trust it.
- **Alternatives**: (a) drop `status` in the same migration; (b) rename `status` → `legacyStatus` and keep dual-writing.
- **Rationale**: Dropping immediately makes rollback far riskier — once dropped, restoring requires synthesizing string values from Stage categories under uncertainty for stages outside the Default workflow. Keeping `status` as dead weight for one release lets us roll back the migration cheaply (`stageId` becomes nullable / drop FK + new tables → `status` is intact). Dual-writing is just a slower, more error-prone version of dropping; it adds bug surface (race conditions between the two columns) without ROI. The drop happens in a follow-up change once the deprecation aliases are dropped from the API.

### Decision 3 — Seed lives in `prisma/seed.ts`, data backfill lives in the migration SQL

- **Choice**: Two-step bootstrap: (1) **migration SQL** creates the schema and runs a self-contained backfill that **only** uses the Default workflow's stage IDs (resolved by name lookup inside the migration); the migration assumes the Default workflow already exists OR creates it inline as part of the SQL. (2) `prisma/seed.ts` is **idempotent** and creates the Default workflow + 11 stages + Default ProjectCategory + Instalacion ProjectType using `upsert`. The seed runs **before** the migration backfill in any environment where `seed` is invoked separately; for environments where the migration runs against a populated DB without prior seeding (production), the migration itself runs a small bootstrap `INSERT ... ON CONFLICT DO NOTHING` for the Default workflow + 11 stages so the backfill has IDs to point at.
- **Alternatives**: (a) put data backfill in `seed.ts`; (b) put seed in the migration.
- **Rationale**: `seed.ts` runs only when an operator invokes `npm run prisma:seed` — it cannot be relied upon in production deploys. Migrations always run. Conversely, having the migration create the Default workflow inline ensures the backfill has a target even on fresh production DBs that have never been seeded. The seed file remains the **declarative** source of truth for the catalog (re-runnable, version-controlled), and the migration carries a minimal bootstrap copy for safety. Both paths converge on the same final state because both use `upsert`/`ON CONFLICT DO NOTHING` keyed by name.

### Decision 4 — Keep `PATCH /:id/status` as deprecation alias for one release

- **Choice**: Both `PATCH /:id/status` (deprecated, maps legacy status → Stage in Default workflow) and `PATCH /:id/stage` (new, primary) ship in this change. The deprecated route logs `console.warn('deprecated route: PATCH /api/scheduling/:id/status — use /:id/stage')` and internally calls the same `MoveTaskToStage` use case after translating `status → stageId`. The deprecated route is removed in the next change.
- **Alternatives**: (a) hard-replace — drop `/status` immediately; (b) keep `/status` forever.
- **Rationale**: Hard-replacing breaks the frontend the moment the backend ships, since the frontend `useTasks` hook still PATCHes `/status`. The alias gives a deploy window. Forever-keeping perpetuates the four-value enum we are trying to retire and confuses new developers. A one-release deprecation is the standard middle ground used in the `scheduling-hardening` precedent for type relaxation.

### Decision 5 — `ReorderStages` input is an ordered array of Stage IDs

- **Choice**: `ReorderStages.execute({ workflowId: string, order: string[] })` where `order` is an ordered array of Stage IDs. The use case validates that the multiset of IDs in `order` is **exactly equal** to the multiset of Stage IDs belonging to the workflow (no missing, no extras, no duplicates), then assigns `order = index` for each. Stored `order` values are 0-based.
- **Alternatives**: (a) `Array<{ id: string, order: number }>` — explicit pairs; (b) delta updates (`{ id, fromIndex, toIndex }`); (c) `order` field as a sparse decimal (e.g. fractional indexing).
- **Rationale**: An ordered array is the natural client representation (drag-and-drop produces exactly this — the new order of items). Explicit pairs let clients lie (two stages claiming `order: 0`); the use case would have to re-sort anyway. Delta updates are stateful and brittle. Fractional indexing is overkill for ≤ ~20 stages per workflow. The set-equality check (REQ-STAGE-REORDER-2) is the safety net.

### Decision 6 — `ScheduledTask.stageCategory` is repository-derived, not a column

- **Choice**: The domain entity declares `stageCategory: 'nuevo' | 'enProgreso' | 'hecho'` as a **read-only** field populated by the repository when reading a task (via a Prisma `include: { stage: true }` followed by `stageCategory: row.stage.category`). It is never written by the application layer and never persisted as its own column.
- **Alternatives**: (a) denormalize `stageCategory` onto `ScheduledTask` so it is one column away; (b) drop the derived field entirely and force callers to join.
- **Rationale**: Denormalization causes drift (move a Stage to a different category → the column lies). Forcing callers to join leaks adapter concerns into the application layer. Computing it in the repository keeps the field invariant by construction and the cost is one extra JOIN per task read — already paid because we also need `Stage.name` for the deprecated `status` derivation.

## Data Flow

### Stage transition (new)

```
PATCH /api/scheduling/:id/stage  { stageId }
  ├─> auth middleware                  ── no/invalid cookie ──> 401 UNAUTHORIZED
  ├─> zod safeParse(req.body)           ── parse failure   ──> 400 VALIDATION_ERROR
  ├─> route handler
  ├─> MoveTaskToStage.execute(taskId, stageId)
  │     ├─> StageRepository.getById(stageId)  ── null      ──> 404 STAGE_NOT_FOUND
  │     ├─> SchedulingRepository.moveTaskToStage(taskId, stageId)
  │     │     ├─> Prisma update (sets stageId, conditionally sets completedAt
  │     │     │   when target stage.category = 'hecho' AND completedAt IS NULL)
  │     │     ├─> include: { project: true, stage: true }
  │     │     └─> mapper toTask({ ...row, stageCategory: row.stage.category,
  │     │                         status: deriveLegacyStatus(row.stage) })
  │     └─> returns ScheduledTask or null (404 TASK_NOT_FOUND)
  └─> 200 OK  ScheduledTask (with stageId, stageCategory, deprecated status)
```

### Deprecated transition (alias)

```
PATCH /api/scheduling/:id/status  { status }
  ├─> auth
  ├─> zod safeParse with deprecated UpdateStatusSchema
  ├─> console.warn('deprecated route...')
  ├─> StageRepository.getDefaultWorkflowStageByLegacyStatus(status)
  │     mapping: pending→"Nuevo", in_progress→"En progreso",
  │              completed→"Hecho", cancelled→"Anulado-Cancelado"
  └─> MoveTaskToStage.execute(taskId, resolvedStageId)
        ── same flow as above
```

### Reorder stages

```
PUT /api/scheduling/workflows/:id/stages/reorder  { order: [stageId, ...] }
  ├─> auth
  ├─> zod safeParse(ReorderStagesSchema)
  ├─> ReorderStages.execute(workflowId, order)
  │     ├─> WorkflowRepository.getById(workflowId)  ── null ──> 404
  │     ├─> StageRepository.listByWorkflow(workflowId) → currentStages
  │     ├─> validate setEquality(order, currentStages.map(s => s.id))
  │     │     ── mismatch ──> throw ReorderSetMismatchError ──> 400
  │     └─> StageRepository.reorder(workflowId, order)
  │           ├─> tx: for each (id, index) in order: update { order: index }
  │           └─> returns updated workflow with sorted stages
  └─> 200 OK  Workflow
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | Add `Workflow`, `Stage`, `StageCategory` enum, `ProjectCategory`, `ProjectType`; add `ScheduledTask.stageId String?` (later NOT NULL post-backfill); add FK + `@@index([stageId])` |
| `prisma/migrations/<ts>_scheduling_foundation_stage_model/migration.sql` | New | DDL + bootstrap of Default workflow + 11 stages + backfill of `stageId` + ALTER TABLE NOT NULL |
| `prisma/seed.ts` | Modify | Idempotent upsert of Default workflow + 11 stages + Default ProjectCategory + Instalacion ProjectType |
| `src/domain/entities/workflow.ts` | New | `StageCategory`, `Stage`, `Workflow` types |
| `src/domain/entities/projectCategory.ts` | New | `ProjectCategory` type |
| `src/domain/entities/projectType.ts` | New | `ProjectType` type |
| `src/domain/entities/scheduling.ts` | Modify | Replace `status: TaskStatus` with `stageId: string`; add read-only `stageCategory: StageCategory`; keep deprecated `status: TaskStatus` (derived in adapter) |
| `src/domain/ports/WorkflowRepository.ts` | New | CRUD + `reorderStages` |
| `src/domain/ports/StageRepository.ts` | New | `listByWorkflow`, `getById`, `add`, `removeIfUnused`, `countTasksUsing` |
| `src/domain/ports/ProjectCategoryRepository.ts` | New | CRUD |
| `src/domain/ports/ProjectTypeRepository.ts` | New | CRUD |
| `src/domain/ports/SchedulingRepository.ts` | Modify | Add `moveTaskToStage`; keep `updateTaskStatus` as shim that calls `moveTaskToStage` after translation |
| `src/domain/errors/scheduling.ts` | New | `StageNotFoundError`, `WorkflowNotFoundError`, `StageInUseError`, `WorkflowInUseError`, `DefaultWorkflowProtectedError`, `ReorderSetMismatchError`, `WorkflowNameConflictError`, `StageNameConflictError`, `ProjectCategoryNotFoundError`, `ProjectTypeNotFoundError`, etc. |
| `src/infrastructure/adapters/prisma/PrismaWorkflowRepository.ts` | New | Class name === file name |
| `src/infrastructure/adapters/prisma/PrismaStageRepository.ts` | New | idem |
| `src/infrastructure/adapters/prisma/PrismaProjectCategoryRepository.ts` | New | idem |
| `src/infrastructure/adapters/prisma/PrismaProjectTypeRepository.ts` | New | idem |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modify | Join `Stage` in every read; derive `stageCategory` + deprecated `status`; implement `moveTaskToStage`; shim `updateTaskStatus` |
| `src/infrastructure/adapters/in-memory/InMemoryWorkflowRepository.ts` | New | For TDD |
| `src/infrastructure/adapters/in-memory/InMemoryStageRepository.ts` | New | idem |
| `src/infrastructure/adapters/in-memory/InMemoryProjectCategoryRepository.ts` | New | idem |
| `src/infrastructure/adapters/in-memory/InMemoryProjectTypeRepository.ts` | New | idem |
| `src/application/use-cases/ListWorkflows.ts` | New | |
| `src/application/use-cases/GetWorkflow.ts` | New | |
| `src/application/use-cases/CreateWorkflow.ts` | New | name conflict → throw `WorkflowNameConflictError` |
| `src/application/use-cases/UpdateWorkflow.ts` | New | |
| `src/application/use-cases/DeleteWorkflow.ts` | New | guards: Default protected; in-use → throw |
| `src/application/use-cases/AddStageToWorkflow.ts` | New | |
| `src/application/use-cases/RemoveStageFromWorkflow.ts` | New | in-use check |
| `src/application/use-cases/ReorderStages.ts` | New | set-equality check |
| `src/application/use-cases/MoveTaskToStage.ts` | New | resolves stage → calls `SchedulingRepository.moveTaskToStage` |
| `src/application/use-cases/UpdateTaskStatus.ts` | Modify | Becomes a thin wrapper that maps legacy status → stageId via Default workflow, then calls `MoveTaskToStage`; logs deprecation |
| `src/application/use-cases/{List,Get,Create,Update,Delete}ProjectCategory.ts` | New | 5 files |
| `src/application/use-cases/{List,Get,Create,Update,Delete}ProjectType.ts` | New | 5 files |
| `src/application/dto/workflows.dto.ts` | New | Zod schemas for workflows + stages + project-categories + project-types |
| `src/application/dto/scheduling.dto.ts` | Modify | Add `MoveStageSchema`; mark `UpdateStatusSchema` `@deprecated`; swap `status` for optional `stageId` in `CreateTaskSchema` / `UpdateTaskSchema` |
| `src/infrastructure/http/routes/workflows.routes.ts` | New | All routes from spec, auth on every one |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modify | Add `PATCH /:id/stage`; keep `PATCH /:id/status` as deprecated alias |
| `src/infrastructure/http/app.ts` | Modify | Wire 4 repos + 18 use cases + new router (~30 lines added) |
| `src/__tests__/**` | New + modify | See Testing Strategy |

## Interfaces / Contracts

### Domain entities

```ts
// src/domain/entities/workflow.ts
export type StageCategory = 'nuevo' | 'enProgreso' | 'hecho';

export interface Stage {
  id: string;
  workflowId: string;
  name: string;
  category: StageCategory;
  order: number;
}

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  stages: Stage[]; // sorted by `order` asc
  createdAt: string;
  updatedAt: string;
}

// src/domain/entities/projectCategory.ts
export interface ProjectCategory {
  id: string;
  name: string;
  description: string | null;
}

// src/domain/entities/projectType.ts
export interface ProjectType {
  id: string;
  name: string;
  description: string | null;
}

// src/domain/entities/scheduling.ts (excerpt)
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'; // DEPRECATED
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ScheduledTask {
  id: string;
  sequenceNumber: number;
  title: string;
  description: string | null;
  assignedTo: string | null;
  assignedToId: string | null;
  clientId: string | null;
  clientName: string | null;
  stageId: string;                  // NEW — primary
  stageCategory: StageCategory;     // NEW — read-only derived
  /** @deprecated use stageCategory; will be removed next change */
  status: TaskStatus;
  priority: TaskPriority;
  scheduledDate: string | null;
  scheduledTime: string | null;
  estimatedHours: number;
  address: string | null;
  coordinates: { lat: number; lng: number } | null;
  category: 'installation' | 'repair' | 'maintenance' | 'inspection' | 'other';
  projectId?: string | null;
  projectName?: string | null;
  completedAt: string | null;
  notes: string | null;
}
```

### Ports

```ts
// src/domain/ports/WorkflowRepository.ts
export interface WorkflowRepository {
  list(): Promise<Workflow[]>;
  getById(id: string): Promise<Workflow | null>;
  getByName(name: string): Promise<Workflow | null>;
  create(data: { name: string; description: string | null; stages: Array<Pick<Stage, 'name'|'category'|'order'>> }): Promise<Workflow>;
  update(id: string, data: Partial<Pick<Workflow, 'name'|'description'>>): Promise<Workflow | null>;
  delete(id: string): Promise<boolean>;
}

// src/domain/ports/StageRepository.ts
export interface StageRepository {
  listByWorkflow(workflowId: string): Promise<Stage[]>;
  getById(id: string): Promise<Stage | null>;
  add(workflowId: string, data: Pick<Stage, 'name'|'category'|'order'>): Promise<Stage>;
  remove(stageId: string): Promise<boolean>;
  reorder(workflowId: string, orderedIds: string[]): Promise<Stage[]>;
  countTasksUsing(stageId: string): Promise<number>;
  countTasksUsingAny(stageIds: string[]): Promise<number>;
  getDefaultWorkflowStageByLegacyStatus(status: TaskStatus): Promise<Stage | null>;
}

// src/domain/ports/SchedulingRepository.ts (excerpt)
export interface SchedulingRepository {
  listTasks(): Promise<ScheduledTask[]>;
  getTask(id: string): Promise<ScheduledTask | null>;
  createTask(data: Omit<ScheduledTask, 'id'|'sequenceNumber'|'stageCategory'|'status'>): Promise<ScheduledTask>;
  updateTask(id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask | null>;
  deleteTask(id: string): Promise<boolean>;
  moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null>;
  /** @deprecated use moveTaskToStage */
  updateTaskStatus(id: string, status: TaskStatus): Promise<ScheduledTask | null>;
}
```

### Use cases (selected)

```ts
// src/application/use-cases/MoveTaskToStage.ts
export class MoveTaskToStage {
  constructor(private readonly tasks: SchedulingRepository, private readonly stages: StageRepository) {}
  async execute(taskId: string, stageId: string): Promise<ScheduledTask> {
    const stage = await this.stages.getById(stageId);
    if (!stage) throw new StageNotFoundError(stageId);
    const updated = await this.tasks.moveTaskToStage(taskId, stageId);
    if (!updated) throw new TaskNotFoundError(taskId);
    return updated;
  }
}

// src/application/use-cases/ReorderStages.ts
export class ReorderStages {
  constructor(private readonly workflows: WorkflowRepository, private readonly stages: StageRepository) {}
  async execute(workflowId: string, order: string[]): Promise<Workflow> {
    const wf = await this.workflows.getById(workflowId);
    if (!wf) throw new WorkflowNotFoundError(workflowId);
    const current = await this.stages.listByWorkflow(workflowId);
    const currentIds = current.map(s => s.id).sort();
    const inputIds = [...order].sort();
    if (currentIds.length !== inputIds.length
        || new Set(order).size !== order.length
        || currentIds.some((id, i) => id !== inputIds[i])) {
      throw new ReorderSetMismatchError();
    }
    await this.stages.reorder(workflowId, order);
    return (await this.workflows.getById(workflowId))!;
  }
}
```

### DTOs

```ts
// src/application/dto/workflows.dto.ts
import { z } from 'zod';

export const StageCategorySchema = z.enum(['nuevo','enProgreso','hecho']);

export const CreateStageSchema = z.object({
  name: z.string().min(1),
  category: StageCategorySchema,
  order: z.number().int().nonnegative(),
});

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  stages: z.array(CreateStageSchema).optional(),
});

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
});

export const ReorderStagesSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

export const CreateProjectCategorySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});
export const UpdateProjectCategorySchema = CreateProjectCategorySchema.partial();

export const CreateProjectTypeSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});
export const UpdateProjectTypeSchema = CreateProjectTypeSchema.partial();

// src/application/dto/scheduling.dto.ts (excerpt)
export const MoveStageSchema = z.object({ stageId: z.string().uuid() });
/** @deprecated use MoveStageSchema */
export const UpdateStatusSchema = z.object({ status: TaskStatusSchema });
```

## Testing Strategy

| Layer | Scenario | Type |
|-------|----------|------|
| Schema | `CreateWorkflowSchema`, `CreateStageSchema`, `ReorderStagesSchema`, `MoveStageSchema` valid / invalid payloads | Unit (zod) |
| Use case | `CreateWorkflow` happy path + name conflict | Unit (in-memory port) |
| Use case | `DeleteWorkflow` 204 / 404 / in-use 409 / Default-protected 409 | Unit |
| Use case | `AddStageToWorkflow` happy + duplicate stage name | Unit |
| Use case | `ReorderStages` happy + set-mismatch (missing id, extra id, duplicates) | Unit |
| Use case | `MoveTaskToStage` happy + stage-not-found + task-not-found + `completedAt` auto-set when category=hecho | Unit |
| Use case | `UpdateTaskStatus` (deprecated shim) translates each of the 4 legacy values to the correct Default workflow Stage | Unit |
| Use case | `ListWorkflows` returns stages sorted by `order` asc | Unit |
| Use case | `ProjectCategory` / `ProjectType` CRUD: happy + name conflict + in-use check returns 0 references | Unit |
| Repository (in-memory) | `InMemoryStageRepository.reorder` updates `order` correctly | Unit |
| Repository (Prisma) | `PrismaSchedulingRepository.moveTaskToStage` writes `stageId`, joins `Stage`, returns `stageCategory` and deprecated `status` derived | Integration (existing prisma test pattern in `src/__tests__/infrastructure/`) |
| Route | `GET /api/scheduling/workflows` without cookie → 401 | Integration (supertest) |
| Route | `POST /api/scheduling/workflows` happy + 400 + 409 | Integration |
| Route | `PUT /api/scheduling/workflows/:id/stages/reorder` happy + 400 set-mismatch + 404 | Integration |
| Route | `DELETE /api/scheduling/workflows/:id` 204 / 404 / 409 in-use / 409 Default-protected | Integration |
| Route | `PATCH /api/scheduling/:id/stage` happy + 404 stage + 404 task + 400 malformed | Integration |
| Route | `PATCH /api/scheduling/:id/status` (deprecated) still returns 200 and maps to the correct Stage | Integration |
| Route | Every `ScheduledTask` response carries `stageId`, `stageCategory`, deprecated `status`, `projectName` | Integration |
| Migration | Backfill maps `pending/in_progress/completed/cancelled` to the 4 documented stages on a populated test DB | Integration (db reset + raw SQL fixture + run migration) |
| Type | `tsc --noEmit` clean — no `@infrastructure/*` imports in application layer | Quality gate |

No E2E. All route tests use the existing fake `JwtAuthAdapter` + `cookie-parser` pattern from `scheduling.routes.test.ts`.

## Migration / Rollout

### Migration name
`<timestamp>_scheduling_foundation_stage_model`

### Migration SQL (sketch)

```sql
-- 1. Enum
CREATE TYPE "StageCategory" AS ENUM ('nuevo', 'enProgreso', 'hecho');

-- 2. Tables
CREATE TABLE "Workflow" (
  "id"          TEXT PRIMARY KEY,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "Workflow_name_lower_key" ON "Workflow" (LOWER("name"));

CREATE TABLE "Stage" (
  "id"         TEXT PRIMARY KEY,
  "workflowId" TEXT NOT NULL REFERENCES "Workflow"("id") ON DELETE CASCADE,
  "name"       TEXT NOT NULL,
  "category"   "StageCategory" NOT NULL,
  "order"      INTEGER NOT NULL
);
CREATE UNIQUE INDEX "Stage_workflowId_name_lower_key" ON "Stage" ("workflowId", LOWER("name"));
CREATE INDEX "Stage_workflowId_order_idx" ON "Stage" ("workflowId", "order");

CREATE TABLE "ProjectCategory" ( "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "description" TEXT );
CREATE UNIQUE INDEX "ProjectCategory_name_lower_key" ON "ProjectCategory" (LOWER("name"));

CREATE TABLE "ProjectType"   ( "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "description" TEXT );
CREATE UNIQUE INDEX "ProjectType_name_lower_key"   ON "ProjectType"   (LOWER("name"));

-- 3. Bootstrap Default workflow + 11 stages (idempotent guard)
WITH new_wf AS (
  INSERT INTO "Workflow" ("id","name","description","updatedAt")
  VALUES (gen_random_uuid()::text, 'Default', 'Default workflow seeded by scheduling-foundation-stage-model', NOW())
  ON CONFLICT (LOWER("name")) DO NOTHING
  RETURNING "id"
), wf AS (
  SELECT "id" FROM new_wf
  UNION ALL
  SELECT "id" FROM "Workflow" WHERE LOWER("name") = 'default' LIMIT 1
)
INSERT INTO "Stage" ("id","workflowId","name","category","order")
SELECT gen_random_uuid()::text, wf.id, s.name, s.category::"StageCategory", s.ord
FROM wf, (VALUES
  ('Nuevo',                'nuevo',       0),
  ('Confirmado',           'nuevo',       1),
  ('Pospuesta',            'nuevo',       2),
  ('No Factible',          'nuevo',       3),
  ('Enviar a IClass',      'nuevo',       4),
  ('Registrado en IClass', 'nuevo',       5),
  ('Notificado',           'nuevo',       6),
  ('En progreso',          'enProgreso',  7),
  ('Instalado',            'hecho',       8),
  ('Hecho',                'hecho',       9),
  ('Anulado-Cancelado',    'hecho',      10)
) AS s(name, category, ord)
ON CONFLICT ON CONSTRAINT "Stage_workflowId_name_lower_key" DO NOTHING;

-- 4. Add stageId column (nullable first)
ALTER TABLE "ScheduledTask" ADD COLUMN "stageId" TEXT;

-- 5. Backfill
UPDATE "ScheduledTask" t
SET "stageId" = s."id"
FROM "Workflow" w
JOIN "Stage" s ON s."workflowId" = w."id"
WHERE LOWER(w."name") = 'default'
  AND (
       (t."status" = 'pending'      AND s."name" = 'Nuevo')
    OR (t."status" = 'in_progress'  AND s."name" = 'En progreso')
    OR (t."status" = 'completed'    AND s."name" = 'Hecho')
    OR (t."status" = 'cancelled'    AND s."name" = 'Anulado-Cancelado')
  );

-- Safety net: anything unmapped → "Nuevo"
UPDATE "ScheduledTask" t
SET "stageId" = (
  SELECT s."id" FROM "Stage" s
  JOIN "Workflow" w ON w."id" = s."workflowId"
  WHERE LOWER(w."name") = 'default' AND s."name" = 'Nuevo' LIMIT 1
)
WHERE t."stageId" IS NULL;

-- 6. NOT NULL + FK + index
ALTER TABLE "ScheduledTask" ALTER COLUMN "stageId" SET NOT NULL;
ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_stageId_fkey"
  FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE RESTRICT;
CREATE INDEX "ScheduledTask_stageId_idx" ON "ScheduledTask" ("stageId");

-- 7. Project-supporting tables (left empty; populated by seed/follow-up changes)
--    No data backfill for ProjectCategory / ProjectType in this migration.
```

### Down migration

`prisma migrate dev` auto-generates the inverse: drop FK, drop column `stageId`, drop tables (`Stage`, `Workflow`, `ProjectCategory`, `ProjectType`), drop enum. Existing `status` column is intact → reverted app code works.

### Rollout sequence

1. Merge backend PR → CI runs `npm test` + `tsc --noEmit` → green.
2. Deploy → Prisma migrate runs → bootstrap + backfill complete inside the migration.
3. Verify in staging: `SELECT COUNT(*) FROM "ScheduledTask" WHERE "stageId" IS NULL` → must be 0.
4. Sanity-check API: `GET /api/scheduling/workflows`, `GET /api/scheduling/:id`, `PATCH /api/scheduling/:id/stage`.
5. Coordinate frontend release.

## Open Questions

None. All resolved during research:
- Splynx sub-stage list and category grouping confirmed via `md/splynx-scheduling/snapshots/scheduling-tasks-filtered-snapshot.yml`.
- Naming convention for adapters confirmed via `openspec/config.yaml#known_debt.naming-mismatch`.
- Auth pattern confirmed via `clients.routes.ts` precedent + `scheduling-hardening` archived design.
- `zod` already available — no new deps.
