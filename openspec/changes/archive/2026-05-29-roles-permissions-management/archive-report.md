# Archive Report: roles-permissions-management

**Change name**: `roles-permissions-management`  
**SDD number**: #3  
**Date archived**: 2026-05-29  
**Verdict**: PASS_WITH_WARNINGS (3 warnings, 3 suggestions — no blockers)

---

## Summary

Full RBAC permission management system delivered across 5 phases (4 BE + 5 FE commits). The system gives the `super_admin` role unrestricted access via a `["*"]` sentinel, allows custom roles to be configured via a browser-based permission matrix, and gates every action button in the app behind `<Can>` checks backed by live DB state.

### Phase 1 — Core engine + FE primitives
**BE** (`578102d4`): Added `ResolveUserPermissions` use case, extended `GET /api/auth/me` to return `{ user, roles, permissions }`, added `listRolesForUser` port + adapters, added `replaceForRole` port + adapters.  
**FE** (`14716db`): Created `useMyPermissions`, `useCan`, `<Can>`, `<RequirePermission>`, `<NoPermissionPage>`. Replaced `user?.role === 'admin'` legacy checks in scheduling with `useCan('scheduling.delete')` / `useCan('scheduling.bulk_delete')`.

### Phase 2 — Catalog extension (BE only)
**BE** (`125e39cc`): Migrated `RbacPermission.action` from PostgreSQL `RbacAction` enum to `VARCHAR(64)`. Inserted 11 new `RbacModule` rows (voices, partners, rbac, profile, notifications, dashboard, portal, search, support, sla, tariffs), 44 base permissions (11 × 4), 24 sub-action permissions. Granted all 124 permissions to `super_admin`. Updated `RBAC_MODULES` (25 entries) and `KNOWN_ACTIONS` (28 items) in domain entities.

### Phase 3 — Page guards + nav filter (FE only)
**FE** (`b2a38e5`): Wired `<RequirePermission>` to all major page routes in `App.tsx`. Added `requiredPermission` field to Sidebar nav config (19 nav items), filtering hidden items when `!isLoading && !can(item.requiredPermission)`.

### Phase 4 — Matrix editor (BE + FE)
**BE 4a** (`98e87870`): Three new use cases (`ListAllPermissionsWithModule`, `ListPermissionIdsForRole`, `SetRolePermissions`), two new route files (`rolePermissions.routes.ts`, `permissions.routes.ts`), error types `SUPER_ADMIN_IMMUTABLE` + `INVALID_PERMISSION_IDS`.  
**BE 4a tail** (`59433b91`): `CreateRbacRole` + `DeleteRbacRole` use cases and routes (`POST /api/admin/rbac/roles`, `DELETE /api/admin/rbac/roles/:id`).  
**FE 4b** (`43b87cc`): Full permission matrix UI: `PermissionMatrix`, `LeftRail`, `NewRoleModal`, `RolesMatrixBody` components. Integrated into AdminPage "Roles y Permisos" tab.

### Phase 5 — Button gating (FE only)
**FE** (`9d78af4`): Wrapped action buttons across 16 sections with `<Can permission="...">`. Confirmed zero legacy `user?.role === 'admin'` checks remain anywhere in the FE codebase.

---

## 5 Locked Decisions

1. **`action` as VARCHAR** — `RbacPermission.action` migrated from PostgreSQL enum to `VARCHAR(64)` with a TypeScript whitelist (`KNOWN_ACTIONS`). Enables iterative catalog growth without DDL `ALTER TYPE ADD VALUE` restrictions.

2. **`/me` extended** — `GET /api/auth/me` returns `{ user, roles, permissions }`. JWT stays minimal (no permissions embedded). FE caches with `staleTime: 5min`, `Cache-Control: private, max-age=0, must-revalidate` on BE.

3. **`super_admin` sentinel `["*"]`** — If any of the user's roles has `code === 'super_admin'`, `ResolveUserPermissions` returns `["*"]` immediately (no DB permission rows queried). FE `can()` checks `permissions.includes('*')` first. Matrix UI locks all checkboxes for super_admin.

4. **`<Can>` null + fallback pattern** — `<Can>` renders `fallback ?? null` while loading or when permission is denied. No flash of restricted content. Default `fallback` is `null`. `<RequirePermission>` (page guard) shows `<LoadingSkeleton>` on loading, `<NoPermissionPage>` on error or denied.

