# Tasks: Auth & RBAC Foundation

## Phase 1 — Domain Layer (entities + ports)

- [x] 1.1 [RED] Write failing test for `RbacUser`, `RbacRole`, `RbacPermission`, `RbacModule` entity shapes and `RBAC_MODULES` / `SYSTEM_ROLES` constants in `src/__tests__/domain/entities/rbac.test.ts`
- [x] 1.2 [GREEN] Create `src/domain/entities/rbac.ts` — export `PermissionAction`, `RbacModuleCode`, `SystemRoleCode`, `RBAC_MODULES`, `SYSTEM_ROLES`, and the 4 domain interfaces
- [x] 1.3 [RED] Write contract tests for all 5 port interfaces in `src/__tests__/domain/ports/rbac-contracts.test.ts` (compile-time shape checks using `InMemory*` stubs as type witnesses)
- [x] 1.4 [GREEN] Create `src/domain/ports/RbacUserRepository.ts` — export `CreateRbacUserInput` + `RbacUserRepository` interface
- [x] 1.5 [GREEN] Create `src/domain/ports/RbacRoleRepository.ts` — export `RbacRoleRepository` interface
- [x] 1.6 [GREEN] Create `src/domain/ports/RbacPermissionRepository.ts` — export `RbacPermissionRepository` interface
- [x] 1.7 [GREEN] Create `src/domain/ports/RbacUserRoleRepository.ts` — export `RbacUserRoleRepository` interface
- [x] 1.8 [GREEN] Create `src/domain/ports/RbacRolePermissionRepository.ts` — export `RbacRolePermissionRepository` interface
- [x] 1.9 Modify `src/domain/ports/index.ts` — re-export all 5 new port interfaces

## Phase 2 — InMemory Adapters (TDD seam)

- [x] 2.1 [RED] Write contract test for `InMemoryRbacUserRepository` in `src/__tests__/infrastructure/adapters/in-memory/rbac/rbacUser.test.ts` — covers `create`, `findById`, `findByLogin`, `listRolesForUser`, `listPermissionsForUser`
- [x] 2.2 [GREEN] Create `src/infrastructure/adapters/in-memory/InMemoryRbacUserRepository.ts`
- [x] 2.3 [RED] Write contract test for `InMemoryRbacRoleRepository` in `src/__tests__/infrastructure/adapters/in-memory/rbac/rbacRole.test.ts` — covers `findById`, `findByCode`, `listAll`
- [x] 2.4 [GREEN] Create `src/infrastructure/adapters/in-memory/InMemoryRbacRoleRepository.ts`
- [x] 2.5 [RED] Write contract test for `InMemoryRbacPermissionRepository` in `src/__tests__/infrastructure/adapters/in-memory/rbac/rbacPermission.test.ts` — covers `listAll`, `findByModuleAndAction`
- [x] 2.6 [GREEN] Create `src/infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository.ts`
- [x] 2.7 [RED] Write contract test for `InMemoryRbacUserRoleRepository` in `src/__tests__/infrastructure/adapters/in-memory/rbac/rbacUserRole.test.ts` — covers `assign` (idempotent), `revoke`, `listForUser`
- [x] 2.8 [GREEN] Create `src/infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository.ts`
- [x] 2.9 [RED] Write contract test for `InMemoryRbacRolePermissionRepository` in `src/__tests__/infrastructure/adapters/in-memory/rbac/rbacRolePermission.test.ts` — covers `grant`, `revoke`, `listForRole`
- [x] 2.10 [GREEN] Create `src/infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository.ts`
- [x] 2.11 Verify `npm test` — all Phase 1 + 2 tests green

## Phase 3 — Prisma Schema + Migration

