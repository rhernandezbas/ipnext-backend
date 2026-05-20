# Design: Scheduling Projects Enrich

## Technical Approach

We extend the existing `Project` Prisma model with five scalar/FK columns and introduce a `ProjectPartner` pivot table for the M:N partner relation. The domain `Project` entity grows accordingly, the `ProjectRepository` port widens its create/update input types (but adds no new methods — partners are handled as a field of the update payload, transactionally), and five thin use cases mediate FK validation between routes and the adapter. The HTTP route file is rewritten to add `createAuthMiddleware` (a security fix) and zod-based validation through the new DTOs. The Prisma adapter's `update` runs in a transaction that performs scalar mutations + `ProjectPartner` replace-set, ensuring partner-set updates are atomic. `taskCounts` is recomputed by reading `Stage.category` (post change 1) on the linked tasks instead of the deprecated `status` string. The change is purely additive at the schema level (no destructive DDL), so rollback consists of dropping the new columns + pivot table.

## Architecture Decisions

### AD-1: `ProjectType` and `ProjectCategory` as FK references (NOT free-form strings)

Splynx's UI shows Tipo and Categoría as selects populated from admin-managed lists. Change 1 already shipped both as Prisma tables. The natural choice is FK from `Project` to both. Alternatives considered:

- **String enum on `Project.type`**: rejected. Admin-configurable values rule out a closed enum, and a free string defeats the purpose of having a table.
- **Polymorphic key**: rejected. No real polymorphism — these are flat lookup tables.

**Decision**: `typeId String?` and `categoryId String?`, both FK with `onDelete: SetNull` (deleting a category SHOULD NOT cascade-delete projects).

### AD-2: `ProjectType.name` / `ProjectCategory.name` uniqueness — deferred, consistent with change 1

Change 1's `Workflow.name` is NOT unique (intentional — workflows are admin-managed and the UI handles duplication via UUID). For consistency, we do NOT add a unique constraint on `ProjectType.name` or `ProjectCategory.name` in this change. If duplicate-name pain emerges, a follow-up change can add a case-insensitive unique constraint via a `lower(name)` partial index. Documented for future-us.

### AD-3: `taskCounts` shape stays on `Project` (no `ProjectListItem` wrapper)

We keep `taskCounts?: { nuevo, enProgreso, hecho, total }` on the same `Project` entity as today. Promoting to a separate `ProjectListItem` type would require renaming the `list()` return type and ripples into every consumer. Marginal type-safety gain doesn't justify the churn. The shape is unchanged from change 1's domain entity — only the provenance changes (now from `Stage.category`, not `status`).

### AD-4: Compute `taskCounts` in-process from a single `findMany` (not GROUP BY)

Two implementation options:

- **(A) `findMany` with `include: { tasks: { select: { stage: { select: { category: true } } } } }`** then `reduce` in JS. One query per `list()` call. Memory cost: O(projects × tasks/project). For the current scale (<100 projects, <100 tasks each) this is fine.
- **(B) Raw SQL with `LEFT JOIN ScheduledTask ON Project.id` + `GROUP BY Project.id, Stage.category`** and pivot in JS. Constant memory regardless of task count.

**Decision**: ship (A) now, document (B) as the optimization path. Trigger for switching: median project has >1k tasks OR `/api/projects` p95 latency >300ms. Both are far away.

### AD-5: Single `update()` method handles partners (NOT separate `setPartners()` port method)

We keep `ProjectRepository` narrow:

```ts
update(id: string, data: UpdateProjectInput): Promise<Project | null>
```

where `UpdateProjectInput` includes optional `partnerIds?: string[]`. Rationale:

- Use cases stay simple — one call, one transaction.
- Partial-update semantics ("if `partnerIds` is undefined, do not touch partners") is well-defined and matches the route contract.
- Adding `setPartners(id, ids)` as a separate method splits the transaction boundary across two adapter calls, increases the port surface, and forces callers to think about ordering.

Trade-off: callers that want to update ONLY partners must still send `partnerIds` in a PUT body that may include other fields. That's fine — REST PUT is partial-update here (already the case for `title`/`description`).

### AD-6: PUT /:id accepts all fields including `partnerIds` — NO sub-routes

We reject the alternative of `PUT /:id/partners`, `PUT /:id/lead`, `PUT /:id/workflow`. Justification:

- Sub-routes inflate the URL surface, multiply the auth/validation/test cost by 4×, and DO NOT add capability — the Splynx UI form sends the whole project at once anyway.
- The Splynx snapshot shows a single edit form, not per-field PATCHes.
- One route, one zod schema, one use case is simpler to reason about.

