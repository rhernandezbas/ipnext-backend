# Design: Roles & Permissions Management

> SDD #3 — `roles-permissions-management`. Backend + Frontend.
> Strict TDD active in both repos. All AD entries call out test seams.

---

## 0. Snapshot

| Aspect | Value |
|--------|-------|
| Repos touched | `ipnext-backend` (Express/Prisma) + `ipnext-frontend` (React/Vite) |
| BE phases | 1 (`/me` ext), 2 (migration + catalog), [BE side of 3-5 is wiring only] |
| FE phases | 1 (`<Can>` + replace 2 isAdmin), 3 (guard + nav filter + 403), 4 (matrix UI), 5 (gate buttons) |
| Locked decisions (carry-overs) | VARCHAR(64) action, `/me` extended (single trip), `["*"]` super_admin sentinel, `<Can>` renders fallback on loading, 25 modules total |
| New BE files | 3 use cases (`ResolveUserPermissions`, `ListRolePermissions`, `SetRolePermissions`), 1 use case test seam (in-memory), 2 new route files (`rolePermissions.routes.ts`, `permissions.routes.ts`), 1 migration, schema delta |
| New FE files | 3 api files, 3 hooks, `<Can>`, `<RequirePermission>`, `<NoPermissionPage>`, matrix UI (rail + matrix + new role modal), nav filter integration, 2 isAdmin replacements |
| Risk hotspots | enum → varchar migration (transactional), flash-of-unauthorized (loading fallback in `<Can>`), matrix UX scale (25 modules × N actions × 6 roles) |

---

## 1. Backend Design

### 1.1 Domain Layer Deltas

#### 1.1.1 `PermissionAction` widening (src/domain/entities/rbac.ts)

Today:
```ts
export type PermissionAction = 'read' | 'write' | 'delete' | 'manage';
```

New: keep the union as a **type guard**, not the storage type. Storage in DB is `VARCHAR(64)`. Use case-level validation against a whitelist.

```ts
// Base actions (unchanged — kept for backwards compat in middleware sites)
export const BASE_ACTIONS = ['read', 'write', 'delete', 'manage'] as const;
export type BaseAction = (typeof BASE_ACTIONS)[number];

// Full whitelist (base + 24 curated sub-actions). Updated when new ones land.
export const PERMISSION_ACTIONS = [
  ...BASE_ACTIONS,
  // billing
  'invoice_create', 'invoice_send_email', 'payment_record',
  // scheduling
  'move_stage', 'manage_checklist', 'assign_checklist_template', 'set_inventory_review',
  // tickets
  'close', 'change_status', 'manage_replies',
  // crm
  'convert_lead', 'manage_leads',
  // monitoring
  'acknowledge_alert',
  // network
  'manage_sites', 'manage_gpon',
  // admin
  'manage_admins', 'view_activity_log', 'manage_2fa',
  // rbac
  'manage_users', 'manage_user_roles', 'change_user_password', 'manage_roles', 'manage_permissions',
  // profile (self-service)
  'change_own_password',
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number] | (string & {});
```

The `(string & {})` allows runtime-loaded codes through the type without losing autocomplete. Use case `SetRolePermissions` validates against `PERMISSION_ACTIONS` set before grant.

**Module catalog grows from 14 → 25:**
```ts
export const RBAC_MODULES = [
  // 14 existing
  'clients', 'billing', 'scheduling', 'network', 'admin', 'monitoring',
  'iclass', 'gestionReal', 'reports', 'tickets', 'settings', 'crm',
  'inventory', 'vehicles',
  // 11 new
  'voices', 'partners', 'rbac', 'profile', 'notifications',
  'dashboard', 'portal', 'search', 'support', 'sla', 'tariffs',
] as const;
```

#### 1.1.2 Port additions

**`RbacRolePermissionRepository`** gains:
```ts
/** Atomic replace — drops all current grants for roleId, then grants the new set in one tx. */
replaceForRole(roleId: string, permissionIds: string[]): Promise<void>;
```

**`RbacPermissionRepository`** gains (for the catalog endpoint):
```ts
/** Lists permissions with their module joined — used by GET /api/admin/rbac/permissions. */
listAllWithModule(): Promise<Array<RbacPermission & { moduleLabel: string }>>;
```

**Test seam**: contract tests in `_shared/rbacRolePermissionContractTests.ts` get a new `describe('replaceForRole')` block that asserts: (a) idempotent, (b) drops removed grants, (c) preserves grants in the new set, (d) rejects unknown permissionId.

### 1.2 Application Layer — New Use Cases

#### 1.2.1 `ResolveUserPermissions` (Phase 1 — unblocks delete-task)

Location: `src/application/use-cases/rbac/ResolveUserPermissions.ts`

```ts
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';

export class ResolveUserPermissions {
  constructor(private readonly userRepo: RbacUserRepository) {}

  /**
   * Returns the flat permission code list for a user.
   * - super_admin → ["*"] (sentinel)
   * - others → union of {moduleCode}.{action} codes across all roles
   */
  async execute(userId: string): Promise<string[]> {
    const roles = await this.userRepo.listRolesForUser(userId);
    if (roles.some((r) => r.code === 'super_admin')) {
      return ['*'];
    }
    const perms = await this.userRepo.listPermissionsForUser(userId);
    // Dedupe (a user with multiple roles can have the same perm twice)
    return Array.from(new Set(perms.map((p) => `${p.moduleCode}.${p.action}`))).sort();
  }
}
```

