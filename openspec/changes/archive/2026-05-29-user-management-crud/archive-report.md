# Archive Report — user-management-crud (SDD #2)

**Archived**: 2026-05-29  
**Status**: completed  
**Repos**: `ipnext-backend` + `ipnext-frontend`  
**Depends on**: SDD #1 `auth-rbac-foundation`

---

## Summary

Full RBAC user management CRUD delivered across 9 phases (7 BE + 2 FE). The change converts SDD #1's dormant RBAC ports into a live admin surface: ten use cases, an Express router protected by `requirePerm('admin','manage')` (first production mount), a self-healing bootstrap script, and a React admin UI replacing the legacy `AdminsBody` tab.

---

## Phases Completed

### Backend (7 phases)

| Phase | Description |
|-------|-------------|
| BE-1 | `PasswordHasher` port + `BcryptPasswordHasher` + `InMemoryPasswordHasher` adapters |
| BE-2 | `RbacUserRepository` port extensions: `list`, `update`, `delete`, `updatePasswordHash`, `countUsersWithRoleCode` — InMemory + Prisma adapters updated |
| BE-3 | DTOs (`rbacUser.dto.ts`) — `RbacUserDto`, `RbacUserWithRolesDto`, `RbacRoleDto`, `CreateRbacUserDto`, `UpdateRbacUserDto` (with optional `password`). Type-level `passwordHash` exclusion. |
| BE-4 | 10 use cases under `src/application/use-cases/rbac/`: `ListRbacUsers`, `GetRbacUser`, `CreateRbacUser`, `UpdateRbacUser`, `DeleteRbacUser`, `ChangeRbacUserPassword`, `ListRolesForUser`, `AssignRoleToUser`, `RemoveRoleFromUser`, `SetRolesForUser` |
| BE-5 | `rbacUser.routes.ts` — Express router with all 10 handlers; `requirePerm('admin','manage')` applied at router level (first production mount); `actingUserId` from `req.user.id`; `PATCH /:id` supports optional `password` for admin-managed password change |
| BE-6 | DI wiring in `app.ts`: `BcryptPasswordHasher` instantiated; all 10 use cases wired; router mounted at `/api/admin/rbac/users`; read-only `/api/admin/rbac/roles` endpoint added |
| BE-7 | Bootstrap script `src/infrastructure/bootstrap/bootstrapRbac.ts`: self-heal behavior (hotfix `6f6e5ff4`) — if bootstrap login exists, UPDATE credentials + ensure super_admin; new `outcome: 'updated'`; `BootstrapResult` type updated (removed `user-already-exists`). Deploy step added to `.github/workflows/deploy.yml`. |

### Frontend (2 phases)

| Phase | Description |
|-------|-------------|
| FE-1 | Types (`rbacUser.ts`, `rbacRole.ts`), API modules (`rbacUsers.api.ts`, `rbacRoles.api.ts`), hooks (`useRbacUsers.ts`, `useRbacRoles.ts`), system role labels dict (`rbacRoleLabels.ts`) |
| FE-2 | `RbacUsersBody.tsx` + inline `RbacUserModal` — table with search/status filter, skeleton loading, empty state with bootstrap hint, role badges, edit/delete actions; modal with RHF validation, role multi-select, dual-layer error feedback; `AdminPage.tsx` patched to render `<RbacUsersBody/>` on the `admins` tab |

---

## Locked Decisions

| # | Decision |
|---|----------|
| 1 | Tab id `admins` kept stable; label changed to "Usuarios"; content replaced with `<RbacUsersBody/>`. Legacy `AdminsBody` deleted in SDD #6. |
| 2 | Bootstrap uses pre-computed bcrypt hash in env (`BOOTSTRAP_RBAC_PASSWORD_HASH`) — no plaintext password in envs or migration history. |
| 3 | At least one role required on create/set (no roleless users). FE `roleIds` dict hardcoded for 6 system roles; custom roles use BE label. |
| 4 | `PATCH /:id` is the primary path for admin-managed password change (single round-trip for all field edits). `POST /:id/password` kept for future self-change / password-expiry flows (SDD #5/6). Current FE uses PATCH exclusively. |
| 5 | Concurrent `SetRolesForUser` → last-write-wins. Accepted for v1 (low admin concurrency). |
| 6 | No pagination on user list (v1). Admin pool expected < 100. Add when needed. |
| 7 | `rbacUserId` added to JWT payload (Option A) so `requirePerm` can resolve RBAC roles from the legacy `Admin` JWT. Fallback `rbacUserId ?? id` keeps SDD #1 tests green. |
| 8 | Bootstrap self-heal (hotfix `6f6e5ff4`): if user with bootstrap login exists, UPDATE credentials + re-assure super_admin. Prevents lockout on secret rotation. `outcome: 'updated'` replaces old `skipped: user-already-exists`. |

---

## Deploy Artifacts

### BE Commits

| Commit | Description |
|--------|-------------|
| `c567b18a` | feat(rbac): user management CRUD — use cases, routes, DI wiring, bootstrap script |
| `bc395b3c` | feat(rbac): wire rbacUserId into JWT + patch requirePermission fallback |
| `6f6e5ff4` | fix(rbac): bootstrap self-heal — update credentials if login exists, outcome 'updated' |

### FE Commit

| Commit | Description |
|--------|-------------|
| `bf53c41` | feat(rbac): RbacUsersBody + RbacUserModal + hooks + types + AdminPage patch |

### Workflow Runs

| Run | Result | Notes |
|-----|--------|-------|
| `26618029713` | failed | Bootstrap step failed — missing `BOOTSTRAP_RBAC_PASSWORD_HASH` secret; recovered by adding secret and re-running |
| `26618597632` | success | BE deploy + bootstrap success |
| `26620399891` | success | FE deploy success |

---

## Bootstrap Credentials Note

The initial `BOOTSTRAP_RBAC_PASSWORD_HASH` and associated login/email/name values were provided one-time in chat during the deploy session. They are NOT stored in this archive. The operator stored them as EasyPanel / GitHub repo secrets. To rotate: update the secrets and re-deploy — the bootstrap self-heal will update the user's credentials automatically.

---

## Manual Verification

- `POST /api/auth/login` with bootstrap credentials → `200 OK`, JWT cookie set
- `GET /api/admin/rbac/users` with cookie → `200 OK`, bootstrap user visible in list with `super_admin` role

---

## Follow-on SDDs Unblocked

- **SDD #3** — `roles-permissions-management`: now unblocked (user-role surface live; RBAC infrastructure proven in prod)
- **SDD #4** — Audit log: `console.log('[AUDIT]', ...)` stubs are in place in all mutating routes; SDD #4 replaces them with `AuditRepository` port calls
- **SDD #5** — Session listing: `POST /:id/password` endpoint ready for self-change flow wiring
