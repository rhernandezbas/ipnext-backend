# Verify Report — user-management-crud (SDD #2)

**Date**: 2026-05-29  
**Verifier**: sdd-verify (Claude Sonnet 4.6)  
**Verdict**: PASS_WITH_WARNINGS  
**Critical**: 0 | **Warnings**: 2 | **Suggestions**: 2

---

## Status

All capability areas implemented and deployed. BE E2E confirmed in production (2 hotfixes applied post-deploy). FE deployed and live. All automated gates green.

---

## Gates

| Gate | Result | Detail |
|------|--------|--------|
| BE `npm test` | ✅ PASS | 1381 passing, 0 failing, 71 skipped (Prisma DB) |
| BE `npx tsc --noEmit` | ✅ PASS | 0 errors |
| FE RBAC tests (`vitest run` scoped) | ✅ PASS | 52 tests across 7 files, all passing |
| FE full suite (`vitest run`) | ✅ PASS | 1299 passing, 1 todo, 0 failures |
| FE `npx tsc --noEmit` (new files) | ✅ PASS | 0 errors in RBAC files (pre-existing errors in unrelated pages) |
| BE E2E prod (cited) | ✅ PASS | POST /api/auth/login → 200; GET /api/admin/rbac/users → 200 (engram #374) |
| BE deployed (cited) | ✅ PASS | Workflow 26618597632 green (engram #373) |
| FE deployed (cited) | ✅ PASS | Workflow 26620399891 green |

---

## Findings

### CRITICAL (0)

None.

---

### WARNING (2)

#### W-1 — Bootstrap spec/impl divergence: `user-already-exists` outcome replaced by `updated` (self-heal)

**Spec** (`rbac-bootstrap/spec.md` R-BOOT-2 + BootstrapResult): defines outcome `skipped / user-already-exists` for the path where `login === env.login` already exists in DB.

**Impl** (`bootstrapRbac.ts`): when login already exists, the script **self-heals** — it updates `passwordHash`, `email`, `name` and reassigns `super_admin`, returning `{ outcome: 'updated', login }` instead of `{ outcome: 'skipped', reason: 'user-already-exists' }`.

**Impact**: Callers observing the `BootstrapResult` type see an `updated` outcome that is undocumented in the spec. The `BootstrapResult` union type was extended in implementation with `| { outcome: 'updated'; login: string }`. Tests cover the self-heal path (engram #374 documents the prod bug that motivated it: `$2b$`-prefixed hashes truncated by bash `$`-interpolation).

**Why not CRITICAL**: The self-heal is strictly additive and safer — it makes the bootstrap a viable password-recovery channel. No spec invariant is violated (no unintended writes). The change was a deliberate hotfix with documented rationale.

**Action**: Update the spec's `BootstrapResult` type and algorithm section to reflect the self-heal outcome and remove the `user-already-exists` reason. Low urgency — apply during sdd-archive.

---

#### W-2 — FE modal password change routes through `PATCH /:id`, not `POST /:id/password`

**Design** (B.6 submit handler): on edit with `changePassword=true`, calls `updateMutation` (PATCH) **then** a separate `changePasswordMutation` (POST `/:id/password`).

**Impl** (`RbacUserModal.tsx` + `RbacUsersBody.tsx`): when `changePassword=true` and `data.password` is set, the password is included in the `UpdateRbacUserPayload` sent via `PATCH /:id`. The `POST /:id/password` endpoint is **never called** from the edit flow.

**Impact**: Functionally equivalent — `UpdateRbacUser` (PATCH handler) accepts `password?: string` per spec `UpdateRbacUserDto` and hashes it correctly. The `oldPassword` verification path (self-change via `POST /:id/password`) is unreachable from admin UI (admin always changes another user's password, `isAdminManaged=true`). No security concern — bcrypt hashing still occurs. The `useChangeRbacUserPassword` hook is defined but unused by the edit modal.

**Action**: Either update the design to match the simpler single-PATCH approach, or wire `POST /:id/password` for completeness (useful when self-service password change is added for non-admin users in SDD #5+). Low urgency.

---

### SUGGESTION (2)

#### S-1 — `RbacRolesSelector` and `RbacUserModal` extracted to separate files despite design saying inline

**Design** (B.5, AD-FE-3): "keep it INLINE in `RbacUsersBody.tsx` first". Impl created three separate files: `RbacUsersBody.tsx`, `RbacUserModal.tsx`, `RbacRolesSelector.tsx`.

**Assessment**: Extraction is a net positive — each file is independently testable (confirmed: `RbacUserModal.test.tsx`, `RbacRolesSelector.test.tsx` exist). Aligns better with the project's component philosophy. No spec violation. Design note should be updated: "extracted earlier than anticipated; premature extraction turned out cleaner."

#### S-2 — `AdminPage.tsx` tab value array still uses `'Admins'` label in internal constant

**Code** (line 140): `{ value: 'admins', label: 'Admins' }` exists in a `ALL_TABS` constant used for permission/module mapping, while the rendered tab button says "Usuarios" (line 688). The tab `id: 'admins'` is stable as required (decision #1).

**Assessment**: The `'Admins'` label in the internal constant is used for module display names (line 152: `admins: 'Administradores'`), not for the tab button. No user-visible regression. Could be cleaned up when the full AdminsBody → RbacUsersBody migration lands in SDD #6.

---

## Capability Coverage

### BE Capabilities

| Capability | Spec | Status | Notes |
|-----------|------|--------|-------|
| PasswordHasher port + adapters | `rbac-user-crud` §PasswordHasher | ✅ | `hash`/`compare` (spec names); `BcryptPasswordHasher` + `InMemoryPasswordHasher` present |
| RbacUserRepository extensions | `rbac-user-crud` §RbacUserRepository | ✅ | `list`, `update`, `delete`, `countUsersWithRoleCode` added |
| 10 use cases (UC-1 to UC-10) | `rbac-user-crud` + `rbac-user-roles` | ✅ | All 11 files present (10 CRUD/roles + LoginRbacUser) |
| 9 domain errors with SCREAMING_SNAKE codes | `rbac-user-crud` §Domain errors | ✅ | All 9 in `rbacUser.errors.ts` |
| DTO strips passwordHash | `rbac-user-crud` §DTOs | ✅ | `RbacUserDto` has no `passwordHash` field; mapper enumerates fields explicitly |
| LoginRbacUser: unknown/wrong/inactive → same error | `rbac-user-routes` §auth | ✅ | All three throw `AuthenticationError('Invalid credentials')` |
| JwtAuthAdapter signs `{id, login, email}` only | design A.6 | ✅ | No `role`, no `userId` in JWT payload; confirmed by E2E (engram #374) |
| auth.routes.ts accepts `username` field | design A.6 | ✅ | Route calls `authProvider.login({ username, password })`, adapter maps `username → login` |
| 10 HTTP routes at `/admin/rbac/users` | `rbac-user-routes` | ✅ | All 10 routes present; `requirePerm('admin','manage')` applied |
| Error handler maps all 9 RBAC codes | `rbac-user-routes` §Error mapping | ✅ | All 9 codes in `statusMap` in `errorHandler.ts` |
| Bootstrap: 4 paths | `rbac-bootstrap` | ⚠️ | `user-already-exists` path replaced by `updated` (self-heal). See W-1. |
| Bootstrap uses Prisma singleton | design A.8 / engram #373 | ✅ | `main()` dynamically imports `prisma` from `src/infrastructure/database/prisma.ts` |
| deploy.yml uses `env:` block | engram #374 (Bug A fix) | ✅ | Secrets forwarded via `env:` block, container receives via `-e VAR` (no inline `${{ }}`) |

### FE Capabilities

| Capability | Spec | Status | Notes |
|-----------|------|--------|-------|
| 4 new files in `types/`, `constants/`, `api/`, `hooks/` | design B.0 | ✅ | `rbacRole.ts`, `rbacUser.ts`, `rbacRoleLabels.ts`, `rbacRoles.api.ts`, `rbacUsers.api.ts`, `useRbacRoles.ts`, `useRbacUsers.ts` |
| 3 components in `pages/system/admin/` | design B.0 | ✅ | `RbacRolesSelector.tsx`, `RbacUserModal.tsx`, `RbacUsersBody.tsx` (+ 3 `.module.css`) |
| AdminPage tab `'admins'` → label "Usuarios", content `<RbacUsersBody />` | design B.8 | ✅ | Tab id `'admins'` stable, button text "Usuarios", content `<RbacUsersBody />` |
| Hardcoded labels for 6 system roles + neutral gray custom | design B.4 | ✅ | `SYSTEM_ROLE_META` in `rbacRoleLabels.ts` covers all 6 system roles; `role-custom` for unknown |
| All TanStack mutations invalidate correct query keys | design B.3 | ✅ | `useCreateRbacUser` → LIST_KEY; `useUpdateRbacUser` → LIST_KEY; `useSetUserRoles` → LIST_KEY + detail key |
| 12 AD-FE decisions reflected in code | design B.10 | ✅ | AD-FE-1 through 12 all implemented (sticky header, Esc close, focus via autoFocus, skeleton rows, empty state card, ARIA attributes, role multi-select inline→extracted, login disabled in edit, password section collapsed, badge colors, confirm delete, dual error layer) |

---

## Manual Checkpoints (cited — not re-run)

| Checkpoint | Source | Result |
|-----------|--------|--------|
| POST /api/auth/login → 200, JWT `{id, login, email}` shape | engram #374 | ✅ Verified |
| GET /api/admin/rbac/users → 200, no `passwordHash` leak | engram #374 | ✅ Verified |
| Bootstrap log: `[bootstrap-rbac] created: super_admin ***` | engram #373 | ✅ Verified |
| BE deploy workflow green | engram #373 (26618126046) + hotfixes | ✅ Green |
| FE deploy workflow green | provided (26620399891) | ✅ Green |

---

## Notes

1. **Bootstrap self-heal decision** (engram #374): The divergence from spec in W-1 was driven by a prod bug where the bcrypt hash `$2b$10$...` got corrupted when passed via `${{ secrets.X }}` inline in GitHub Actions shell commands. The fix (env-block forwarding) is in place; the self-heal outcome is a byproduct of the investigation that is strictly safer than a hard skip.

2. **Pre-existing FE TS errors**: `npx tsc --noEmit` on the FE shows 9 errors in files unrelated to this SDD (`StatsTab.tsx`, `NotasCreditoPage.tsx`, `GponPage.tsx`, `InventoryLegacyPage.tsx`, `RadiusSessionsPage.tsx`, `SchedulingTaskDetailPage`, `SettingsPage.tsx`, `TariffsPage.tsx`). These predate SDD #2 and are out of scope.

3. **`useChangeRbacUserPassword` hook** is implemented and exported from `useRbacUsers.ts` but not currently invoked by the edit modal (see W-2). It remains available for future self-service password change flows (SDD #5+).

4. **`RbacRolesSelector` was extracted as a separate component** (see S-1). The component uses `createPortal` for the popover (avoiding overflow clipping), `useEffect` for outside-click + Escape handling, and `getBoundingClientRect` for fixed positioning — a cleaner implementation than the inline design expected.

5. **Test coverage for new RBAC FE files**: 52 tests covering `RbacUsersBody`, `RbacUserModal`, `RbacRolesSelector`, `useRbacUsers`, `useRbacRoles`, `rbacUsers.api`, `rbacRoles.api`. All passing.
