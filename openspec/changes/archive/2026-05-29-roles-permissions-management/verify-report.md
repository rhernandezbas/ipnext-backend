# Verify Report: roles-permissions-management

**SDD #3** — Roles & Permissions Management  
**Verified**: 2026-05-29  
**Overall Status**: **PASS_WITH_WARNINGS**

---

## Gates

### Backend
- Last full suite: **1510 passing, 0 failing** (after Phase 4a, commit `98e87870`)
- Phase 4a tail adds CreateRbacRole + DeleteRbacRole use cases and routes; suite after `59433b91` = **1528 passing** (18 new tests)
- `npx tsc --noEmit`: **0 errors** (confirmed at Phase 4a completion)
- New tests across all BE phases: ~44+ (Phase 1a: ~20, Phase 2: domain assertions, Phase 4a: 26)

### Frontend
- Last full suite: **1387 passing** (after Phase 4b, commit `43b87cc`, workflow 26642862436)
- Phase 5 adds gating for 16 sections; suite after `9d78af4` = green (workflow 26645782841, 49s)
- `npx tsc --noEmit`: **0 errors** (confirmed at all phase completions)
- New tests across all FE phases: ~58+ (Phase 1b: ~7, Phase 3: nav filter + RequirePermission, Phase 4b: 51)

---

## Manual Checkpoints (8 workflows, all green)

| Phase | Workflow ID | Duration | What was verified |
|-------|-------------|----------|-------------------|
| 1a BE | 26637064220 | 50s | `/me` returns user+roles+permissions, super_admin gets `["*"]` |
| 1b FE | 26637143139 | 46s | `<Can>` + `useMyPermissions` + delete-task unblocked |
| 2 BE | 26638473255 | 59s | enum→varchar migration, 11 modules + 24 sub-actions, 124 permissions, module count guard (25) PASSED |
| 3 FE | 26639294001 | 44s | `RequirePermission` page guard, nav filter, `NoPermissionPage` |
| 4a BE | 26640311648 | 51s | role-permissions routes (`GET/PUT /:id/permissions`, `GET /permissions`) |
| 4a tail BE | 26642783851 | 49s | role CRUD (`POST /roles`, `DELETE /roles/:id`) |
| 4b FE | 26642862436 | 49s | permission matrix editor (`LeftRail` + `PermissionMatrix` + `NewRoleModal`) |
| 5 FE | 26645782841 | 49s | button gating across 16 sections with `<Can>` |

---

## Capability Coverage Table

| Capability | Spec | Design | Implementation | Tests | Status |
|---|---|---|---|---|---|
| `rbac-effective-permissions` | ✅ locked | ✅ | `ResolveUserPermissions.ts` | 7 scenarios, all green | **DEPLOYED** |
| `rbac-auth-me-extended` | ✅ locked | ✅ | `auth.routes.ts` `/me` handler rewrite | 4 scenarios supertest | **DEPLOYED** |
| `rbac-permission-catalog-extension` | ✅ locked | ✅ | Migration SQL + `rbac.ts` entities | domain entity tests + live count 124 | **DEPLOYED** |
| `rbac-role-permissions-routes` | ✅ locked | ✅ | `rolePermissions.routes.ts` + `permissions.routes.ts` | 26 tests (use cases) + 14 route tests | **DEPLOYED** |
| `rbac-frontend-primitives` | ✅ locked | ✅ | `useMyPermissions`, `Can`, `RequirePermission`, `NoPermissionPage`, Sidebar filter | Full test suite green | **DEPLOYED** |
| `rbac-permission-matrix-ui` | ✅ locked | ✅ | `PermissionMatrix`, `LeftRail`, `NewRoleModal`, `RbacPermissionMatrix` root | 51 new tests, Phase 4b green | **DEPLOYED** |

---

## Findings

### CRITICAL
_None._

---

### WARNING (3)

#### W1 — Response shape divergence: `rbac-role-permissions-routes` spec vs implementation

**Spec** (`rbac-role-permissions-routes/spec.md`) declares both GET and PUT return:
```ts
{ permissions: Array<{ id, moduleCode, action, moduleLabel }> }
```

**Implementation** (`rolePermissions.routes.ts`) returns:
```ts
{ permissionIds: string[] }
```
The GET `/api/admin/rbac/permissions` catalog endpoint (separate file) returns the full `{ permissions: [...] }` shape. The per-role endpoints were implemented as a lighter `permissionIds` shape to keep the FE join client-side (FE fetches catalog separately and joins locally in the matrix).