Trade-off: clients that want to change one field must read-modify-write. Acceptable given the current frontend pattern.

### AD-7: One domain-error type per missing FK (NOT one generic `ReferenceNotFoundError`)

The five FK error codes (`CATEGORY_NOT_FOUND`, `TYPE_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `LEAD_NOT_FOUND`, `PARTNER_NOT_FOUND`) need to be discriminable in the route handler so the right HTTP `code` is returned. Options:

- **(A)** One generic `ReferenceNotFoundError` carrying a `reference: 'category' | 'type' | …` field. Route maps to a string lookup.
- **(B)** Five distinct error classes extending a common `DomainError` base.

**Decision**: ship **(A)** — `ReferenceNotFoundError { reference, id }` with a const map `REFERENCE_TO_CODE` in the route file. Less class proliferation, and the `code` field is data, not type. The five classes (B) buy nothing pattern-matching-wise in TS land.

### AD-8: Project deletion does NOT cascade to `ScheduledTask` — sets `projectId = NULL`

The current `ScheduledTask.project` relation is `Project?  @relation(fields: [projectId], references: [id])` (no explicit `onDelete`, so Prisma defaults to `SetNull` for an optional FK). We keep this behavior. Rationale:

- Tasks have business value independent of the project (history, audit). Cascading deletes them would erase data.
- A future "soft delete" change might revisit this.

`ProjectPartner` rows DO cascade-delete (`onDelete: Cascade`) because they're pure join rows with no independent meaning.

### AD-9: `?visible=` filter shipped in this change

The Splynx UI surfaces `Visible` in the listing. Implementing the filter now is one line on the adapter (`where: { visible: visible ?? undefined }`) and the spec already covers it (REQ-LIST-4). Cost-to-defer would be a follow-up just to add a query parameter. Ship now.

### AD-10: Auth fix in this change, not change 6

This is a behavioral change (anonymous callers used to succeed on `/api/projects`; they now get 401). The opportunistic fix is in scope because the route file is being rewritten anyway. Future-us reading this should know: the original 6-change plan slotted the auth fix in change 6 (`scheduling-tasks-views`); we pulled it forward because (a) it's a security bug, (b) the touch-the-file-anyway argument applies, (c) the frontend is already sending the cookie so no coordinated breaking change. Change 6's scope shrinks by this one item — documented when change 6 is opened.

## Data Flow

```
Client → POST /api/projects { title, categoryId, workflowId, partnerIds: [...] }
         │
         ▼
      auth middleware ──── 401 if no/bad cookie ──── done
         │
         ▼
      zod safeParse  ──── 400 VALIDATION_ERROR ──── done
         │
         ▼
   CreateProject use case
         │
         ├── projectCategoryRepo.get(categoryId)  ──── null → throw ReferenceNotFoundError('category')
         ├── projectTypeRepo.get(typeId)           ──── null → throw …('type')
         ├── workflowRepo.get(workflowId)          ──── null → throw …('workflow')
         ├── adminRepo.findById(projectLeadId)     ──── null → throw …('lead')
         ├── partnerRepo.findByIds(partnerIds)    ──── any missing → throw …('partner')
         │
         ▼
   projectRepo.create(input)                  (transaction: insert Project + insert ProjectPartners)
         │
         ▼
   route → 201 + body
```

`PUT /:id` follows the same flow with conditional FK lookups (skip the check for FKs not present in the body). Catch block translates `ReferenceNotFoundError.reference` to the right HTTP `code` via the const map.

## File Changes

| File | Action | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | Modified | Add 5 columns + indexes to `Project`; new `ProjectPartner` model; add `Project[]` back-relation to `Partner`, `Admin`, `Workflow`, `ProjectCategory`, `ProjectType` |
| `prisma/migrations/<ts>_scheduling_projects_enrich/migration.sql` | New | DDL + idempotent data backfill |
| `src/domain/entities/project.ts` | Modified | Add `typeId/categoryId/workflowId/projectLeadId: string \| null`, `visible: boolean`, `partners: Array<{ id, name }>` |
| `src/domain/ports/ProjectRepository.ts` | Modified | Widen create/update input types |
| `src/domain/errors/projects.ts` | New | `ReferenceNotFoundError { reference: 'category'\|'type'\|'workflow'\|'lead'\|'partner', id: string }` |
| `src/application/dto/projects.dto.ts` | New | `CreateProjectSchema`, `UpdateProjectSchema`, `ListProjectsQuerySchema` |
| `src/application/use-cases/ListProjects.ts` | New | Reads optional `{ visible }` filter |
| `src/application/use-cases/GetProject.ts` | New | |
| `src/application/use-cases/CreateProject.ts` | New | FK validation + delegate to repo |
| `src/application/use-cases/UpdateProject.ts` | New | Conditional FK validation + delegate |
| `src/application/use-cases/DeleteProject.ts` | New | |
| `src/infrastructure/adapters/prisma/PrismaProjectRepository.ts` | Modified | Full rewrite (includes + transactional update + count derivation from `Stage.category`) |
| `src/infrastructure/adapters/in-memory/InMemoryProjectRepository.ts` | Modified | Mirror new fields; FK lookups happen at the use-case layer, not in-memory adapter |
| `src/infrastructure/http/routes/projects.routes.ts` | Modified | Auth middleware + zod + error translation |
| `src/infrastructure/http/app.ts` | Modified | New factory call, ≈15 added lines — flagged |
| `src/__tests__/application/use-cases/CreateProject.test.ts` | New | TDD red-first; FK error cases |
| `src/__tests__/application/use-cases/UpdateProject.test.ts` | New | Partner replace-set semantics |
| `src/__tests__/application/use-cases/ListProjects.test.ts` | New | taskCounts derivation; visible filter |
| `src/__tests__/application/use-cases/GetProject.test.ts` | New | Happy path + not found |
| `src/__tests__/application/use-cases/DeleteProject.test.ts` | New | Happy path + cascade behavior |
| `src/__tests__/infrastructure/http/routes/projects.routes.test.ts` | New | Auth + validation + happy path + FK errors + replace-set |
| `src/__tests__/infrastructure/http/projects-composition.test.ts` | New | Sanity-check route shadowing |

## Interfaces / Contracts

```ts
// src/domain/entities/project.ts
export interface Project {
  id: string;
  title: string;
  description: string | null;
  typeId: string | null;
  categoryId: string | null;
  workflowId: string | null;
  projectLeadId: string | null;
  visible: boolean;
  partners: Array<{ id: string; name: string }>;
  taskCounts?: {
    nuevo: number;
    enProgreso: number;
    hecho: number;
    total: number;
  };
  createdAt: string;
  updatedAt: string;
}

// src/domain/ports/ProjectRepository.ts
export interface CreateProjectInput {
  title: string;
  description?: string | null;
  typeId?: string | null;
  categoryId?: string | null;
  workflowId?: string | null;
  projectLeadId?: string | null;
  visible?: boolean;
  partnerIds?: string[];
}
export interface UpdateProjectInput extends Partial<CreateProjectInput> {}
export interface ListProjectsFilter { visible?: boolean }

export interface ProjectRepository {
  list(filter?: ListProjectsFilter): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(data: CreateProjectInput): Promise<Project>;
  update(id: string, data: UpdateProjectInput): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
}

// src/domain/errors/projects.ts
export type ReferenceKind = 'category' | 'type' | 'workflow' | 'lead' | 'partner';
export class ReferenceNotFoundError extends Error {
  constructor(public readonly reference: ReferenceKind, public readonly id: string) {
    super(`${reference} not found: ${id}`);
    this.name = 'ReferenceNotFoundError';
  }
}

// src/application/dto/projects.dto.ts (sketch)
export const CreateProjectSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  typeId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  workflowId: z.string().uuid().nullable().optional(),
  projectLeadId: z.string().uuid().nullable().optional(),
  visible: z.boolean().optional(),
  partnerIds: z.array(z.string().uuid()).optional(),
});
export const UpdateProjectSchema = CreateProjectSchema.partial();
export const ListProjectsQuerySchema = z.object({
  visible: z.enum(['true', 'false']).optional(),
});

