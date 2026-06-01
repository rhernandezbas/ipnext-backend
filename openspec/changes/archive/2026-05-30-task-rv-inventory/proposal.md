# Proposal: RV — Revisado por Inventario

## Intent

Add a boolean flag `reviewedByInventory` to `ScheduledTask` representing whether a task was reviewed by the inventory team. The flag drives the "RV" column in the task list UI (sí/no engine, green/red indicator). Backend-only change.

## Scope

### In Scope
- Add `reviewedByInventory Boolean @default(false)` to the `ScheduledTask` model in `prisma/schema.prisma`
- Generate migration via `npm run prisma:migrate`
- Add `reviewedByInventory: boolean` to the `ScheduledTask` domain entity
- Add `setInventoryReview(taskId: string, reviewed: boolean): Promise<ScheduledTask | null>` to `SchedulingRepository` port
- Implement `SetTaskInventoryReview` use case (one file, verb+noun convention)
- Expose `reviewedByInventory` in the `toTask` Prisma mapper (already generic `row.x ?? false`)
- Add `PATCH /api/scheduling/:id/inventory-review` endpoint
- Wire in `app.ts` (minimal — one new use case, one router update)

### Out of Scope
- Frontend changes
- No new DTO type: the endpoint accepts `{ reviewed: boolean }` inline (simple enough, no separate DTO file)
- No filter by `reviewedByInventory` (not requested)
- No change to `UpdateTask` (dedicated endpoint per single-responsibility)

## Capabilities

### New Capabilities
- `task-rv-inventory`: Set/unset the inventory-review flag on a task via a dedicated PATCH endpoint.

### Modified Capabilities
- `scheduling`: `SchedulingRepository` port gains `setInventoryReview`; `ScheduledTask` entity gains `reviewedByInventory`.

## Approach

**4 commits following Strict TDD (red → green → refactor):**

1. **Commit 1** — `feat(schema): add reviewedByInventory to ScheduledTask`  
   Schema change + migration.

2. **Commit 2** — `feat(domain): add reviewedByInventory field and port method`  
   Entity field + port method + in-memory implementation (TDD: test first).

3. **Commit 3** — `feat(tasks): add SetTaskInventoryReview use case`  
   Use case + unit test (TDD: test first).

4. **Commit 4** — `feat(tasks): add PATCH inventory-review route + wire app.ts`  
   Route + supertest test + app.ts wiring.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | New field on ScheduledTask |
| `prisma/migrations/` | New | Migration for `reviewedByInventory` |
| `src/domain/entities/scheduling.ts` | Modified | New field on interface |
| `src/domain/ports/SchedulingRepository.ts` | Modified | New method on interface |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | Modified | Implement new method + seed defaults |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modified | Implement new method + mapper |
| `src/application/use-cases/SetTaskInventoryReview.ts` | New | Use case |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified | New PATCH endpoint |
| `src/infrastructure/http/app.ts` | Modified | Wire SetTaskInventoryReview |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| DB not reachable during migration | Med | Report clearly; schema change committed; user runs `npm run prisma:migrate` |
| Existing seeded tasks in in-memory break TypeScript | Low | Add `reviewedByInventory: false` to `NEW_FIELDS_DEFAULTS` |
| `toTask` mapper needs updating | Low | Already uses `row.x ?? false` pattern; add explicit field |

## Success Criteria

- [ ] `prisma/schema.prisma` contains `reviewedByInventory Boolean @default(false)` on `ScheduledTask`
- [ ] `ScheduledTask` domain entity has `reviewedByInventory: boolean`
- [ ] `SchedulingRepository` port has `setInventoryReview(taskId, reviewed): Promise<ScheduledTask | null>`
- [ ] `SetTaskInventoryReview` use case exists and is tested with in-memory repo
- [ ] `PATCH /api/scheduling/:id/inventory-review` endpoint exists, tested with supertest
- [ ] `reviewedByInventory` present in all task API responses
- [ ] `npx tsc --noEmit` → 0 errors
- [ ] `npm test` → all existing tests still pass + new tests added