- [x] 3.1 Modify `prisma/schema.prisma` — add `RbacAction` enum + 6 models (`RbacModule`, `RbacPermission`, `RbacRole`, `RbacUser`, `RbacUserRole`, `RbacRolePermission`) with FK behaviors and indexes per design
- [x] 3.2 Generate baseline DDL: `npx prisma migrate diff --from-schema /tmp/rbac-before.prisma --to-schema prisma/schema.prisma --script -o prisma/migrations/20260529000000_auth_rbac_foundation/migration.sql`
- [x] 3.3 Append idempotent seed SQL to `migration.sql`: 14 modules → 56 permissions → 6 roles → super_admin's 56 grants (all via `INSERT … ON CONFLICT DO NOTHING`)
- [ ] 3.4 [MANUAL CHECKPOINT] User reviews and approves `migration.sql` before applying — inspect DDL correctness + seed completeness

## Phase 4 — Prisma Adapters

- [x] 4.1 [RED] Write integration test skeleton `src/__tests__/infrastructure/adapters/prisma/rbac-migration.test.ts` — asserts 14 modules, 56 permissions, 6 roles; `describe.skip` guard when `DATABASE_URL_TEST` is absent
- [x] 4.2 [GREEN] Create `src/infrastructure/adapters/prisma/PrismaRbacUserRepository.ts` — implements `RbacUserRepository`; `listPermissionsForUser` uses single nested include (no N+1)
- [x] 4.3 [GREEN] Create `src/infrastructure/adapters/prisma/PrismaRbacRoleRepository.ts` — implements `RbacRoleRepository`
- [x] 4.4 [GREEN] Create `src/infrastructure/adapters/prisma/PrismaRbacPermissionRepository.ts` — implements `RbacPermissionRepository`
- [x] 4.5 [GREEN] Create `src/infrastructure/adapters/prisma/PrismaRbacUserRoleRepository.ts` — implements `RbacUserRoleRepository`; `assign` uses `upsert` for idempotency
- [x] 4.6 [GREEN] Create `src/infrastructure/adapters/prisma/PrismaRbacRolePermissionRepository.ts` — implements `RbacRolePermissionRepository`; `grant` uses `upsert`
- [x] 4.7 Verify `tsc --noEmit` passes (no Prisma type leaks into domain/application)

## Phase 5 — Middleware

- [x] 5.1 [RED] Write `src/__tests__/infrastructure/middleware/requirePermission.test.ts` — 5 scenarios using supertest on a throwaway Express app seeded with `InMemoryRbacUserRepository`:
  - granted: user with role that has permission → `next()` (200)
  - denied: user lacks permission → 403 `PERMISSION_DENIED`
  - super_admin short-circuit: super_admin role → `next()` without permission lookup
  - no `req.user` → 401 `NO_USER_CONTEXT`
  - unknown module/action → 403 (fail-closed)
- [x] 5.2 [GREEN] Create `src/infrastructure/http/middleware/requirePermission.ts` — export `requirePermission(userRepo, module, action)` factory per design contract
- [x] 5.3 Modify `src/infrastructure/http/middleware/index.ts` — re-export `requirePermission`
- [x] 5.4 Verify `npm test` — all 5 middleware scenarios green; `tsc --noEmit` clean

## Phase 6 — DI Wiring in app.ts

- [x] 6.1 Modify `src/infrastructure/http/app.ts` — instantiate 5 `PrismaRbac*Repository` instances near existing repo block (~5 lines)
- [x] 6.2 Modify `src/infrastructure/http/app.ts` — export `requirePerm(m, a)` factory bound to `rbacUserRepo` (~3 lines); no route mounting
- [x] 6.3 Run `npm test` — full suite green (no regressions)
- [x] 6.4 Run `tsc --noEmit` — clean compile

## Phase 7 — Verification

- [x] 7.1 Run `npm test` — confirm all new tests pass, no existing tests broken
- [x] 7.2 Run `tsc --noEmit` — confirm zero type errors
- [ ] 7.3 Apply migration on local DB (`npm run prisma:migrate`) and manually verify seed rows: `SELECT count(*) FROM "RbacModule"` = 14, `SELECT count(*) FROM "RbacPermission"` = 56, `SELECT count(*) FROM "RbacRole"` = 6
