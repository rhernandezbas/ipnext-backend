# Tasks: task-comments

All tasks completed in one session (strict TDD: test first).

## Schema + Migration
- [x] Add `TaskComment` and `TaskCommentAttachment` models to `prisma/schema.prisma`
- [x] Add `comments TaskComment[]` back-relation to `ScheduledTask`
- [x] Generate migration SQL via `prisma migrate diff`
- [x] Create `prisma/migrations/20260527110000_add_task_comments/migration.sql`
- [x] Run `prisma generate` to update the Prisma client

## Domain
- [x] Create `src/domain/entities/taskComment.ts` — `TaskComment` + `TaskCommentAttachment` interfaces
- [x] Create `src/domain/ports/TaskCommentRepository.ts` — `listByTask`, `create`, `delete`

## Adapters
- [x] Create `src/infrastructure/adapters/in-memory/InMemoryTaskCommentRepository.ts`
- [x] Create `src/infrastructure/adapters/prisma/PrismaTaskCommentRepository.ts`

## Use cases (test first — RED → GREEN)
- [x] Write tests in `src/__tests__/application/TaskComments.test.ts`
- [x] `src/application/use-cases/ListTaskComments.ts`
- [x] `src/application/use-cases/AddTaskComment.ts`
- [x] `src/application/use-cases/DeleteTaskComment.ts`

## Routes (test first — RED → GREEN)
- [x] Write tests in `src/__tests__/infrastructure/taskComments.routes.test.ts`
- [x] Create `src/infrastructure/http/routes/taskComments.routes.ts`

## Wiring
- [x] Wire `PrismaTaskCommentRepository` + use cases + router in `src/infrastructure/http/app.ts`
- [x] Mount BEFORE scheduling catch-all router

## Verification
- [x] `npx tsc --noEmit` — clean
- [x] `npm test` — 132 suites, 941 passed