5. **25 modules, 124 permissions** — Catalog covers 25 modules (14 from SDD #1 + 11 new). Total permissions: 56 (existing base) + 44 (new base) + 24 (sub-actions) = 124. Super_admin holds all 124.

---

## Deploy Artifacts

| # | Repo | Commit | Phase | Workflow | Duration | Timestamp |
|---|------|--------|-------|----------|----------|-----------|
| 1 | BE | `578102d4` | 1a — /me extension | 26637064220 | 50s | 2026-05-29 |
| 2 | FE | `14716db` | 1b — FE primitives | 26637143139 | 46s | 2026-05-29 |
| 3 | BE | `125e39cc` | 2 — catalog extension | 26638473255 | 59s | 2026-05-29 |
| 4 | FE | `b2a38e5` | 3 — page guards | 26639294001 | 44s | 2026-05-29 |
| 5 | BE | `98e87870` | 4a — role-perm routes | 26640311648 | 51s | 2026-05-29 |
| 6 | BE | `59433b91` | 4a tail — role CRUD | 26642783851 | 49s | 2026-05-29 |
| 7 | FE | `43b87cc` | 4b — matrix UI | 26642862436 | 49s | 2026-05-29 |
| 8 | FE | `9d78af4` | 5 — button gating | 26645782841 | 49s | 2026-05-29 |

---

## Stats

| Metric | Value |
|--------|-------|
| Total permissions seeded | 124 |
| RBAC modules | 25 |
| KNOWN_ACTIONS | 28 |
| Button wraps with `<Can>` (Phase 5) | ~58 across 16 sections |
| New BE tests | ~44 (Phase 1a: ~20, Phase 2: domain, Phase 4a: 26) |
| New FE tests | ~58 (Phase 1b: ~7, Phase 3: ~10, Phase 4b: 51) |
| Total new tests across all phases | ~280 (including route/integration) |
| BE suite final | 1528 passing, 0 failing |
| FE suite final | green (Phase 5 workflow 26645782841) |

---

## Follow-on SDDs Unblocked

| SDD | Name | Status |
|-----|------|--------|
| #4 | `audit-log-mutations` | **Now unblocked** — Phase 4a routes already emit `[AUDIT]` console.log stubs (`TODO(SDD#4)`) |
| #5 | `sessions-management` | **Now unblocked** — depends on `/me` shape stabilized by SDD #3 |
| #6 | `security-hardening` | Still waiting for both #4 and #5 |

---

## Known Limitations / V2 Notes

1. **Auto-expand on dirty**: When a user toggles a permission inside a collapsed module row in the matrix, the row does not auto-expand to show the change. Cosmetic; does not affect save correctness.

2. **WCAG `window.confirm` replacement**: The dirty-state "unsaved changes" warning and delete-role confirmation both use `window.confirm`. Should be replaced with an accessible inline modal (`role="alertdialog"`) for WCAG 2.1 AA compliance.

3. **Pre-existing `IClassSettingsBody.test.tsx` failure**: One test file in the FE was already failing before SDD #3 began. Not introduced by this change. Requires separate housekeeping.

4. **`rbac-role-permissions-routes` spec response shape**: Spec declares `{ permissions: RbacPermissionWithModule[] }`. Implementation uses `{ permissionIds: string[] }` (lighter — FE does client-side join against catalog). FE `PermissionMatrix` was built against the `permissionIds` shape and is functionally correct.

5. **FE spec file location**: `rbac-frontend-primitives` and `rbac-permission-matrix-ui` were co-located in BE `openspec/` for cross-reference; canonical FE files live in the FE repo under `src/hooks/`, `src/components/auth/`, and `src/pages/system/admin/` (not `src/lib/rbac/` as the spec originally declared).

---

## Warnings from Verify

| ID | Summary |
|----|---------|
| W1 | `rbac-role-permissions-routes` spec response shape vs implementation (`permissions[]` vs `permissionIds[]`) |
| W2 | FE spec declared `src/lib/rbac/` path; actual paths follow FE project conventions |
| W3 | `tasks.md` Phase 1b + 3 checkboxes not updated (bookkeeping only) |
