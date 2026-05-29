# Tasks: Roles & Permissions Management

> SDD #3 — `roles-permissions-management`. BE + FE. Strict TDD: RED → GREEN → REFACTOR.
> Test runners: BE `npm test` (Jest 30), FE `npx vitest run`.
> Quality gates: `npx tsc --noEmit` (both repos) before any commit.

---

## Phase 1a — BE: port extension + use cases + /me handler

### 1a.1 [RED] Contract test: `listRolesForUser` on `RbacUserRoleRepository`
- [x] In `src/__tests__/infrastructure/adapters/_shared/rbacUserRoleContractTests.ts`, add `describe('listRolesForUser')` block
- [x] Scenario: user with 2 assigned roles → returns 2 `RbacRole` objects with correct `{ id, code, label }`
- [x] Scenario: user with no roles → returns `[]`
- [x] Scenario: unknown userId → returns `[]`
- [x] Run `npm test` — confirm RED (method missing from port)

### 1a.2 [GREEN] Add `listRolesForUser` to port + both adapters
- [x] In `src/domain/ports/RbacUserRoleRepository.ts`, add method: `listRolesForUser(userId: string): Promise<RbacRole[]>`
- [x] Import `RbacRole` from `@domain/entities/rbac` in the port file
- [x] In `src/infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository.ts`, implement `listRolesForUser`: filter assignments by userId, resolve each roleId via `InMemoryRbacRoleRepository`
- [x] In `src/infrastructure/adapters/prisma/PrismaRbacUserRoleRepository.ts`, implement `listRolesForUser`: `prisma.rbacUserRole.findMany({ where: { userId }, include: { role: true } })`, map to `RbacRole`
- [x] Register the new method in the existing in-memory contract test runner
- [x] Run `npm test` — confirm GREEN on new contract tests

### 1a.3 [RED] Contract test: `replaceForRole` on `RbacRolePermissionRepository`
- [x] In `src/__tests__/infrastructure/adapters/_shared/rbacRolePermissionContractTests.ts`, add `describe('replaceForRole')` block
- [x] Scenario (a): idempotent re-apply — calling `replaceForRole([A,B])` twice results in `[A,B]`
- [x] Scenario (b): replace `[A,B,C]` with `[B,D]` → final state is exactly `[B,D]`
- [x] Scenario (c): `replaceForRole([], roleId)` clears all grants → `listForRole` returns `[]`
- [x] Run `npm test` — confirm RED

### 1a.4 [GREEN] Add `replaceForRole` to port + both adapters
- [x] In `src/domain/ports/RbacRolePermissionRepository.ts`, add: `replaceForRole(roleId: string, permissionIds: string[]): Promise<void>`
- [x] In `InMemoryRbacRolePermissionRepository.ts`: delete all entries for roleId, then insert new set
- [x] In `PrismaRbacRolePermissionRepository.ts`: `prisma.$transaction([ deleteMany({ where: { roleId } }), createMany({ data: permissionIds.map(permissionId => ({ roleId, permissionId })) }) ])`
- [x] Run `npm test` — confirm GREEN

### 1a.5 [RED] Test `ResolveUserPermissions` use case
- [x] Create `src/__tests__/application/rbac/ResolveUserPermissions.test.ts`
- [x] Wire `InMemoryRbacUserRoleRepository` + `InMemoryRbacRolePermissionRepository` + `InMemoryRbacPermissionRepository`
- [x] S1: user with role `code=super_admin` → returns `["*"]`; spy confirms no permission lookup called
- [x] S2: user with role `tecnico` having `[scheduling.read, scheduling.write]` → returns sorted codes
- [x] S3: user with roles `[noc, tecnico]` overlapping `scheduling.read` → returns 5 codes, deduplicated
- [x] S4: user with no roles → returns `[]`
- [x] S5: user with roles but zero grants → returns `[]`
- [x] S6: `userId=""` → throws `ValidationError` with code `INVALID_USER_ID`
- [x] S7: permission code format is `moduleCode.action` (e.g. `scheduling.delete`)
- [x] Run `npm test` — confirm RED

### 1a.6 [GREEN] Implement `ResolveUserPermissions` use case
- [x] Create `src/application/use-cases/rbac/ResolveUserPermissions.ts`
- [x] Constructor: `(userRoleRepo: RbacUserRoleRepository, rolePermRepo: RbacRolePermissionRepository, permRepo: RbacPermissionRepository)`
- [x] Validate `userId` non-empty; throw `ValidationError('INVALID_USER_ID')` if empty
- [x] `listRolesForUser(userId)` → if any role has `code === 'super_admin'` → return `['*']`
- [x] For each roleId, `listForRole(roleId)` → collect permissionIds; resolve codes via `permRepo.listAll()`; deduplicate; sort; return
- [x] Run `npm test` — confirm GREEN on all S1–S7

