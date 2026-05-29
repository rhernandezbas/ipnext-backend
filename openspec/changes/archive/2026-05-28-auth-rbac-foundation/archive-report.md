# Archive Report: auth-rbac-foundation

**Change**: auth-rbac-foundation
**Date Archived**: 2026-05-28
**Artifact Store**: hybrid (engram + openspec)
**Archive Path**: openspec/changes/archive/2026-05-28-auth-rbac-foundation/

## SDD Cycle Complete

All 7 phases of apply executed under Strict TDD. 1 verify with PASS_WITH_WARNINGS, all 6 warnings remediated pre-archive.

## Capabilities Added (4 new)

| Capability | Main Spec Path |
|------------|----------------|
| rbac-data-model | openspec/specs/rbac-data-model/spec.md |
| rbac-seed | openspec/specs/rbac-seed/spec.md |
| rbac-ports | openspec/specs/rbac-ports/spec.md |
| rbac-middleware | openspec/specs/rbac-middleware/spec.md |

## Summary of What Was Built

- 6 Prisma tables (RbacModule, RbacRole, RbacPermission, RbacUser, RbacUserRole, RbacRolePermission) + RbacAction enum (read/write/delete/manage)
- 1 additive migration `20260529000000_auth_rbac_foundation` with idempotent seed (14 modules × 4 actions = 56 permissions, 6 system roles, super_admin gets all 56 grants via CROSS JOIN, ON CONFLICT DO NOTHING everywhere)
- 5 domain ports + 5 InMemory adapters + 5 Prisma adapters (Rbac* naming, hexagonal boundary clean)
- `requirePermission(module, action)` Express middleware with super_admin short-circuit, fail-closed on unknown modules
- DI wiring in app.ts: 12 lines added, `requirePerm` exported for future routes

## Locked Decisions

1. 14 modules, 4 actions, 6 system roles (super_admin, administrador [dueño], administracion [contabilidad], ventas, noc, tecnico)
2. Seed minimal: only super_admin has permissions; others empty (UI manages via SDD #3)
3. `label` (not `name`) for catalog display fields; `RbacUser.name` is the person's name
4. `passwordHash` NOT NULL; `login` unique global
5. PostgreSQL 13+ (gen_random_uuid) confirmed in prod
6. Middleware error codes: 401 NO_USER_CONTEXT, 403 PERMISSION_DENIED
7. Enum at DB level for `RbacAction` (type safety, no FK overhead)
8. Per-request resolution (no in-process cache; caching deferred to SDD #5)

## Tests
- 85 RBAC-specific tests added (1252 → 1253 final)
- Full suite green, 60 skipped (integration tests gated by DATABASE_URL_TEST)
- tsc --noEmit clean

## Manual Checkpoints
- 3.4 — SQL review: APPROVED by user pre-archive
- 7.3 — Post-deploy DB count verification: PENDING (runs after user pushes to main)

## Follow-on SDDs (planned, not started)
- user-management-crud (BE+FE) — uses RbacUser ports
- roles-permissions-management (BE+FE) — UI for RbacRole + RbacRolePermission matrix
- audit-log-mutations (BE+FE) — new tab
- sessions-management (BE+FE) — new tab
- security-hardening (BE+FE) — depends on audit + sessions