**Why this design**:
- Reuses existing `listRolesForUser` + `listPermissionsForUser` (already in port, already exercised by middleware).
- No new DB query shape; same hot path as middleware.
- Short-circuit FIRST keeps super_admin payload at 1 element.
- Sort gives stable output for snapshot tests.

**Test seam**: `src/__tests__/application/use-cases/rbac/ResolveUserPermissions.test.ts` — wire in `InMemoryRbacUserRepository`. Three cases: super_admin → `["*"]`, regular role with 5 perms → 5 sorted codes, user with two overlapping roles → deduped.

#### 1.2.2 `ListRolePermissions`

```ts
export class ListRolePermissions {
  constructor(private readonly rolePermRepo: RbacRolePermissionRepository) {}
  async execute(roleId: string): Promise<string[]> {
    return this.rolePermRepo.listForRole(roleId);
  }
}
```

Thin wrapper; mostly exists for symmetry with `SetRolePermissions` and to give the route a typed contract.

#### 1.2.3 `SetRolePermissions`

```ts
export class SetRolePermissions {
  constructor(
    private readonly rolePermRepo: RbacRolePermissionRepository,
    private readonly permissionRepo: RbacPermissionRepository,
    private readonly roleRepo: RbacRoleRepository,
  ) {}

  /**
   * Replaces the grant set of a role atomically.
   * Rejects super_admin role mutations (locked).
   * Rejects unknown permissionIds (404 PERMISSION_NOT_FOUND).
   */
  async execute(roleId: string, permissionIds: string[]): Promise<void> {
    const role = await this.roleRepo.findById(roleId);
    if (!role) throw new DomainError('ROLE_NOT_FOUND', 'Role not found');
    if (role.code === 'super_admin') {
      throw new DomainError('SUPER_ADMIN_LOCKED', 'super_admin permissions are managed by the system');
    }
    // Validate IDs exist — use a single query batch
    const all = await this.permissionRepo.listAll();
    const validIds = new Set(all.map((p) => p.id));
    const unknown = permissionIds.filter((id) => !validIds.has(id));
    if (unknown.length) {
      throw new DomainError('PERMISSION_NOT_FOUND', `Unknown permissions: ${unknown.join(',')}`);
    }
    await this.rolePermRepo.replaceForRole(roleId, permissionIds);
  }
}
```

**Why atomic replace, not diff**:
- Matrix UI submits the full final state. Simpler client (no need to compute diffs).
- Avoids race: two admins editing the same role end up with last-write-wins, not partial merges.
- Tradeoff: writes more rows on the DB. Acceptable — table is small (< 2000 rows max).

**Test seam**: in-memory repos for all three deps. Verify: (a) super_admin rejected with `SUPER_ADMIN_LOCKED`, (b) unknown id rejected, (c) empty array clears all grants, (d) idempotent re-apply.

### 1.3 HTTP Layer

#### 1.3.1 `/api/auth/me` extension (Phase 1)

Current handler returns `req.user` directly (the JWT payload `{ id, login, email }`).

New handler:
```ts
router.get('/me', authMiddleware, async (req, res) => {
  const userId = (req as any).user.id as string;
  const [user, roles, permissions] = await Promise.all([
    rbacUserRepo.findById(userId),
    rbacUserRepo.listRolesForUser(userId),
    resolveUserPermissions.execute(userId),
  ]);
  if (!user) {
    res.status(401).json({ error: 'NO_USER_CONTEXT' });
    return;
  }
  res.status(200).json({
    user: { id: user.id, login: user.login, email: user.email, name: user.name },
    roles: roles.map((r) => ({ id: r.id, code: r.code, label: r.label })),
    permissions, // ["*"] or flat list
  });
});
```

**Performance note**: 3 parallel queries. For a typical user with 1 role and < 30 perms, response is < 5ms on the prod DB. Optimization (single CTE) is deferred — measure first. `Promise.all` keeps tail latency = max of the three.

**Backwards compat**: existing FE consumers that read `me.id` directly will break. SDD #2 wired FE to read `me.user.id` post-login, so the shape change is intentional. Login response stays `{ user }` to match.

**Test seam**: supertest against the Express app with in-memory repos. Three cases: super_admin → `permissions: ["*"]`, regular user → list, unauthenticated → 401.

#### 1.3.2 New routes — fold into `role.routes.ts` or new files?

**Decision**: new files in `src/infrastructure/http/routes/`. Cleaner separation.

- **`rolePermissions.routes.ts`** — mounted at `/api/admin/rbac/roles/:id/permissions`
  - `GET /` → `ListRolePermissions` (requires `rbac.read`)
  - `PUT /` → `SetRolePermissions` (requires `rbac.manage_roles`)
- **`permissions.routes.ts`** — mounted at `/api/admin/rbac/permissions`
  - `GET /` → catalog of all permissions joined with modules (requires `rbac.read`)

Why split: `role.routes.ts` already has 5 verbs on `/roles` (list, get, create, update, delete). Adding 2 more sub-resource verbs makes it harder to scan. Sub-resource = sub-file is the pattern we already use (see `rbacUser.routes.ts` for `/:id/roles`, `/:id/password`).

**Note**: `requirePerm('rbac', 'read')` and `requirePerm('rbac', 'manage_roles')` are reused from the SDD #1 middleware factory.

#### 1.3.3 DI wiring in `app.ts` (~15 LOC)