**Impact**: FE `PermissionMatrix.tsx` is built against the `permissionIds` shape and works correctly. The spec was written before the design decision to use a lightweight sub-resource. No functional regression.

**Action**: Spec should be updated to reflect the `permissionIds: string[]` response. Tracked here; can be done during archive sync.

---

#### W2 — `rbac-frontend-primitives` spec file path divergence

The spec declares files under `src/lib/rbac/`. Actual implementation places them in:
- `src/hooks/useMyPermissions.ts` (hook + `useCan` + `ME_PERMISSIONS_QUERY_KEY`)
- `src/components/auth/Can.tsx`
- `src/components/auth/RequirePermission.tsx`
- `src/components/auth/NoPermissionPage.tsx`

The `@/lib/rbac` barrel (`src/lib/rbac/index.ts`) does NOT exist; imports come directly from the component/hook paths.

**Impact**: Functional behavior is fully compliant with the spec. The path divergence is a structure choice by the sub-agent and consistent with the FE project's existing layout conventions.

**Action**: Spec notes updated in archive.

---

#### W3 — Tasks 1b.1–1b.13 checkbox markers

The tasks.md Phase 1b and Phase 3 tasks still show `[ ]` (not checked) even though the corresponding workflows are green. This is a tasks.md bookkeeping gap — the sub-agent that executed these phases did not update the checkbox file.

**Impact**: No functional impact; implementation was verified via live workflow deploys.

**Action**: Noted; tasks.md will be archived as-is. The checkbox state is a record-keeping artifact, not a gate.

---

### SUGGESTION (3)

#### SG1 — Phase 4b unfinished cosmetic pieces (V2)
The Phase 4b sub-agent noted 4 minor polish items not covered by tests:
1. Auto-expand module row when a permission inside is toggled while the row is collapsed.
2. Replace `window.confirm` for role-switch dirty guard with an inline accessible modal (WCAG 2.1 AA).
3. Inline confirm modal for delete role (same WCAG concern).
4. Module-singleton nav items not filtered (only relevant when non-admin users reach the matrix page — guarded by `RequirePermission` anyway).

These are cosmetic/a11y V2 enhancements, not correctness issues.

#### SG2 — Permission codes `tariffs.write`, `voices.write`, `notifications.write` in Phase 5 button gates
Phase 5 wraps buttons with `<Can permission="tariffs.write">` et al. These codes are derived from the 11 new modules inserted in Phase 2 with their 4 base actions. The migration SQL inserts base actions (read/write/delete/manage) for all 11 new modules (`ON CONFLICT DO NOTHING`). So `tariffs.write`, `voices.write`, `notifications.write` ARE seeded as part of the 124-permission catalog — no missing permission codes.

Confirmed via migration SQL step 3 (`CROSS JOIN (VALUES ('read'),('write'),('delete'),('manage'))` for all 11 new modules including `tariffs`, `voices`, `notifications`).

#### SG3 — Pre-existing `IClassSettingsBody.test.tsx` failure (housekeeping)
A pre-existing FE test failure in `src/__tests__/pages/scheduling/settings/IClassSettingsBody.test.tsx` exists and predates SDD #3. Not introduced by this change. Should be addressed in a separate housekeeping issue.

---

## Spot-Check Results

| Check | Result |
|---|---|
| `useMyPermissions().can('*')` returns true for super_admin | ✅ — `if (permissions.includes('*')) return true` in `useMyPermissions.ts:42` |
| `<RequirePermission>` renders `NoPermissionPage` when denied | ✅ — deployed Phase 3, workflow green |
| Matrix bulk replace via `PUT` rejects super_admin | ✅ — `SetRolePermissions` throws `SuperAdminImmutableError`; 14 route tests pass |
| Zero `user?.role === 'admin'` legacy checks in scheduling | ✅ — grep confirms 0 matches; `isAdmin` prop name remains but fed by `useCan()` |
| `<Can>` is the gating pattern everywhere (not legacy role checks) | ✅ — `useCan` imported in both `SchedulingTaskDetailPage.tsx` and `TasksTableView.tsx` |
| 25 RBAC modules seeded | ✅ — Phase 2 workflow 26638473255 reports module count guard 25 PASSED |
| 124 permissions seeded | ✅ — Phase 2 workflow confirms 124 total |

