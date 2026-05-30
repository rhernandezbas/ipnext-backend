# Design: service-technology

## Architecture Decisions

### AD-1: Mirror TaskCategory pattern exactly
`TaskCategory` is the established catalog reference in this codebase (string `name`, optional `description`, no FK — the name is stored free-text on the consuming model). `ServiceTechnology` mirrors it 1:1:

| Concern | TaskCategory | ServiceTechnology |
|---------|-------------|-------------------|
| Entity | `src/domain/entities/taskCategory.ts` (`{ id, name, description }`) | `src/domain/entities/serviceTechnology.ts` (same shape) |
| Port | `TaskCategoryRepository` (list/getById/getByName/create/update/delete/`countTasksUsing`) | `ServiceTechnologyRepository` (same + `countServicesUsingTechnology`) |
| Use cases | Create/List/Get/Update/Delete + verb+noun, 1 file each | Same 5 |
| Adapters | `PrismaTaskCategoryRepository` + `InMemoryTaskCategoryRepository` | `Prisma…` + `InMemory…` |
| Router | `taskCategories.routes.ts` | `serviceTechnologies.routes.ts` |
| Errors | `@domain/errors/scheduling` | `@domain/errors/serviceTechnology` |
| DTO/Zod | `scheduling.dto.ts` | `serviceTechnology.dto.ts` |

**Rationale**: lowest-risk path. The pattern is proven, tested, and the wiring in `app.ts` already exists as copy-paste reference (lines 620-625, 856-860). No new architecture is invented.

### AD-2: Phase 1 = catalog CRUD + nullable string column; FK is Phase 2
`Service.technology` is a nullable free-text `String?` storing the technology **name** — NOT a FK to `ServiceTechnology.id`. This is intentional and matches the `TaskCategory` ↔ `ScheduledTask.category` relationship.

**Approaches compared:**
- **A — Nullable string column (chosen)**: additive, zero-downtime, no backfill, no risk on live GR-mirrored data. Delete-guard counts `Service` rows where `technology = name`. Identical to `TaskCategory.countTasksUsing` → `scheduledTask.count({ where: { category } })`.
- **B — FK relation now (`technologyId String?` → `ServiceTechnology.id`)**: relational integrity, but requires a destructive/multi-step migration on a live mirror table, plus a rename guard, plus touching the GR upsert. Deferred to Phase 2 (out of scope per proposal).

Rationale: B buys integrity we don't need yet and forces risk onto a table that the GR sync writes to continuously. A is the same tradeoff the codebase already accepted for `TaskCategory`.

### AD-3: Delete guard by name
`DeleteServiceTechnology` calls `repo.countServicesUsingTechnology(name)`; if `> 0` → throw `ServiceTechnologyInUseError` (→ HTTP 409, code `SERVICE_TECHNOLOGY_IN_USE`). The use case must `getById` first to resolve the entry's `name`, then count. Mirrors `DeleteTaskCategory`.

- Prisma adapter: `prisma.service.count({ where: { technology: name } })`.
- InMemory adapter: a public `serviceCounts: Record<string, number>` test seam (same shape as `InMemoryTaskCategoryRepository.taskCounts`).

### AD-4: Case-insensitive name uniqueness at the use-case layer
`name` is `@unique` at the DB level, but the case-insensitive check (`"Fiber"` conflicts with `"FIBER"`) is enforced in the use case via `repo.getByName(name)`, where `getByName` does a `toLowerCase()` comparison. Identical to `PrismaTaskCategoryRepository.getByName` (loads all rows, compares lowercased — acceptable for a small catalog). Stored value keeps original casing.

### AD-5: Route prefix and mount point — `/api/service-technologies` at the `/api` root
The spec requires `GET /api/service-technologies`. Unlike `TaskCategory` (mounted under `/api/scheduling` because it lives inside the scheduling domain and must precede a catch-all), `ServiceTechnology` has **no parent catch-all router** competing for the path, so it mounts cleanly at the `/api` root.

The router defines paths `/service-technologies` and `/service-technologies/:id`, and is mounted with `app.use('/api', createServiceTechnologiesRouter(...))`.

**Approaches compared:**
- **A — mount at `/api` (chosen)**: matches the spec URL exactly; no ordering constraint because no `/api/:id` catch-all exists.
- **B — mount under `/api/services`**: would couple the catalog to the (future) services router and risk a `/:id` catch-all swallowing `/service-technologies`. Rejected — the catalog is independent of the `Service` CRUD.

### AD-6: GR sync does NOT overwrite `technology` — confirmed by code review
`PrismaClientMirrorRepository.upsertContract` (`src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts:78-110`) builds an explicit literal `data` object containing only `{ type, plan, status, startDate, address, lat, lng }`. It uses `prisma.service.update({ data })` / `prisma.service.create({ data: { ...data, grContratoId, clientId } })`. Because Prisma `update` only touches keys present in `data`, and `technology` is never added, **the GR upsert leaves `technology` untouched on existing rows and leaves it NULL on inserts**. This satisfies spec scenario ST-7.2.

**Guard note (task)**: add an inline comment above the `data` literal in `upsertContract` documenting that `technology` is intentionally excluded so a future edit doesn't accidentally include it. No logic change.

---

## Migration Strategy

There is **no dev database** available, so the migration cannot be generated by `prisma migrate dev`. Instead, generate the SQL from the schema diff and hand-place it.

### Schema changes (`prisma/schema.prisma`)