```ts
// near other rbac imports
import { ResolveUserPermissions } from '@application/use-cases/rbac/ResolveUserPermissions';
import { ListRolePermissions } from '@application/use-cases/rbac/ListRolePermissions';
import { SetRolePermissions } from '@application/use-cases/rbac/SetRolePermissions';
import { createRolePermissionsRouter } from './routes/rolePermissions.routes';
import { createPermissionsRouter } from './routes/permissions.routes';

// after existing rbac construction
const resolveUserPermissions = new ResolveUserPermissions(rbacUserRepo);
const listRolePermissions = new ListRolePermissions(rbacRolePermissionRepo);
const setRolePermissions = new SetRolePermissions(
  rbacRolePermissionRepo, rbacPermissionRepo, rbacRoleRepo,
);

// inject into auth router (replaces existing createAuthRouter signature)
const authRouter = createAuthRouter(authProvider, rbacUserRepo, resolveUserPermissions);

// mount new admin routes
app.use('/api/admin/rbac/roles/:id/permissions', requireAuth, createRolePermissionsRouter(
  listRolePermissions, setRolePermissions, requirePerm,
));
app.use('/api/admin/rbac/permissions', requireAuth, createPermissionsRouter(
  rbacPermissionRepo, requirePerm,
));
```

### 1.4 Schema diff (prisma/schema.prisma)

```diff
- enum RbacAction {
-   read
-   write
-   delete
-   manage
- }
-
  model RbacPermission {
    id       String               @id @default(uuid())
    moduleId String
-   action   RbacAction
+   action   String               @db.VarChar(64)
    module   RbacModule           @relation(fields: [moduleId], references: [id], onDelete: Restrict)
    grants   RbacRolePermission[]

    @@unique([moduleId, action])
    @@index([moduleId])
  }
```

`RbacAction` enum is **dropped** from `schema.prisma`. We checked: it is only referenced by `RbacPermission.action`, nowhere else. The TypeScript `PermissionAction` union (1.1.1) replaces it as the runtime contract.

### 1.5 Migration `20260530000000_rbac_permission_catalog_extension`

Phases inside one transaction, idempotent.

```sql
BEGIN;

-- (a) Widen the column. Use USING to cast enum → text.
ALTER TABLE "RbacPermission"
  ALTER COLUMN "action" TYPE VARCHAR(64) USING "action"::text;

-- (b) Drop the enum type. Will fail if any other column references it — checked: none do.
DROP TYPE IF EXISTS "RbacAction";

-- (c) Insert 11 new modules (idempotent).
INSERT INTO "RbacModule" ("id", "code", "label", "createdAt") VALUES
  (gen_random_uuid(), 'voices',        'Voz / VoIP',        NOW()),
  (gen_random_uuid(), 'partners',      'Resellers',         NOW()),
  (gen_random_uuid(), 'rbac',          'Roles y Permisos',  NOW()),
  (gen_random_uuid(), 'profile',       'Perfil',            NOW()),
  (gen_random_uuid(), 'notifications', 'Notificaciones',    NOW()),
  (gen_random_uuid(), 'dashboard',     'Panel de control',  NOW()),
  (gen_random_uuid(), 'portal',        'Portal del cliente',NOW()),
  (gen_random_uuid(), 'search',        'Búsqueda global',   NOW()),
  (gen_random_uuid(), 'support',       'Mensajería',        NOW()),
  (gen_random_uuid(), 'sla',           'SLA',               NOW()),
  (gen_random_uuid(), 'tariffs',       'Tarifas',           NOW())
ON CONFLICT (code) DO NOTHING;

-- (d) Insert 4 base permissions × 11 new modules via CROSS JOIN.
-- Tricky part — we want ONLY the 11 new modules, not all 25.
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m.id, a.action
FROM "RbacModule" m
CROSS JOIN (
  VALUES ('read'), ('write'), ('delete'), ('manage')
) AS a(action)
WHERE m.code IN (
  'voices','partners','rbac','profile','notifications',
  'dashboard','portal','search','support','sla','tariffs'
)
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- (e) Insert sub-action permissions (24 rows, curated).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m.id, sa.action
FROM "RbacModule" m
JOIN (
  VALUES
    ('billing','invoice_create'), ('billing','invoice_send_email'), ('billing','payment_record'),
    ('scheduling','move_stage'), ('scheduling','manage_checklist'),
    ('scheduling','assign_checklist_template'), ('scheduling','set_inventory_review'),
    ('tickets','close'), ('tickets','change_status'), ('tickets','manage_replies'),
    ('crm','convert_lead'), ('crm','manage_leads'),
    ('monitoring','acknowledge_alert'),
    ('network','manage_sites'), ('network','manage_gpon'),
    ('admin','manage_admins'), ('admin','view_activity_log'), ('admin','manage_2fa'),
    ('rbac','manage_users'), ('rbac','manage_user_roles'),
    ('rbac','change_user_password'), ('rbac','manage_roles'), ('rbac','manage_permissions'),
    ('profile','change_own_password')
) AS sa(module_code, action) ON sa.module_code = m.code
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- (f) super_admin grants — CROSS JOIN onto ALL permissions (idempotent).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r.id, p.id, NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
WHERE r.code = 'super_admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
```

**Post-migration counts** (assertable in CI):
- `RbacModule` = 25 (14 + 11)
- `RbacPermission` = 25 × 4 + 24 = 124
- `RbacRolePermission` for `super_admin` = 124
- Other 5 roles still 0 grants (configured from UI)