### 1a.7 [RED] Supertest for `GET /api/auth/me` new shape
- [x] Create `src/__tests__/infrastructure/http/routes/auth.me.test.ts`
- [x] Build minimal Express app with in-memory repos + `ResolveUserPermissions` wired
- [x] S1: authenticated as super_admin → 200, `body.permissions === ["*"]`, `body.roles[0].code === "super_admin"`, `body.user.{id,login,email,name}` present, `Cache-Control: private, max-age=0, must-revalidate`
- [x] S2: regular user with `tecnico` role having 2 perms → 200, `body.permissions` has 2 codes, `body.roles` has 1 element
- [x] S3: user with no roles → 200, `body.roles=[]`, `body.permissions=[]`
- [x] S4: unauthenticated (no cookie) → 401
- [x] Run `npm test` — confirm RED (handler still returns old shape)

### 1a.8 [GREEN] Update `auth.routes.ts` /me handler + DI signature
- [x] Update `createAuthRouter` signature: `(authProvider, rbacUserRepo, rbacUserRoleRepo, resolveUserPermissions)`
- [x] Replace the `/me` handler: parallel `Promise.all` for `rbacUserRepo.findById`, `rbacUserRoleRepo.listRolesForUser`, `resolveUserPermissions.execute`
- [x] Serialize response as `{ user: {id,login,email,name}, roles: [{id,code,label}], permissions }`
- [x] Set `Cache-Control: private, max-age=0, must-revalidate` header
- [x] Handle no-user case → 401 `{ error: 'NO_USER_CONTEXT' }`
- [x] Wrap in try/catch → 500 on unexpected error
- [x] Run `npm test` — confirm GREEN on auth.me.test.ts

### 1a.9 Wire `app.ts` and update callers
- [x] In `src/infrastructure/http/app.ts`: instantiate `ResolveUserPermissions(rbacUserRoleRepo, rbacRolePermRepo, rbacPermissionRepo)`
- [x] Pass `rbacUserRoleRepo` and `resolveUserPermissions` to `createAuthRouter`
- [x] Search for other test files or code that calls `createAuthRouter` directly: `src/__tests__/infrastructure/http/routes/rbacUser.routes.test.ts` (and any others found via grep)
- [x] Update those callers to pass the new DI params (use existing in-memory repos)
- [x] Run `npm test` — full suite GREEN
- [x] Run `npx tsc --noEmit` — zero type errors

---

## Phase 1b — FE: primitives + delete-task unblock

### 1b.1 Add permissive default mock for `useMyPermissions` in test setup
- [ ] In `src/test/setup.ts` (FE repo), add `vi.mock('@/lib/rbac/useMyPermissions', ...)` with permissive default: `{ user: null, roles: [], permissions: ['*'], isLoading: false, isError: false, can: () => true }`
- [ ] Add `vi.mock('@/lib/rbac/useCan', ...)` returning `true` by default
- [ ] Confirm `npx vitest run` still passes existing suite (no new failures introduced)