1. New model (mirror `TaskCategory` at lines 485-493):
```prisma
// Editable catalog of service technologies (Fiber, DOCSIS, Wireless, ...).
// Service.technology stores the name (free text) — no FK relation in Phase 1.
model ServiceTechnology {
  id          String   @id @default(uuid())
  name        String   @unique
  description String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@map("ServiceTechnology")
}
```

2. New column on `Service` (model at lines 207-226), nullable, additive, no default:
```prisma
model Service {
  ...
  lng          Float?
  technology   String?   // Phase 1: free-text name from ServiceTechnology catalog. NOT a FK.
  createdAt    DateTime  @default(now())
  ...
}
```

### Generating the migration without a dev DB

Use `prisma migrate diff` to emit SQL from the previous migration state to the new schema:

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/<timestamp>_service_technology/migration.sql
```

Then create the migration directory manually with the canonical timestamp prefix (e.g. `20260530120000_service_technology`). Expected generated SQL (additive only — review before committing):

```sql
CREATE TABLE "ServiceTechnology" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServiceTechnology_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceTechnology_name_key" ON "ServiceTechnology"("name");

ALTER TABLE "Service" ADD COLUMN "technology" TEXT;
```

**Safety**: both statements are purely additive. The `ALTER TABLE ... ADD COLUMN` with no `NOT NULL` / no default is a metadata-only change in Postgres — zero rewrite, zero downtime, all existing rows get `technology = NULL` (satisfies ST-7.1).

**Rollback**: `DROP TABLE "ServiceTechnology"; ALTER TABLE "Service" DROP COLUMN "technology";` — no existing data affected.

### Seed (ST-6)
Add to `prisma/seed.ts` using the existing `createMany({ skipDuplicates: true })` catalog pattern:
```ts
await prisma.serviceTechnology.createMany({
  data: [
    { name: 'Fiber',    description: 'Fibra óptica' },
    { name: 'DOCSIS',   description: 'Cable / HFC DOCSIS' },
    { name: 'Wireless', description: 'Enlace inalámbrico' },
    { name: 'FTTH',     description: 'Fiber to the home' },
    { name: 'HFC',      description: 'Híbrido fibra-coaxial' },
    { name: 'Radio',    description: 'Radioenlace' },
  ],
  skipDuplicates: true,
});
```

---

## DI Wiring (`app.ts` God Object risk)

`app.ts` is already a large composition root. The proposal flags God-Object growth as a risk. To keep the footprint minimal, the wiring mirrors `TaskCategory` exactly and adds the **smallest possible delta**:

1. Imports (next to the TaskCategory imports, lines 131-160): one Prisma repo import, one router-factory import, five use-case imports.
2. Construction (next to lines 620-625): one repo + five use cases.
3. Mount (next to lines 856-860):
```ts
// ServiceTechnology catalog — mounted at /api root (no catch-all conflict).
app.use('/api', createServiceTechnologiesRouter(
  authAdapter,
  listServiceTechnology, getServiceTechnology, createServiceTechnology,
  updateServiceTechnology, deleteServiceTechnology,
));
```

No factory extraction is performed in this change (would be a separate refactor). The delta is ~12 lines, consistent with how every other catalog was wired. Documented here so the God-Object growth is a conscious, bounded decision.

---

## RBAC Note (cross-repo dependency)

> **DECISION OVERRIDDEN BY PRODUCT** — see implementation notes below.

**Original design**: no RBAC permission for catalog endpoints; auth-only like `taskCategories.routes.ts`. Authorization for the frontend page would reuse `clients.read`.

**Final product decision**: create a dedicated `contracts` RBAC module with 4 base permissions (`read`, `write`, `delete`, `manage`). Rationale: contracts/services are a distinct domain from clients, and the FE contracts page needs its own permission to gate access independently.

### Implementation (overrides design):

- Added `'contracts'` to `RBAC_MODULES` in `src/domain/entities/rbac.ts` (now 26 modules: 14 original + 11 Phase-2 + 1 contracts).
- Migration `20260530040000_service_technology/migration.sql` seeds the module, 4 base permissions, and grants:
  - `super_admin`: all 4 permissions
  - `administrador`: `read` + `write`
  - `administracion`, `ventas`, `noc`, `tecnico`: `read` only

**RBAC permission codes (for FE consumption)**:
- `contracts.read` — view contracts/services list and detail
- `contracts.write` — create/update contracts
- `contracts.delete` — delete contracts
- `contracts.manage` — full management

The catalog endpoints (`/api/service-technologies`) remain auth-only (no RBAC permission check). The `contracts.*` permissions are for the FE to gate its contracts page.

---

## Testing Strategy (STRICT TDD)

- **Use cases** (`src/__tests__/application/`): test each of the 5 use cases against `InMemoryServiceTechnologyRepository`. Red → green → refactor. Cover: name conflict (case-insensitive), not-found, in-use delete guard, partial update.
- **Routes** (`src/__tests__/infrastructure/http/routes/serviceTechnologies.routes.test.ts`): supertest against an Express app with the InMemory repo injected. Cover all scenarios ST-1…ST-5 (status codes + error `code` strings + 401 unauth).
- **No Prisma mocking** — use the InMemory port (project rule).
- The GR no-overwrite behavior (ST-7.2) is asserted by code review (AD-6) + the inline guard comment; an optional regression test can assert `upsertContract`'s `data` object has no `technology` key.
- Verification: `npm test` green + `npx tsc --noEmit` clean.