**Rollback** (`down.sql`, not auto-generated, manual safety net):
```sql
BEGIN;
DELETE FROM "RbacRolePermission" WHERE "permissionId" IN (
  SELECT id FROM "RbacPermission" WHERE "moduleId" IN (
    SELECT id FROM "RbacModule" WHERE code IN ('voices','partners','rbac','profile','notifications','dashboard','portal','search','support','sla','tariffs')
  ) OR action NOT IN ('read','write','delete','manage')
);
DELETE FROM "RbacPermission" WHERE action NOT IN ('read','write','delete','manage')
  OR "moduleId" IN (SELECT id FROM "RbacModule" WHERE code IN ('voices',...));
DELETE FROM "RbacModule" WHERE code IN ('voices',...);
CREATE TYPE "RbacAction" AS ENUM ('read','write','delete','manage');
ALTER TABLE "RbacPermission" ALTER COLUMN "action" TYPE "RbacAction" USING "action"::"RbacAction";
COMMIT;
```

### 1.6 BE Architecture Decisions (AD-BE-1 … AD-BE-8)

| ID | Decision | Why | Test seam |
|----|----------|-----|-----------|
| AD-BE-1 | `ResolveUserPermissions` lives in `src/application/use-cases/rbac/` subfolder | Aligns with sub-domain grouping; SDD #1 already put `Rbac*` use cases under `rbac/` in archive. Easier to find. | `__tests__/application/use-cases/rbac/ResolveUserPermissions.test.ts` |
| AD-BE-2 | super_admin sentinel `["*"]` resolved at use case level, NOT at the SQL layer | Keeps the SQL simple (no UNION ALL with a wildcard); keeps the contract testable without a DB. | In-memory test: role with code `super_admin` → assert `result === ['*']`. |
| AD-BE-3 | Atomic replace (`replaceForRole`) instead of diff (grant/revoke deltas) | Matrix UI ships the final state; client doesn't compute deltas; eliminates race conditions. | Contract test: replace [A,B,C] with [B,D] → final state `[B,D]`. |
| AD-BE-4 | Action stored as `VARCHAR(64)`, validated by `PERMISSION_ACTIONS` set at use case boundary, NOT at DB CHECK constraint | Adding sub-actions = code change only, no migration. CHECK constraint would lock us in. | Use case test: `SetRolePermissions` with unknown permissionId → throws `PERMISSION_NOT_FOUND`. |
| AD-BE-5 | `/me` returns `{ user, roles, permissions }` (additive shape change) | Single round-trip on FE boot; aligns with TanStack Query bootstrap pattern. | Supertest: GET `/me` with valid JWT → shape assertion. |
| AD-BE-6 | New routes split into 2 files (`rolePermissions.routes.ts`, `permissions.routes.ts`) NOT folded into `role.routes.ts` | role.routes already has 5 verbs; sub-resource = sub-file is the existing pattern (see `rbacUser.routes.ts`). | Each route file gets its own supertest suite. |
| AD-BE-7 | `super_admin` role mutations REJECTED at use case level (`SUPER_ADMIN_LOCKED`) | Defensive — UI hides the edit button but a curl could still try. Keep super_admin grants exclusively migration-managed. | In-memory test: `SetRolePermissions({roleId: super_admin_id})` → throws. |
| AD-BE-8 | Drop `RbacAction` enum from Prisma schema entirely, NOT leave it for safety | Enum + varchar coexisting is confusing; CI count assertion catches drift. Migration is transactional, easy to revert. | Schema snapshot test (existing) covers shape. |

---

## 2. Frontend Design

### 2.1 File layout

```
src/
├── api/
│   ├── myPermissions.api.ts          # NEW — GET /auth/me (returns { user, roles, permissions })
│   ├── rolePermissions.api.ts         # NEW — list/replace role permissions
│   └── rbacPermissions.api.ts         # NEW — catalog
├── hooks/
│   ├── useMyPermissions.ts            # NEW — TanStack hook + can() helper
│   ├── useRolePermissions.ts          # NEW — useQuery + useMutation
│   └── useRbacPermissions.ts          # NEW — catalog query
├── components/
│   └── auth/
│       ├── Can.tsx                    # NEW — render-if-allowed primitive
│       ├── RequirePermission.tsx      # NEW — route-level guard
│       ├── NoPermissionPage.tsx       # NEW — friendly 403 page
│       └── NoPermissionPage.module.css
├── pages/
│   └── system/
│       └── admin/
│           ├── RolesMatrixPage.tsx           # NEW — top-level, owns layout
│           ├── RolesMatrixPage.module.css
│           ├── RolesListRail.tsx             # NEW — left column
│           ├── RolesListRail.module.css
│           ├── PermissionMatrix.tsx          # NEW — center grid widget
│           ├── PermissionMatrix.module.css
│           ├── NewRoleModal.tsx              # NEW — create custom role
│           └── NewRoleModal.module.css
├── routes/
│   └── nav-permissions.ts              # NEW — nav item → required permission map (co-located w/ App.tsx routes)
└── __tests__/                          # mirror structure
```

Path alias `@/` already configured (vite.config + tsconfig).

### 2.2 Hook contracts

#### 2.2.1 `useMyPermissions`