### 1b.2 [RED] Tests for `useMyPermissions` hook
- [ ] Create `src/__tests__/lib/rbac/useMyPermissions.test.ts`
- [ ] S1: while loading → `isLoading=true`, `permissions=[]`, `roles=[]`, `user=null`
- [ ] S2: `permissions=["*"]` → `can("scheduling.delete")` returns `true`; `can("any.made.up")` returns `true`
- [ ] S3: `permissions=["scheduling.read"]` → `can("scheduling.read")=true`, `can("scheduling.delete")=false`
- [ ] S4: `can()` returns `false` while loading (no data)
- [ ] S5: `staleTime` is 5 minutes (assert query options via `renderHook` + QueryClient spy or vitest mock)
- [ ] S6: `ME_PERMISSIONS_QUERY_KEY` is exported as `['me','permissions']`
- [ ] Run `npx vitest run` — confirm RED (hook doesn't exist yet)

### 1b.3 [GREEN] Implement `useMyPermissions` hook + API + types
- [ ] Create `src/lib/rbac/types.ts` with `RbacRole`, `MeResponse` interfaces
- [ ] Create `src/api/auth.api.ts` (or extend existing): `authApi.getMe(): Promise<MeResponse>` → `axiosClient.get('/auth/me').then(r => r.data)`
- [ ] Create `src/lib/rbac/useMyPermissions.ts`: query with `queryKey: ME_PERMISSIONS_QUERY_KEY`, `staleTime: 5*60*1000`, `retry: 1`; implement `can(perm)` checking `'*'` sentinel; export `ME_PERMISSIONS_QUERY_KEY`
- [ ] Create `src/lib/rbac/index.ts` barrel export
- [ ] Run `npx vitest run` — confirm S1–S6 GREEN

### 1b.4 [RED] Tests for `useCan` hook
- [ ] Create `src/__tests__/lib/rbac/useCan.test.ts`
- [ ] S1: `permissions=["scheduling.read"]` → `useCan("scheduling.read")` returns `true`
- [ ] S2: `permissions=["scheduling.read"]` → `useCan("scheduling.delete")` returns `false`
- [ ] S3: `permissions=["*"]` → any `useCan(p)` returns `true`
- [ ] Run `npx vitest run` — confirm RED

### 1b.5 [GREEN] Implement `useCan`
- [ ] Create `src/lib/rbac/useCan.ts`: `function useCan(permission: string): boolean { const { can } = useMyPermissions(); return can(permission); }`
- [ ] Export from `src/lib/rbac/index.ts`
- [ ] Run `npx vitest run` — confirm GREEN

### 1b.6 [RED] Tests for `<Can>` component
- [ ] Create `src/__tests__/lib/rbac/Can.test.tsx`
- [ ] S4: permission granted → children rendered
- [ ] S5: permission denied → children NOT rendered
- [ ] S6: `isLoading=true` → children NOT rendered, null rendered
- [ ] S7: `isLoading=true` + `fallback={<span>loading</span>}` → fallback rendered, children NOT rendered
- [ ] S8: `mode="all"` both granted → rendered
- [ ] S9: `mode="all"` one missing → NOT rendered
- [ ] `isError=true` → fallback rendered (spec: treat error same as loading — render null/fallback)
- [ ] No `permission` or `permissions` prop → children rendered unconditionally
- [ ] Run `npx vitest run` — confirm RED

### 1b.7 [GREEN] Implement `<Can>` component
- [ ] Create `src/lib/rbac/Can.tsx`
- [ ] Props: `{ permission?, permissions?, mode?='any', fallback?=null, children }`
- [ ] `isLoading || isError` → `<>{fallback}</>`
- [ ] Resolve list from `permission` or `permissions`; if empty → render children unconditionally
- [ ] `mode='any'`: `list.some(p => can(p))`; `mode='all'`: `list.every(p => can(p))`
- [ ] Export from `src/lib/rbac/index.ts`
- [ ] Run `npx vitest run` — confirm GREEN

### 1b.8 [RED] Tests for `<RequirePermission>` component
- [ ] Create `src/__tests__/lib/rbac/RequirePermission.test.tsx`
- [ ] S10: user lacks permission → "No tenés permisos" in document, children NOT rendered
- [ ] S11: `isLoading=true` → children NOT rendered, loading indicator present
- [ ] S12: `permissions=["*"]` → children rendered
- [ ] S2 (error): `isError=true` → `NoPermissionPage` rendered
- [ ] Run `npx vitest run` — confirm RED

### 1b.9 [GREEN] Implement `<RequirePermission>` + `<NoPermissionPage>`
- [ ] Create `src/lib/rbac/NoPermissionPage.tsx`: centered card, lock icon, H2 "No tenés permisos para ver esta sección", body copy, "Volver al inicio" button → `navigate('/admin/dashboard')`, `role="main"`, `aria-label="Sin permisos"`
- [ ] Create `src/lib/rbac/NoPermissionPage.module.css`: semantic tokens only (`var(--color-*)`, `var(--space-*)`)
- [ ] Create `src/lib/rbac/RequirePermission.tsx`: loading → `<LoadingSkeleton />` (or spinner from atoms); `isError` or `!can(permission)` → `<NoPermissionPage />`; else children
- [ ] Export both from `src/lib/rbac/index.ts`
- [ ] Run `npx vitest run` — confirm GREEN on RequirePermission + NoPermissionPage tests

### 1b.10 [RED] Test: NoPermissionPage navigation CTA
- [ ] In `src/__tests__/lib/rbac/NoPermissionPage.test.tsx`
- [ ] S13: render in `MemoryRouter`, click "Volver al inicio" → `navigate('/admin/dashboard')` called (mock `useNavigate`)
- [ ] S: aria role `"main"` present, `aria-label="Sin permisos"` present
- [ ] Run `npx vitest run` — confirm RED then GREEN after 1b.9 implementation

### 1b.11 Replace `isAdmin` in `SchedulingTaskDetailPage.tsx`
- [ ] Read `src/pages/scheduling/SchedulingTaskDetailPage.tsx` — find the `isAdmin` variable and delete button
- [ ] Remove `const isAdmin = user?.role === 'admin' || ...` line
- [ ] Remove any import of `useAuth`/user that is only used for `isAdmin` (if it's also used for other things, keep it)
- [ ] Wrap the delete button with `<Can permission="scheduling.delete">...</Can>`; import `Can` from `@/lib/rbac`
- [ ] Update or remove existing test assertions on `isAdmin` in the scheduling task detail test file (if present)

### 1b.12 Replace `isAdmin` in `TasksTableView.tsx`
- [ ] Read `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx` — find line ~305
- [ ] Remove `const isAdmin = user?.role === 'admin' || ...` variable
- [ ] Wrap bulk-delete bar with `<Can permission="scheduling.bulk_delete">...</Can>`
- [ ] Wrap single-row delete icon button with `<Can permission="scheduling.delete">...</Can>`
- [ ] Update or remove tests that asserted on the `isAdmin` variable behaviour

### 1b.13 Full FE green gate
- [ ] Run `npx vitest run` — full suite GREEN (no regressions from setup.ts mock + new tests)
- [ ] Run `npx tsc --noEmit` in FE repo — zero type errors

---

## Phase 1c — Confirm super_admin bootstrap (no migration needed for Phase 1)

### 1c.1 Verify super_admin bootstrap is unchanged
- [ ] Read `prisma/seed.ts` (or the bootstrap script) — confirm super_admin user + role still seeded with existing grant structure
- [ ] Confirm Phase 1 ships without any migration: the `/me` endpoint's `permissions: ["*"]` comes purely from the in-memory sentinel logic, not from DB rows
- [ ] Document this explicitly in a comment in `ResolveUserPermissions.ts`

---

## Phase 2 — Migration: enum→varchar + 11 new modules + 24 sub-actions

### 2.1 Pre-migration audit
- [ ] Grep `prisma/schema.prisma` for all occurrences of `RbacAction` enum — confirm only `RbacPermission.action` references it
- [ ] Grep `src/` for `RbacAction` TypeScript imports — list affected files
- [ ] Grep FE repo `src/` for `RbacAction` references — list any FE types that need updating

### 2.2 Update `prisma/schema.prisma`
- [ ] Change `RbacPermission.action` from `action RbacAction` to `action String @db.VarChar(64)`
- [ ] Remove the `enum RbacAction { read write delete manage }` declaration entirely
- [ ] Ensure `@@unique([moduleId, action])` constraint is present on `RbacPermission`
- [ ] Ensure `RbacModule` has `@@unique([code])` (or `@unique` on `code` field) — add if missing

### 2.3 Update `src/domain/entities/rbac.ts`
- [ ] Add `PERMISSION_ACTIONS` const array with all 28 codes (4 base + 24 sub-actions per spec)
- [ ] Export `type PermissionAction = (typeof PERMISSION_ACTIONS)[number]`
- [ ] Update `RBAC_MODULES` array to include 11 new module codes
- [ ] Update `RbacPermission` entity type: `action: string` (open, reflects DB reality)
- [ ] Add `KNOWN_ACTIONS` comment documenting this is the TS source-of-truth for valid codes
- [ ] Run `npx tsc --noEmit` in BE repo — zero type errors after entity changes

### 2.4 [RED] Test: domain entity `rbac.ts` updated whitelist
- [ ] In `src/__tests__/domain/entities/rbac.test.ts`, add assertions:
- [ ] `PERMISSION_ACTIONS` includes all 4 base actions
- [ ] `PERMISSION_ACTIONS` includes at least the 24 sub-action codes from spec
- [ ] `RBAC_MODULES` has exactly 25 entries
- [ ] Run `npm test` — confirm RED (entities not yet updated) → then run after 2.3 → GREEN

### 2.5 Write migration SQL
- [ ] Create `prisma/migrations/20260530000000_rbac_permission_catalog_extension/migration.sql`
- [ ] Write full transactional SQL per design doc section 1.5: BEGIN; ALTER COLUMN; DROP TYPE; INSERT modules; INSERT base perms; INSERT sub-action perms; INSERT super_admin grants; COMMIT
- [ ] Verify all INSERTs use `ON CONFLICT ... DO NOTHING` (idempotency)
- [ ] Verify super_admin grant step uses `ON CONFLICT ("roleId","permissionId") DO NOTHING`

### 2.6 Manual SQL review checkpoint
- [ ] **STOP** — present the migration SQL to the user for review before applying
- [ ] User must explicitly approve before proceeding to 2.7

### 2.7 Apply migration
- [ ] Run `npm run prisma:migrate` with migration name `rbac_permission_catalog_extension`
- [ ] Verify migration applied without errors
- [ ] Run migration a second time (via `prisma migrate dev` or manual re-apply) — confirm idempotency (no errors, no duplicate rows)

### 2.8 [RED+GREEN] Post-migration count assertions
- [ ] Create (or extend) `src/__tests__/infrastructure/adapters/prisma/rbac-migration.test.ts`
- [ ] S1: `SELECT COUNT(*) FROM "RbacModule"` = 25
- [ ] S2: `SELECT COUNT(*) FROM "RbacPermission"` = 124
- [ ] S3: super_admin has 124 `RbacRolePermission` rows
- [ ] S4: re-run migration SQL → counts unchanged (idempotency)
- [ ] S5: `SELECT typname FROM pg_type WHERE typname = 'RbacAction'` = 0 rows
- [ ] Run `npm test` — GREEN (these are DB integration tests; skip if no test DB available, mark as manual verify)

### 2.9 Final BE green gate after migration
- [ ] Run `npm test` — full suite GREEN
- [ ] Run `npx tsc --noEmit` — zero errors

---

## Phase 3 — FE: page guards + nav filter + NoPermissionPage integration

### 3.1 [RED] Tests for nav filter in `Sidebar.tsx`
- [ ] In `src/__tests__/components/organisms/Sidebar/Sidebar.test.tsx` (create if absent)
- [ ] S14: `can = (p) => p !== 'billing.read'` → "Finanzas" nav item NOT in document
- [ ] S15: `isLoading=true` → ALL nav items present (no premature hiding)
- [ ] S: `isLoading=false`, `can=() => true` → all items visible
- [ ] Run `npx vitest run` — confirm RED

### 3.2 Locate and document Sidebar nav structure
- [ ] Read `src/components/Sidebar.tsx` — identify how nav items are defined (hardcoded JSX vs config array)
- [ ] If hardcoded JSX: extract nav item config into separate array/object co-located in the file
- [ ] Add `requiredPermission?: string` field to the nav item shape

### 3.3 [GREEN] Wire nav filter in `Sidebar.tsx`
- [ ] Import `useMyPermissions` from `@/lib/rbac`
- [ ] For each nav item: `if (item.requiredPermission && !isLoading && !can(item.requiredPermission))` → do not render
- [ ] While `isLoading`: render all items (per spec S15)
- [ ] Assign `requiredPermission` values per the mapping table in `rbac-frontend-primitives` spec (18+ nav items)
- [ ] Run `npx vitest run` — confirm nav filter tests GREEN

### 3.4 [RED] Tests for `<RequirePermission>` in route context
- [ ] In `src/__tests__/lib/rbac/RequirePermission.test.tsx` (extend from Phase 1)
- [ ] Confirm S10–S12 cover the page-guard usage pattern with `MemoryRouter`
- [ ] Add: super_admin (`permissions=["*"]`) → children rendered for any permission
- [ ] Run — confirm all GREEN

### 3.5 Wire `<RequirePermission>` to routes in `App.tsx`
- [ ] Read `src/App.tsx` — identify route definitions for each major section
- [ ] Import `RequirePermission` from `@/lib/rbac`
- [ ] Wrap each top-level page route with `<RequirePermission permission="{module}.read">` (config-driven where possible):
  - Scheduling: `scheduling.read`
  - Billing/Finanzas: `billing.read`
  - Clients: `clients.read`
  - Network: `network.read`
  - Monitoring: `monitoring.read`
  - Reports: `reports.read`
  - Tickets: `tickets.read`
  - Admin/RBAC: `admin.manage_admins` or `rbac.manage_roles`
  - CRM: `crm.read`
  - Inventory: `inventory.read`
- [ ] Add RBAC matrix route: `<Route path="/admin/administracion/roles" element={<RequirePermission permission="rbac.manage_roles"><RbacPermissionMatrixPage /></RequirePermission>} />`

### 3.6 Manual smoke test: Phase 3
- [ ] Log in as a limited user (or mock locally), confirm pages hidden in sidebar + URL access shows NoPermissionPage
- [ ] Log in as super_admin, confirm all pages accessible

### 3.7 FE green gate after Phase 3
- [ ] Run `npx vitest run` — full suite GREEN
- [ ] Run `npx tsc --noEmit` — zero errors

---

## Phase 4 — BE: new use cases + routes for matrix UI

### 4.1 [RED] Tests for `ListRolePermissions` use case
- [ ] Create `src/__tests__/application/rbac/ListRolePermissions.test.ts`
- [ ] S: role exists with 2 permissions → returns array with `{ id, moduleCode, action, moduleLabel }`
- [ ] S: unknown roleId → throws `DomainError('ROLE_NOT_FOUND')`
- [ ] S: empty roleId → throws `ValidationError`
- [ ] Run `npm test` — confirm RED

### 4.2 [GREEN] Implement `ListRolePermissions`
- [ ] Create `src/application/use-cases/rbac/ListRolePermissions.ts`
- [ ] Constructor: `(roleRepo, rolePermRepo, permRepo, moduleRepo)` — use ports only
- [ ] Validate roleId, resolve role (404 if null), get permissionIds, resolve with module join
- [ ] Return `RbacPermissionWithModule[]` shape
- [ ] Run `npm test` — GREEN

### 4.3 [RED] Tests for `SetRolePermissions` use case
- [ ] Create `src/__tests__/application/rbac/SetRolePermissions.test.ts`
- [ ] S: super_admin role → throws `DomainError('SUPER_ADMIN_IMMUTABLE')`
- [ ] S: unknown permissionId in list → throws `DomainError('INVALID_PERMISSION_IDS')`
- [ ] S: `permissionIds=[]` → clears all grants, returns `[]`
- [ ] S: idempotent re-apply (same IDs twice) → same result, no error
- [ ] S: valid replace `[A,B,C]` → `[B,D]` → final permissions = `[B,D]`
- [ ] Run `npm test` — confirm RED

### 4.4 [GREEN] Implement `SetRolePermissions`
- [ ] Create `src/application/use-cases/rbac/SetRolePermissions.ts`
- [ ] Validate roleId + permissionIds (not undefined)
- [ ] Fetch role → 404 if null; check `code !== 'super_admin'` else throw `SUPER_ADMIN_IMMUTABLE`
- [ ] Validate all permissionIds exist via `permRepo.listAll()`; collect unknowns → throw `INVALID_PERMISSION_IDS`
- [ ] Call `rolePermRepo.replaceForRole(roleId, permissionIds)`
- [ ] Return the new full permission list via `ListRolePermissions` (reuse)
- [ ] Run `npm test` — GREEN

### 4.5 [RED] Supertest for new role-permissions routes
- [ ] Create `src/__tests__/infrastructure/http/routes/rbacRolePermissions.routes.test.ts`
- [ ] S1: `GET /api/admin/rbac/roles/:id/permissions` — role with 2 perms → 200 `{ permissions: [...] }`
- [ ] S2: `GET` — role not found → 404 `{ code: "ROLE_NOT_FOUND" }`
- [ ] S3: `PUT` — happy path replace → 200 with new permission list
- [ ] S4: `PUT` — super_admin → 400 `{ code: "SUPER_ADMIN_IMMUTABLE" }`
- [ ] S5: `PUT` — invalid permissionId → 400 `{ code: "INVALID_PERMISSION_IDS" }`
- [ ] S6: `PUT` — empty array → 200 `{ permissions: [] }`
- [ ] S7: unauthenticated → 401
- [ ] S8: lacks `rbac.manage_roles` → 403
- [ ] Run `npm test` — confirm RED

### 4.6 [RED] Supertest for permissions catalog route
- [ ] In same test file or a new `permissions.routes.test.ts`
- [ ] S9: `GET /api/admin/rbac/permissions` → 200 `{ permissions: [{id, moduleCode, action, moduleLabel}] }`
- [ ] S: unauthenticated → 401
- [ ] S: lacks `rbac.manage_roles` → 403
- [ ] Run `npm test` — confirm RED

### 4.7 [GREEN] Implement route files + wire app.ts
- [ ] Create `src/infrastructure/http/routes/rolePermissions.routes.ts`: `GET /:id/permissions` + `PUT /:id/permissions` handlers
- [ ] Create `src/infrastructure/http/routes/permissions.routes.ts`: `GET /` handler using `rbacPermissionRepo.listAllWithModule()` (add this method to port + both adapters)
- [ ] Add `listAllWithModule(): Promise<Array<RbacPermission & { moduleLabel: string }>>` to `RbacPermissionRepository` port
- [ ] Implement in `InMemoryRbacPermissionRepository` and `PrismaRbacPermissionRepository`
- [ ] Wire in `app.ts`: instantiate `ListRolePermissions`, `SetRolePermissions`; mount routes at `/api/admin/rbac/roles/:id/permissions` and `/api/admin/rbac/permissions`
- [ ] Apply `requirePerm('rbac', 'manage_roles')` middleware on both routes
- [ ] Run `npm test` — confirm GREEN on route tests
- [ ] Run `npx tsc --noEmit` — zero errors

---

## Phase 4 FE — Matrix UI

### 4.8 [RED] Tests for RBAC API layer
- [ ] Create `src/__tests__/api/rbac.api.test.ts`
- [ ] Mock `axiosClient`; assert `listRoles()` → `GET /admin/rbac/roles`
- [ ] Assert `listPermissions()` → `GET /admin/rbac/permissions`
- [ ] Assert `getRolePermissions(id)` → `GET /admin/rbac/roles/{id}/permissions`
- [ ] Assert `setRolePermissions(id, ids)` → `PUT /admin/rbac/roles/{id}/permissions` with `{ permissionIds }`
- [ ] Assert `createRole(data)` → `POST /admin/rbac/roles`
- [ ] Assert `deleteRole(id)` → `DELETE /admin/rbac/roles/{id}`
- [ ] Run `npx vitest run` — confirm RED

### 4.9 [GREEN] Create `src/api/rbac.api.ts`
- [ ] Implement all 6 functions from spec: `listRoles`, `listPermissions`, `getRolePermissions`, `setRolePermissions`, `createRole`, `deleteRole`
- [ ] Export `RbacPermissionItem` interface
- [ ] Run `npx vitest run` — GREEN

### 4.10 [RED] Tests for `useRbacRoles`, `useRbacPermissions`, `useRolePermissions`, `useSetRolePermissions`
- [ ] Create `src/__tests__/hooks/useRbacHooks.test.ts`
- [ ] `useRbacRoles`: `staleTime=60_000`, query key `['rbac','roles']`
- [ ] `useRbacPermissions`: `staleTime=10*60*1000`, query key `['rbac','permissions']`
- [ ] `useRolePermissions(null)`: `enabled=false`; `useRolePermissions(id)`: `enabled=true`
- [ ] `useSetRolePermissions`: on success invalidates `['rbac','roles',roleId,'permissions']` AND `ME_PERMISSIONS_QUERY_KEY`
- [ ] Run `npx vitest run` — confirm RED

### 4.11 [GREEN] Create hooks
- [ ] Create `src/hooks/useRbacRoles.ts` (extend existing file if present, or create new)
- [ ] Create `src/hooks/useRbacPermissions.ts`
- [ ] Create `src/hooks/useRolePermissions.ts` with `useSetRolePermissions` mutation
- [ ] Run `npx vitest run` — GREEN

### 4.12 [RED] Tests for `<NewRoleModal>` component
- [ ] Create `src/__tests__/pages/admin/RbacPermissionMatrix/NewRoleModal.test.tsx`
- [ ] S5: fill code + label → submit → `createRole` called with correct data → modal closes
- [ ] S: empty code → submit blocked (validation error shown)
- [ ] S: code with invalid chars (uppercase/spaces) → validation error
- [ ] S: server returns 409 `ROLE_CODE_EXISTS` → inline error rendered
- [ ] Run `npx vitest run` — confirm RED

### 4.13 [GREEN] Implement `<NewRoleModal>`
- [ ] Create `src/pages/admin/components/RbacPermissionMatrix/NewRoleModal.tsx`
- [ ] `react-hook-form` with validation: `code` `/^[a-z0-9_-]+$/`, 3–32 chars; `label` required 2–64 chars
- [ ] On submit: call `rbacApi.createRole(data)`, invalidate `['rbac','roles']`, call `onSuccess(newRole)`, close
- [ ] Map 409 → inline field error on `code`
- [ ] CSS module `NewRoleModal.module.css` with semantic tokens, auto-focus on `code` input
- [ ] Run `npx vitest run` — GREEN

### 4.14 [RED] Tests for `<LeftRail>` component
- [ ] Create `src/__tests__/pages/admin/RbacPermissionMatrix/LeftRail.test.tsx`
- [ ] Role list renders with correct number of items
- [ ] Click role → `onSelect` called with roleId
- [ ] System roles show "Sistema" badge, custom roles show delete icon on hover
- [ ] Delete icon click + confirm → `deleteRole` called; role removed from list
- [ ] "Nuevo rol" button opens `<NewRoleModal>`
- [ ] `aria` attributes: `role="listbox"`, items `role="option"`, `aria-selected`
- [ ] Run `npx vitest run` — confirm RED

### 4.15 [GREEN] Implement `<LeftRail>`
- [ ] Create `src/pages/admin/components/RbacPermissionMatrix/LeftRail.tsx` + CSS module
- [ ] Use `useRbacRoles()` data; render list with system badge for `isSystem===true` roles
- [ ] Trash icon (hover-only via CSS) on custom roles → `window.confirm` → `rbacApi.deleteRole`
- [ ] "Nuevo rol" button → show `<NewRoleModal>` overlay; on success select new role
- [ ] Keyboard nav: up/down arrows on list items
- [ ] Run `npx vitest run` — GREEN

### 4.16 [RED] Tests for `<MatrixPanel>` / `<PermissionMatrix>` component
- [ ] Create `src/__tests__/pages/admin/RbacPermissionMatrix/PermissionMatrix.test.tsx`
- [ ] S1: select role → matrix shows correct checked/unchecked state
- [ ] S2: toggle checkbox → "Guardar" button enabled, "Descartar" visible
- [ ] S3: click "Guardar" → `setRolePermissions.mutateAsync` called with full Set as array
- [ ] S4: super_admin selected → all checkboxes disabled, "Guardar" button disabled
- [ ] S7: search "sched" → only scheduling row visible
- [ ] S8: dirty state + click different role → `window.confirm` called
- [ ] S9: loading state → shimmer rows visible
- [ ] S10: no role selected → "Seleccioná un rol" hint visible
- [ ] S11: bulk "Todo" on module → all module checkboxes checked
- [ ] AD-FE-7: super_admin row has lock icon (`getByRole('img', {name: /lock/i})` or aria equivalent)
- [ ] AD-FE-12: matrix checkboxes have `aria-checked` attribute
- [ ] Run `npx vitest run` — confirm RED

### 4.17 [GREEN] Implement `<MatrixPanel>` + sub-components
- [ ] Create `src/pages/admin/components/RbacPermissionMatrix/MatrixPanel.tsx` + CSS module
- [ ] Create `MatrixRow.tsx` (one module group) + CSS module
- [ ] Create `MatrixCell.tsx` (one checkbox cell) with `aria-checked`, `aria-label`
- [ ] State: `dirtyPermIds: Set<string> | null` in root `RbacPermissionMatrix`; pass down
- [ ] `useEffect` on role change: sync `staged` from `useRolePermissions` data, reset dirty
- [ ] Sticky header bar: "Guardar cambios" disabled unless dirty; "Descartar" resets state
- [ ] Save flow: `mutateAsync` → success banner 3s → reset dirty → invalidate queries
- [ ] Super_admin: all cells `checked + disabled`, lock icon Banner, "Guardar" hidden
- [ ] Search input clears on role change; filters module rows (label/code case-insensitive)
- [ ] Shimmer: 6 placeholder rows while `useRolePermissions` loading
- [ ] Dirty-on-role-switch: `window.confirm` before switching
- [ ] Bulk shortcuts ("Todo"/"Ninguno") per module row — hover-only visibility
- [ ] Apply IMPECCABLE tokens: `var(--color-primary-500)` for checkboxes, compact rows (40px), alternating bg, column header uppercase small
- [ ] Run `npx vitest run` — GREEN

### 4.18 Assemble `<RbacPermissionMatrix>` root + integrate into AdminPage
- [ ] Create `src/pages/admin/components/RbacPermissionMatrix/index.tsx`: compose `<LeftRail>` + `<MatrixPanel>` in 2-column flex layout
- [ ] In `src/pages/admin/AdminPage.tsx`: locate the `'roles'` tab content; replace legacy role JSX with `<RbacPermissionMatrix />`
- [ ] Add route in `App.tsx` if a standalone page is also needed: `<Route path="/admin/administracion/roles" element={<RequirePermission permission="rbac.manage_roles"><RbacPermissionMatrix /></RequirePermission>} />`

### 4.19 Verify 12 AD-FE decisions in code
- [ ] AD-FE-1: `<Can>` renders null on loading (assert in test)
- [ ] AD-FE-2: `<Can>` renders children on `isError` — wait, spec says `fallback` on error; confirm against `Can.test.tsx` (1b.6 S)
- [ ] AD-FE-3: `staleTime=5min` asserted in hook test
- [ ] AD-FE-4: matrix toggle updates `Set`, not array — assert in 4.16
- [ ] AD-FE-5: single PUT on save — assert in 4.16 S3
- [ ] AD-FE-6: dirty state + role switch → `window.confirm` — assert in 4.16 S8
- [ ] AD-FE-7: super_admin lock icon present — assert in 4.16
- [ ] AD-FE-8: modules collapsed by default in `MatrixRow` — verify in 4.17 implementation
- [ ] AD-FE-9: search filters modules (not cells) — assert S7
- [ ] AD-FE-10: save bar green check 2s then clears (state `'saved'` → `'pristine'`) — assert in 4.16 S3
- [ ] AD-FE-11: nav skeleton on loading — assert in Sidebar test (3.1)
- [ ] AD-FE-12: `aria-checked` on checkboxes — assert in 4.16

### 4.20 FE green gate after Phase 4
- [ ] Run `npx vitest run` — full suite GREEN
- [ ] Run `npx tsc --noEmit` — zero errors

---

## Phase 5 — Gate remaining action buttons with `<Can>`

### 5.1 Audit action buttons across major sections
- [ ] Grep FE repo for `onClick` handlers on destructive actions (delete, void, send, close, etc.) in: clients, billing, tickets, network, monitoring, crm, inventory, iclass, gestionReal, reports, settings
- [ ] Grep for remaining `user?.role === 'admin'` or `user?.role === 'superadmin'` occurrences (should be 0 after Phase 1, but verify)
- [ ] Produce a list of button/action locations that need `<Can>` wrapping

### 5.2 Wrap action buttons per section
- [ ] **Billing**: `invoice_create`, `invoice_send_email` / `send_email`, `payment_record`, `void` — wrap each with `<Can permission="billing.{action}">`
- [ ] **Tickets**: close, reopen buttons → `<Can permission="tickets.close">`, `<Can permission="tickets.reopen">`
- [ ] **Monitoring**: acknowledge-alert button → `<Can permission="monitoring.acknowledge_alert">`
- [ ] **Network**: GPON management → `<Can permission="network.manage_gpon">`; sites → `<Can permission="network.manage_sites">`
- [ ] **Clients**: manage documents → `<Can permission="clients.manage_documents">`; online sessions → `<Can permission="clients.manage_online_sessions">`
- [ ] **IClass**: sync button → `<Can permission="iclass.sync">`; assign to project → `<Can permission="iclass.assign_to_project">`
- [ ] **Admin**: 2FA management → `<Can permission="admin.manage_2fa">`; activity log → `<Can permission="admin.view_activity_log">`
- [ ] **Settings**: API tokens → `<Can permission="settings.manage_api_tokens">`; backups → `<Can permission="settings.manage_backups">`
- [ ] **Scheduling** (additional, beyond Phase 1): `move_stage`, `manage_checklist`, `send_to_iclass` actions

### 5.3 Update tests for wrapped buttons
- [ ] For each section touched: update or extend existing tests to assert button hidden when `can()` returns false for that permission
- [ ] Add at least one "shown when granted" test per section if not already present

### 5.4 Confirm zero legacy role checks remain
- [ ] Grep FE for `user?.role === 'admin'` → expect 0 results
- [ ] Grep FE for `user?.role === 'superadmin'` → expect 0 results
- [ ] Document any intentional exceptions (there should be none)

### 5.5 FE green gate after Phase 5
- [ ] Run `npx vitest run` — full suite GREEN
- [ ] Run `npx tsc --noEmit` — zero errors

---

## Phase 6 — Final quality + verify pass

### 6.1 BE final quality gate
- [ ] Run `npm test` — full suite GREEN, zero failures
- [ ] Run `npx tsc --noEmit` — zero type errors
- [ ] Review test count delta: ≥ 30 new BE tests added across all phases

### 6.2 FE final quality gate
- [ ] Run `npx vitest run` — full suite GREEN, zero failures
- [ ] Run `npx tsc --noEmit` — zero type errors
- [ ] Review test count delta: ≥ 50 new FE tests added across all phases

### 6.3 Commit plan (user decides at push time)
- [ ] **Option A** — one commit per phase (recommended for bisect-ability):
  - `feat(rbac): Phase 1a — ResolveUserPermissions + /me extension`
  - `feat(rbac): Phase 1b — Can/RequirePermission primitives + isAdmin replacements`
  - `feat(rbac): Phase 2 — enum→varchar migration + 11 modules + 24 sub-actions`
  - `feat(rbac): Phase 3 — nav filter + RequirePermission page guards`
  - `feat(rbac): Phase 4 — ListRolePermissions + SetRolePermissions + matrix UI`
  - `feat(rbac): Phase 5 — gate remaining action buttons`
- [ ] **Option B** — one BE commit + one FE commit (simpler, harder to bisect)
- [ ] User approves commit strategy before any `git commit`

### 6.4 Deploy checklist
- [ ] Phase 1 BE must deploy BEFORE Phase 1 FE (FE calls `/me` with new shape)
- [ ] Phase 2 migration must deploy BEFORE Phase 4 FE matrix (FE fetches 124 permissions)
- [ ] Confirm `env.example` unchanged (no new required env vars in this SDD)