// Route error mapping
const REFERENCE_TO_CODE: Record<ReferenceKind, string> = {
  category: 'CATEGORY_NOT_FOUND',
  type:     'TYPE_NOT_FOUND',
  workflow: 'WORKFLOW_NOT_FOUND',
  lead:     'LEAD_NOT_FOUND',
  partner:  'PARTNER_NOT_FOUND',
};
```

## Testing Strategy

| Layer | Tool | Focus |
|-------|------|-------|
| Unit (use cases) | Jest + `InMemoryProjectRepository` + `InMemory{Category,Type,Workflow,Partner,Admin}Repository` | FK validation paths, partner replace-set, visible filter, taskCounts derivation |
| Unit (DTOs) | Jest (no harness needed) | Schema rejects invalid types; partial schema accepts every-field omitted |
| Integration (routes) | Supertest against Express app wired with in-memory repos | Auth (401 on every route), validation (400 with `VALIDATION_ERROR`), happy CRUD, FK errors (404 with right `code`), replace-set, `?visible=` filter |
| Composition | Supertest mounting `projectsRouter` only (and any sibling stubs) | Route shadowing sanity — flagged from change 1 lesson |
| Type | `tsc --noEmit` | DIP preservation (no `@infrastructure/*` imports from application) |
| End-to-end smoke | curl scripts (see `tasks.md §5`) | Real DB roundtrip post-deploy |

Strict TDD: each use case starts with a failing test that asserts the FK error code, then the implementation makes it green.

## Migration / Rollout

### Up SQL (sketch — actual file generated by `prisma migrate dev`, but verify it matches)

```sql
-- DDL ------------------------------------------------------------
ALTER TABLE "Project" ADD COLUMN "typeId"          TEXT;
ALTER TABLE "Project" ADD COLUMN "categoryId"      TEXT;
ALTER TABLE "Project" ADD COLUMN "workflowId"      TEXT;
ALTER TABLE "Project" ADD COLUMN "projectLeadId"   TEXT;
ALTER TABLE "Project" ADD COLUMN "visible"         BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_typeId_fkey"
    FOREIGN KEY ("typeId")        REFERENCES "ProjectType"("id")     ON DELETE SET NULL,
  ADD CONSTRAINT "Project_categoryId_fkey"
    FOREIGN KEY ("categoryId")    REFERENCES "ProjectCategory"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Project_workflowId_fkey"
    FOREIGN KEY ("workflowId")    REFERENCES "Workflow"("id")        ON DELETE SET NULL,
  ADD CONSTRAINT "Project_projectLeadId_fkey"
    FOREIGN KEY ("projectLeadId") REFERENCES "Admin"("id")           ON DELETE SET NULL;

CREATE INDEX "Project_categoryId_idx"     ON "Project"("categoryId");
CREATE INDEX "Project_typeId_idx"         ON "Project"("typeId");
CREATE INDEX "Project_workflowId_idx"     ON "Project"("workflowId");
CREATE INDEX "Project_projectLeadId_idx"  ON "Project"("projectLeadId");
CREATE INDEX "Project_visible_idx"        ON "Project"("visible");

CREATE TABLE "ProjectPartner" (
  "projectId" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  CONSTRAINT "ProjectPartner_pkey" PRIMARY KEY ("projectId", "partnerId"),
  CONSTRAINT "ProjectPartner_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE,
  CONSTRAINT "ProjectPartner_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT
);
CREATE INDEX "ProjectPartner_partnerId_idx" ON "ProjectPartner"("partnerId");

-- Data backfill --------------------------------------------------
-- Idempotent: only updates rows that haven't been backfilled yet.
-- Uses DO $$ ... WHERE NOT EXISTS $$ pattern per change-1 lesson.
DO $$
DECLARE
  default_workflow_id TEXT;
BEGIN
  SELECT "id" INTO default_workflow_id
  FROM "Workflow"
  WHERE "name" = 'Default'
  LIMIT 1;

  IF default_workflow_id IS NOT NULL THEN
    UPDATE "Project"
    SET "workflowId" = default_workflow_id
    WHERE "workflowId" IS NULL;
  ELSE
    RAISE NOTICE 'Default workflow not found — projects retain workflowId = NULL. Re-run prisma:seed to restore.';
  END IF;
END $$;
```

**Critical**: NO `ON CONFLICT ON CONSTRAINT <index_name>` anywhere in this migration. We do not introduce any new UNIQUE constraints; the backfill is a plain `UPDATE`.

### Down SQL

```sql
DROP TABLE IF EXISTS "ProjectPartner";
DROP INDEX IF EXISTS "Project_visible_idx";
DROP INDEX IF EXISTS "Project_projectLeadId_idx";
DROP INDEX IF EXISTS "Project_workflowId_idx";
DROP INDEX IF EXISTS "Project_typeId_idx";
DROP INDEX IF EXISTS "Project_categoryId_idx";
ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_projectLeadId_fkey";
ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_workflowId_fkey";
ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_categoryId_fkey";
ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_typeId_fkey";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "visible";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "projectLeadId";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "workflowId";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "categoryId";
ALTER TABLE "Project" DROP COLUMN IF EXISTS "typeId";
```

### Rollout

1. Merge → run `npm run prisma:migrate` in each environment.
2. The data backfill is automatic and idempotent.
3. Verify post-deploy with the curl smoke (tasks §5).

## Open Questions

- Should `projectLeadId` reject pointing at a disabled/deactivated `Admin`? Out of scope here — defer to a follow-up that defines admin lifecycle states.
- Do we need a `?categoryId=` / `?typeId=` query filter on `/api/projects`? Not in scope; can be added when the frontend asks for it.
- Cursor pagination on `/api/projects`? Out of scope; the current scale doesn't require it.