```ts
import type { AuthUser, RbacRole } from '@/types/auth';

export interface MyPermissionsState {
  user: AuthUser | null;
  roles: RbacRole[];
  permissions: string[];     // ["*"] for super_admin
  isLoading: boolean;
  isError: boolean;
  can: (perm: string | string[], mode?: 'any' | 'all') => boolean;
}

export function useMyPermissions(): MyPermissionsState {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: myPermissionsApi.getMe,
    staleTime: 5 * 60_000,    // 5 min — perms rarely change mid-session
    gcTime: 30 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const can = useCallback((p: string | string[], mode: 'any' | 'all' = 'any'): boolean => {
    if (!data) return false;
    const perms = data.permissions;
    if (perms.includes('*')) return true;
    const list = Array.isArray(p) ? p : [p];
    return mode === 'any'
      ? list.some((x) => perms.includes(x))
      : list.every((x) => perms.includes(x));
  }, [data]);

  return {
    user: data?.user ?? null,
    roles: data?.roles ?? [],
    permissions: data?.permissions ?? [],
    isLoading,
    isError,
    can,
  };
}
```

**Cache strategy**:
- `staleTime: 5min` — perms don't change mid-session.
- `gcTime: 30min` — keep around in case of tab switches.
- **Invalidation triggers**:
  - On login (mutation `useLogin().onSuccess` → `qc.invalidateQueries(['auth','me'])`)
  - After `useSetRolePermissions` mutation (cross-hook) → if changed role is in current user's roles, invalidate `['auth','me']`.
  - After `useSetUserRoles` mutation (existing in SDD #2) → invalidate `['auth','me']`.
- **No invalidation on window focus** — explicit choice to avoid network noise.

**Test seam**: `vi.mock('@/api/myPermissions.api')`. Helper `renderWithQuery(ui)` wraps in `QueryClientProvider` with `defaultOptions: { queries: { retry: false } }`.

#### 2.2.2 `useRolePermissions` + `useSetRolePermissions`

```ts
export function useRolePermissions(roleId: string | null) {
  return useQuery({
    queryKey: ['rbac', 'roles', roleId, 'permissions'],
    queryFn: () => rolePermissionsApi.list(roleId!),
    enabled: !!roleId,
    staleTime: 60_000,
  });
}

export function useSetRolePermissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { roleId: string; permissionIds: string[] }) =>
      rolePermissionsApi.replace(vars.roleId, vars.permissionIds),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['rbac', 'roles', vars.roleId, 'permissions'] });
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });    // cross-hook
    },
  });
}
```

#### 2.2.3 `useRbacPermissions`

Single query for the catalog:
```ts
export function useRbacPermissions() {
  return useQuery({
    queryKey: ['rbac', 'permissions'],
    queryFn: rbacPermissionsApi.list,
    staleTime: 60 * 60_000,   // catalog is migration-driven, rarely changes
  });
}
```

### 2.3 `<Can>` component

```tsx
interface CanProps {
  permission?: string;
  permissions?: string[];       // any-match by default
  mode?: 'any' | 'all';
  children: ReactNode;
  fallback?: ReactNode;          // default: null
}

export function Can({ permission, permissions, mode = 'any', children, fallback = null }: CanProps) {
  const { can, isLoading, isError } = useMyPermissions();

  // During loading: render fallback. Why? Flashing an allowed UI then
  // unmounting it on resolve is jarring AND can briefly leak privileged
  // actions to users who don't have them. Render-fallback is safer.
  if (isLoading) return <>{fallback}</>;

  // On error: behave as permissive (locked decision — see proposal). This
  // protects existing UI flows from a fully broken /me call.
  if (isError) return <>{children}</>;

  const list = permission ? [permission] : (permissions ?? []);
  return can(list, mode) ? <>{children}</> : <>{fallback}</>;
}
```

Why fallback on loading (not children, not null with no opt-out): avoids the flash. The caller decides what loading looks like — for a button it's typically `undefined` (collapses); for a section header it might be a `<Skeleton />`.

**Test seam**: `vi.mock('@/hooks/useMyPermissions')`. Mock `{ isLoading: false, isError: false, can: vi.fn().mockReturnValue(true) }` for the allowed case.

### 2.4 `<RequirePermission>` page guard

```tsx
interface RequirePermissionProps {
  permission: string;
  children: ReactNode;
  loadingFallback?: ReactNode;   // default: <PageSkeleton />
}

export function RequirePermission({
  permission, children, loadingFallback = <PageSkeleton />,
}: RequirePermissionProps) {
  const { can, isLoading } = useMyPermissions();
  if (isLoading) return <>{loadingFallback}</>;
  if (!can(permission)) {
    // Debug aid for ops
    console.warn(`[RequirePermission] denied: ${permission}`);
    return <NoPermissionPage requiredPermission={permission} />;
  }
  return <>{children}</>;
}
```

Used in `App.tsx` route wrapping:
```tsx
<Route path="/admin/rbac/roles" element={
  <RequirePermission permission="rbac.manage_roles">
    <RolesMatrixPage />
  </RequirePermission>
} />
```

### 2.5 `<NoPermissionPage>` — IMPECCABLE design

Layout:
- **Centered card** on a muted background (uses `var(--color-bg-subtle)`).
- **Icon**: lock SVG (24×24, primary muted color).
- **Title**: "No tenés permisos" (size: var(--font-size-xl), weight 600).
- **Subtitle**: "Esta sección requiere acceso que aún no te fue otorgado. Si pensás que es un error, contactá al administrador." (muted).
- **Required permission badge** (debug, hidden in prod via `import.meta.env.PROD` check): shows the missing code in monospace.
- **Primary CTA**: `<Button variant="primary">Volver al inicio</Button>` → `navigate('/admin/dashboard')`.
- **Secondary CTA**: `<Button variant="ghost">Atrás</Button>` → `navigate(-1)`.
- **Aria**: `<main role="main" aria-labelledby="no-perm-title">`. Title gets `id="no-perm-title"`.
- **Motion**: card fades in with 200ms ease, 8px upward translate (`@keyframes fadeUp`).

CSS module uses semantic tokens only: `--color-text-primary`, `--color-text-muted`, `--color-bg-card`, `--space-md`, `--radius-md`. No hardcoded values.

### 2.6 Nav filter

Today `Sidebar.tsx` (307 lines) hardcodes the nav structure. Strategy:

1. Extract nav config into `src/routes/nav-permissions.ts` (new file, also co-locatable with App.tsx routes for symmetry):

```ts
export interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: IconType;
  requiredPermission: string;   // module.action; "" = always visible (e.g. profile)
  children?: NavItem[];
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Panel', path: '/admin/dashboard', icon: HomeIcon, requiredPermission: 'dashboard.read' },
  { key: 'clients', label: 'Clientes', path: '/admin/customers', icon: UsersIcon, requiredPermission: 'clients.read' },
  // ... 25 entries
];
```

2. Sidebar reads:
```tsx
const { can, isLoading } = useMyPermissions();
const visibleItems = useMemo(() =>
  NAV_ITEMS.filter((item) =>
    item.requiredPermission === '' || can(item.requiredPermission)
  ),
  [can]
);
if (isLoading) return <SidebarSkeleton />;  // avoids flash
```

3. For section headers (Empresa, Sistema, CRM): hide the whole header if all children are hidden.

**Test seam**: `vi.mock('@/hooks/useMyPermissions')`. Render Sidebar with `can: vi.fn(p => p !== 'billing.read')` → assert "Finanzas" item not in DOM.

### 2.7 Matrix Editor (centerpiece — Phase 4)

#### 2.7.1 Layout (IMPECCABLE)

3-column responsive grid:

```
┌────────────────┬─────────────────────────────────────┬────────────┐
│  Roles rail    │  Permission matrix                   │  (empty)   │
│  280px         │  flex 1                              │            │
│                │                                      │            │
│  ◯ Admin       │  ┌──────────────┬──────────────┐    │            │
│  ● Ventas      │  │ Search...    │              │    │            │
│  ◯ NOC         │  ├──────────────┴──────────────┤    │            │
│  ◯ Técnico     │  │ ▼ Clientes (5)              │    │            │
│  ◯ super_admin │  │   ☑ read  ☑ write  ☐ delete │    │            │
│   (lock icon)  │  │   ☐ manage_documents        │    │            │
│                │  │ ▼ Facturación (7)            │    │            │
│  + Crear rol   │  │   ...                        │    │            │
│                │  │                              │    │            │
└────────────────┴──────────────────────────────────────┘
                 │  Save bar (sticky bottom)            │
                 │  [4 cambios] [Descartar] [Guardar]   │
                 └──────────────────────────────────────┘
```

#### 2.7.2 State machine

```ts
type DirtyState = 'pristine' | 'dirty' | 'saving' | 'saved';

const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
const [staged, setStaged] = useState<Set<string>>(new Set());
const [dirtyState, setDirtyState] = useState<DirtyState>('pristine');

const { data: rolePerms } = useRolePermissions(selectedRoleId);
const { data: catalog } = useRbacPermissions();
const setRolePerms = useSetRolePermissions();

// Sync staged from server when role changes
useEffect(() => {
  if (rolePerms) {
    setStaged(new Set(rolePerms));
    setDirtyState('pristine');
  }
}, [rolePerms, selectedRoleId]);

const toggle = (permId: string) => {
  setStaged((prev) => {
    const next = new Set(prev);
    next.has(permId) ? next.delete(permId) : next.add(permId);
    return next;
  });
  setDirtyState('dirty');
};
```

#### 2.7.3 Save flow

```ts
const handleSave = async () => {
  if (!selectedRoleId) return;
  setDirtyState('saving');
  try {
    await setRolePerms.mutateAsync({
      roleId: selectedRoleId,
      permissionIds: Array.from(staged),
    });
    setDirtyState('saved');
    setTimeout(() => setDirtyState('pristine'), 2000);
  } catch (e) {
    // axios error → setError; setDirtyState back to 'dirty'
  }
};
```

The hook invalidates `['auth','me']` automatically (2.2.2), so if the admin just edited their own role they get fresh perms on next refetch.

#### 2.7.4 Discard / navigate-away

`useBeforeUnload(dirtyState === 'dirty', 'Tenés cambios sin guardar. ¿Querés salir?')` (React Router v6 `useBlocker` is the supported API). For in-app nav, intercept the link click → custom confirm modal styled to match.

#### 2.7.5 Grouping & search

```ts
const grouped = useMemo(() => {
  const byModule = new Map<string, RbacPermission[]>();
  catalog?.forEach((p) => {
    const code = p.code.split('.')[0];   // 'clients.read' → 'clients'
    if (!byModule.has(code)) byModule.set(code, []);
    byModule.get(code)!.push(p);
  });
  if (search) {
    for (const [code] of byModule) {
      const moduleLabel = MODULE_LABELS[code] ?? code;
      if (!moduleLabel.toLowerCase().includes(search.toLowerCase())) {
        byModule.delete(code);
      }
    }
  }
  return byModule;
}, [catalog, search]);
```

Module header shows `<ModuleHeader label="Clientes" count={5} expanded={...} onToggle={...} />`. Counts = granted in current staged set / total.

#### 2.7.6 Bulk shortcuts

- **All in module**: header has a tri-state checkbox (none / some / all) that toggles all rows.
- **All for action across modules**: column header for base actions shows tri-state too; clicking toggles `read` (or `write`/etc) across all modules.

These are convenience; underlying state is still `staged: Set<permId>`.

#### 2.7.7 super_admin row

When `selectedRoleId` points at super_admin:
- All cells appear `checked + disabled`.
- Top of matrix renders `<Banner variant="info"><LockIcon />Acceso total por sistema — no editable</Banner>`.
- Save bar hidden.
- Tooltip on every disabled checkbox: "Acceso total por sistema".

Color: muted bg `var(--color-bg-subtle)` on the matrix container to signal read-only.

#### 2.7.8 Keyboard navigation (a11y)

- `role="grid"` on matrix container with `aria-rowcount` / `aria-colcount`.
- Arrow keys: ←↑→↓ move focus between cells.
- `Space`: toggle checkbox.
- `Tab`: jumps to next module (skips intra-module cells).
- `Esc`: discard pending changes (with confirm if dirty).
- `aria-busy={dirtyState === 'saving'}` on matrix container.

#### 2.7.9 Loading skeleton

While `rolePerms` or `catalog` is loading, render `<MatrixSkeleton modules={4} actionsPerModule={5} />` (shimmer placeholder rows). Avoids flash.

#### 2.7.10 Mobile (< 768px)

Grid collapses to single column. Roles rail becomes a dropdown at top. Matrix becomes accordion-per-module with checkboxes stacked vertically (1 column instead of grid).

#### 2.7.11 Create custom role modal (`NewRoleModal`)

- Sticky header (consistent with `useTaskCategories` modal pattern from FE init memory).
- Auto-focus first input (the `code` field).
- Validation:
  - `code`: required, kebab-case-alphanumeric only (`/^[a-z0-9-]+$/`), 3-32 chars; debounced server-check via existing `ListRoles` use case (`409 ROLE_CODE_EXISTS`).
  - `label`: required, 2-64 chars.
  - `description`: optional, ≤ 256 chars.
- Submit → POST `/api/admin/rbac/roles` (existing) → on success, set selectedRoleId = new id, close modal, focus matrix.

### 2.8 isAdmin replacements (Phase 1)

Two files, mechanical edit:

1. `src/pages/scheduling/SchedulingTaskDetailPage.tsx:63`
   ```tsx
   - const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
   - { isAdmin && <Button onClick={handleDelete}>Eliminar</Button> }
   + <Can permission="scheduling.delete">
   +   <Button onClick={handleDelete}>Eliminar</Button>
   + </Can>
   ```

2. `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx:305`
   - Same shape; wrap bulk delete + admin-only column.

### 2.9 FE Architecture Decisions (AD-FE-1 … AD-FE-12) — IMPECCABLE pass

| ID | Decision | Why (IMPECCABLE rationale) | Test seam |
|----|----------|----------------------------|-----------|
| AD-FE-1 | `<Can>` renders `fallback` on loading, **never children** | Flashing an authorized button then hiding it leaks info AND is jarring. Visual stability > optimism. | `vi.mock` hook with `isLoading: true` → assert children NOT rendered. |
| AD-FE-2 | `<Can>` renders children on `isError` (permissive) | If `/me` is fully broken, breaking the entire UI is worse than over-exposing. Server still enforces auth. Tradeoff documented in proposal as risk. | `vi.mock` hook with `isError: true` → assert children rendered. |
| AD-FE-3 | `useMyPermissions` uses TanStack Query with `staleTime: 5min` and no window-focus refetch | Perms change rarely; refetch on every tab switch creates noise + unnecessary 401-recovery work. | Hook test: assert query options config. |
| AD-FE-4 | Matrix state lives in a `Set<permissionId>` (not array) | O(1) toggle. Diff with server state for dirty flag is O(n) but n is small (< 200). | Component test: toggle a cell → expect `staged.has(id)` true. |
| AD-FE-5 | Atomic save (full state PUT) — NO per-checkbox network call | Optimistic-per-cell UIs cause confused rollbacks on error mid-edit. Atomic = one error, one rollback, mental model holds. | Mock `useSetRolePermissions` → assert single mutation call with full set on Save. |
| AD-FE-6 | Discard requires confirmation when dirty | Closing a tab full of unsaved work without confirm is hostile. | E2E: dirty state + navigate → assert modal appears. |
| AD-FE-7 | super_admin row visually different (muted bg + lock icon + tooltip), NOT just disabled checkboxes | Disabled-only feels broken ("why can't I click this?"). Lock + banner explains. | Visual snapshot + a11y query: `getByRole('img', { name: /lock/i })`. |
| AD-FE-8 | Module rows collapse by default with badge `granted/total` count, BUT expand on first render of dirty module | Reduces cognitive load (25 modules), but doesn't hide active edits. | Component test: toggle in collapsed module → expect module auto-expands. |
| AD-FE-9 | Search filters MODULES (not cells), with label-match (no fuzzy) | Cells filter is confusing — disappearing cells inside expanded modules breaks the grid metaphor. Module filter is cleaner mental model. | Search "factur" → assert only billing-related modules in DOM. |
| AD-FE-10 | Save feedback: green check pulse on save bar for 2s, then auto-clear (no toast spam) | Toasts pile up if admin saves rapidly. Inline feedback = local, contextual. | Test: trigger save → expect `dirtyState === 'saved'` for 2s. |
| AD-FE-11 | Nav filter renders Skeleton on `isLoading`, NOT empty sidebar | Empty sidebar feels broken on slow networks. Skeleton signals "loading" to the user. | Render Sidebar with isLoading:true → assert SidebarSkeleton present. |
| AD-FE-12 | Matrix grid uses semantic colors (success token for grant, neutral for deny) AND aria-checked, NOT just color | Color-blind users + screen readers need the textual signal. Color is decoration, aria is truth. | `getByRole('checkbox', { name: /clients.read/ })` in component test. |

### 2.10 Test strategy

| Layer | Concern | Tool | Location |
|-------|---------|------|----------|
| API client | URL shape + axios call | vitest + msw OR direct axios mock | `__tests__/api/myPermissions.api.test.ts` |
| Hook | Cache config, can() correctness | vitest + `renderHook` + `QueryClientProvider` | `__tests__/hooks/useMyPermissions.test.tsx` |
| `<Can>` | render-if-allowed, loading fallback, isError permissive | RTL + `vi.mock('@/hooks/useMyPermissions')` | `__tests__/components/auth/Can.test.tsx` |
| `<RequirePermission>` | denied → NoPermissionPage, loading → skeleton | RTL + mock hook | `__tests__/components/auth/RequirePermission.test.tsx` |
| `<NoPermissionPage>` | a11y, CTA navigation | RTL + `MemoryRouter` | `__tests__/components/auth/NoPermissionPage.test.tsx` |
| Sidebar nav filter | hidden items when can() returns false | RTL + mock hook | `__tests__/components/organisms/Sidebar/Sidebar.test.tsx` |
| `RolesMatrixPage` | full edit flow: select role → toggle → save | RTL + mock all 3 hooks | `__tests__/pages/system/admin/RolesMatrixPage.test.tsx` |
| `PermissionMatrix` | toggle, bulk shortcuts, super_admin disabled | RTL + props-only | `__tests__/pages/system/admin/PermissionMatrix.test.tsx` |
| `NewRoleModal` | validation, server-error mapping | RTL + mock `useCreateRole` | `__tests__/pages/system/admin/NewRoleModal.test.tsx` |
| Replaced isAdmin spots | delete button visible iff `scheduling.delete` | RTL + mock hook | (extend existing scheduling tests) |

### 2.11 Wiring deltas (FE)

In `App.tsx`:
```diff
+ import { RolesMatrixPage } from '@/pages/system/admin/RolesMatrixPage';
+ import { RequirePermission } from '@/components/auth/RequirePermission';

  <Route path="/admin/administracion" element={<AdminPage />} />
+ <Route path="/admin/administracion/roles" element={
+   <RequirePermission permission="rbac.manage_roles">
+     <RolesMatrixPage />
+   </RequirePermission>
+ } />
```

In `AuthContext.tsx`: NO change to AuthContext — `useMyPermissions` is a separate hook that runs alongside. AuthContext stays focused on `user` only; the permissions cache is owned by TanStack Query so it can be invalidated cleanly without ContextProvider gymnastics.

### 2.12 Types

`src/types/auth.ts` (extend):
```ts
export interface AuthUser {
  id: string;
  login: string;
  email: string;
  name?: string;
}

export interface RbacRoleSummary {
  id: string;
  code: string;
  label: string;
}

export interface MeResponse {
  user: AuthUser;
  roles: RbacRoleSummary[];
  permissions: string[];   // ["*"] for super_admin
}
```

---

## 3. Cross-cutting

### 3.1 Phasing recap (with shipping order)

| Phase | Backend | Frontend | Ships? |
|-------|---------|----------|--------|
| 1 | `/me` extension + `ResolveUserPermissions` | `useMyPermissions` + `<Can>` + 2 isAdmin replacements | **YES** — unblocks delete-task TODAY |
| 2 | Migration (11 modules + 24 sub-actions + super_admin grants) | — | YES — no FE impact |
| 3 | `permissions.routes.ts` + `rolePermissions.routes.ts` (read endpoints) | `<RequirePermission>` + `<NoPermissionPage>` + nav filter | YES |
| 4 | `SetRolePermissions` (write endpoint) | `RolesMatrixPage` + rail + matrix + new-role-modal | YES |
| 5 | — | Gate buttons in clients, billing, tickets, etc. (10-15 spots) | YES |

### 3.2 Rollback per phase

| Phase | Rollback strategy |
|-------|-------------------|
| 1 | Revert FE commit + revert BE `/me` shape (`res.json(req.user)`). Feature flag `RBAC_EFFECTIVE_PERMS=false` short-circuits the use case path. |
| 2 | `prisma migrate resolve --rolled-back` + run `down.sql` (1.5 above) |
| 3-5 | Pure FE reverts; no DB state to undo. |

### 3.3 Open risks (still open)

- **Test setup for `useMyPermissions` in 1300+ existing FE tests**: many tests mount components that transitively render `<Can>`. We need a default mock in `src/test/setup.ts` (returning permissive `can: () => true`) so existing tests don't break. Without this, Phase 1 explodes existing test suites.
- **Backwards compat of `/me`**: if any consumer reads `me.id` (not `me.user.id`) after SDD #3 lands, it breaks. SDD #2 audit suggests all reads go through AuthContext which maps `data → user`. Audit one more time in Phase 1 task breakdown.
- **CI count assertion**: migration must succeed twice (idempotency). Add a verify step that runs the migration once, asserts counts, then runs again, asserts same counts.

### 3.4 Observability hook

In Phase 4, wrap `setRolePermissions.mutateAsync` with a simple structured log (existing pattern):
```ts
console.info('[rbac.matrix.save]', { roleId, count: permissionIds.length, durationMs });
```
This is the audit precursor — SDD #4 (audit-log-mutations) will turn this into a real persisted log.
