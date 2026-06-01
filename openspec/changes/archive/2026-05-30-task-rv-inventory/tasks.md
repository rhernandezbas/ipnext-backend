# Tasks: task-rv-inventory

## Baseline
- `npm test` → 128 suites, 920 tests (911 passed, 9 skipped) ✅
- `npx tsc --noEmit` → 0 errors ✅

---

## Phase 1 — Schema

- [x] 1.1 Add `reviewedByInventory Boolean @default(false)` to `model ScheduledTask` in `prisma/schema.prisma` with `@@index([reviewedByInventory])`.
- [ ] 1.2 Run `npm run prisma:migrate` to generate migration. **If DB not reachable: report and leave schema change in place for user to run.**
- [x] 1.3 Commit: `feat(schema): add reviewedByInventory to ScheduledTask`

---

## Phase 2 — Domain + Port + In-Memory (TDD)

- [x] 2.1 Add `reviewedByInventory: boolean` to `ScheduledTask` interface in `src/domain/entities/scheduling.ts`.
- [x] 2.2 Add `setInventoryReview(taskId: string, reviewed: boolean): Promise<ScheduledTask | null>` to `SchedulingRepository` interface in `src/domain/ports/SchedulingRepository.ts`.
- [x] 2.3 Add `reviewedByInventory: false` to `NEW_FIELDS_DEFAULTS` in `InMemorySchedulingRepository.ts`.
- [x] 2.4 Add `reviewedByInventory: false` to `createTask` return in `InMemorySchedulingRepository.ts`.
- [x] 2.5 Implement `setInventoryReview` method in `InMemorySchedulingRepository.ts`.
- [x] 2.6 Update `toTask` mapper in `PrismaSchedulingRepository.ts` to include `reviewedByInventory: row.reviewedByInventory ?? false`.
- [x] 2.7 Implement `setInventoryReview` in `PrismaSchedulingRepository.ts`.
- [x] 2.8 `npx tsc --noEmit` → 0 errors.
- [x] 2.9 Commit: `feat(domain): add reviewedByInventory field, port method, and adapter implementations`

---

## Phase 3 — Use Case (TDD: test first)

- [x] 3.1 [TDD RED] Create `src/__tests__/application/SetTaskInventoryReview.test.ts` — write failing test.
- [x] 3.2 [TDD GREEN] Create `src/application/use-cases/SetTaskInventoryReview.ts` — implement; test passes.
- [x] 3.3 `npx tsc --noEmit` → 0 errors.
- [x] 3.4 Commit: `feat(tasks): add SetTaskInventoryReview use case`

---

## Phase 4 — Route + Wire (TDD: test first)

- [x] 4.1 [TDD RED] Create `src/__tests__/infrastructure/scheduling.inventoryReview.test.ts` — write failing supertest tests covering SCEN-RV-1 through SCEN-RV-4.
- [x] 4.2 [TDD GREEN] Add `PATCH /:id/inventory-review` to `createSchedulingRouter` — tests pass.
- [x] 4.3 Update `createSchedulingRouter` signature to accept `setTaskInventoryReview?: SetTaskInventoryReview` parameter (optional, consistent with checklist pattern).
- [x] 4.4 Wire `SetTaskInventoryReview` in `src/infrastructure/http/app.ts`.
- [x] 4.5 `npx tsc --noEmit` → 0 errors.
- [x] `npm test` → all existing + new tests pass.
- [x] 4.6 Commit: `feat(tasks): add PATCH inventory-review route and wire app.ts`
