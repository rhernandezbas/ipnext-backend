# Spec: rbac-frontend-primitives

## Capability
FE permission primitives: hook, conditional component, page guard, nav filter,
and replacement of 2 broken legacy role checks.

**Artifact store**: engram only (FE has no openspec directory).
This file lives in the BE repo for cross-reference; canonical FE spec is in
engram at `sdd/roles-permissions-management/fe-spec`.

---

## Stack context (from sdd-init/ipnext-frontend)
- React 18.2 + TypeScript 5.3 strict, Vite 5
- TanStack Query v5, axios via `src/api/axios-client.ts`
- CSS Modules + design tokens (`var(--color-*)`, `var(--space-*)`)
- Vitest + Testing Library, strict TDD mode active
- Path alias: `@/` → `src/`

---

## Files to create

```
src/api/auth.api.ts                          (new — or extend existing)
src/lib/rbac/types.ts                        (new — shared RBAC types)
src/lib/rbac/useMyPermissions.ts             (new hook)
src/lib/rbac/useCan.ts                       (new convenience hook)
src/lib/rbac/Can.tsx                         (new component)
src/lib/rbac/RequirePermission.tsx           (new page guard)
src/lib/rbac/NoPermissionPage.tsx            (new 403 page)
src/lib/rbac/index.ts                        (barrel export)
src/__tests__/lib/rbac/useMyPermissions.test.ts
src/__tests__/lib/rbac/Can.test.tsx
src/__tests__/lib/rbac/RequirePermission.test.tsx
```

---

## Types (`src/lib/rbac/types.ts`)

```ts
export interface RbacRole {
  id: string;
  code: string;
  label: string;
}

export interface MeResponse {
  user: { id: string; login: string; email: string; name: string };
  roles: RbacRole[];
  permissions: string[];  // ["*"] for super_admin
}
```

---

## `useMyPermissions` hook

**File**: `src/lib/rbac/useMyPermissions.ts`

```ts
// Canonical query key — must match invalidation calls site-wide
export const ME_PERMISSIONS_QUERY_KEY = ['me', 'permissions'] as const;

function useMyPermissions() {
  const query = useQuery({
    queryKey: ME_PERMISSIONS_QUERY_KEY,
    queryFn: () => authApi.getMe(),   // GET /api/auth/me → MeResponse
    staleTime: 5 * 60 * 1000,         // 5 minutes
    retry: 1,
  });

  function can(permission: string): boolean {
    if (!query.data) return false;
    const perms = query.data.permissions;
    return perms.includes('*') || perms.includes(permission);
  }

  return {
    user: query.data?.user ?? null,
    roles: query.data?.roles ?? [],
    permissions: query.data?.permissions ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    can,
  };
}
```

### Requirements
- R1: `staleTime` is 5 minutes. Must NOT be 0 (avoids refetch on every re-render).
- R2: `can('*')` returns true if permissions array includes `'*'` (super_admin sentinel).
- R3: `can(p)` returns false while loading (not true, not error).
- R4: Query key is exported constant — consumers MUST use it for invalidation.

---

## `useCan` hook

**File**: `src/lib/rbac/useCan.ts`

```ts
function useCan(permission: string): boolean {
  const { can } = useMyPermissions();
  return can(permission);
}
```

Convenience wrapper. No additional logic.

---

## `<Can>` component

**File**: `src/lib/rbac/Can.tsx`

### Props
```ts
interface CanProps {
  permission?: string;          // single permission check
  permissions?: string[];       // multi-permission check
  mode?: 'any' | 'all';         // default: 'any'
  fallback?: React.ReactNode;   // default: null
  children: React.ReactNode;
}
```

### Render logic
1. While `isLoading`: render `fallback ?? null`
2. While `isError`: render `fallback ?? null`
3. If `permission` prop: check `can(permission)`. Render children if granted, fallback otherwise.
4. If `permissions` prop + `mode="any"` (default): render children if ANY permission passes.
5. If `permissions` prop + `mode="all"`: render children if ALL permissions pass.
6. If neither prop: render children unconditionally (defensive passthrough).

### Requirements
- R1: Default behavior during loading is `null` (no flash of restricted content).
- R2: `fallback` prop overrides the null default for loading AND denied states.
- R3: `mode="all"` requires every permission in the array to pass.
- R4: Component is a pure render — no side effects, no navigation.

---

## `<RequirePermission>` component

**File**: `src/lib/rbac/RequirePermission.tsx`

### Props
```ts
interface RequirePermissionProps {
  permission: string;
  children: React.ReactNode;
}
```

### Render logic
1. While `isLoading`: render a centered `<LoadingSkeleton />` (or a generic
   spinner from atoms — TBD in design). Minimum height to avoid layout shift.
2. While `isError`: render `<NoPermissionPage />` (fail-safe: treat fetch error
   as unauthorized).
3. If `can(permission)` → render `children`.
4. Else → render `<NoPermissionPage />`.

### Requirements
- R1: Loading state shows skeleton/spinner, NOT the children (avoids FOUC).
- R2: Error state shows `<NoPermissionPage />` (treat network error as denied).
- R3: Page-level usage — wraps entire page content, not individual elements.

---

## `<NoPermissionPage>` component

**File**: `src/lib/rbac/NoPermissionPage.tsx`

### Visual spec (IMPECCABLE principles)
- Container: centered card (max-width 480px, margin auto, padding var(--space-8)).
- Icon: shield with X or lock icon from the app's icon set (or SVG inline).
  Color: `var(--color-warning-500)` or `var(--color-error-300)`.
- Heading: "No tenés permisos para ver esta sección" (H2, var(--font-size-xl)).
- Body text: "Si creés que es un error, contactá al administrador del sistema."
- CTA button: "Volver al inicio" → navigates to `/admin/dashboard` via
  `useNavigate()`.
- Role: `role="main"`, `aria-label="Sin permisos"`.

---

## Nav filter

**File**: `src/components/Sidebar.tsx` (modified)

### Change
Read `useMyPermissions()` in Sidebar. For each nav item, add a `requiredPermission`
field to the nav config (e.g. `"scheduling.read"`, `"billing.read"`).

```ts
// Nav item shape (extend existing)
interface NavItem {
  label: string;
  path: string;
  icon: ReactNode;
  requiredPermission?: string;  // new optional field
}
```

Filter nav items: `item.requiredPermission ? can(item.requiredPermission) : true`.

While `isLoading`, show ALL nav items (avoid layout shift on load; permissions
will hide items once loaded).

### Permission mapping (nav item → module.read)

| Nav section | Permission |
|---|---|
| Panel de control | `dashboard.read` |
| Monitoreo | `monitoring.read` |
| Notificaciones | `notifications.read` |
| Clientes | `clients.read` |
| Clientes Potenciales | `crm.read` |
| Tickets | `tickets.read` |
| Mensajes | `support.read` |
| Finanzas | `billing.read` |
| Gestión de red | `network.read` |
| Scheduling | `scheduling.read` |
| Inventario | `inventory.read` |
| Voz | `voices.read` |
| SLA | `sla.read` |
| Resellers | `partners.read` |
| Portal | `portal.read` |
| Tarifas | `tariffs.read` |
| Administración | `admin.manage_admins` OR `rbac.manage_users` |
| Configuración | `settings.read_system` |
| Informes | `reports.read` |

---

## Legacy check replacements

### File 1: `src/pages/scheduling/SchedulingTaskDetailPage.tsx:63`
```diff
- const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
+ // Replaced by <Can> — see delete button JSX below
```
Delete button wrapping:
```tsx
<Can permission="scheduling.delete">
  <button onClick={handleDelete} className={styles.deleteBtn}>
    Eliminar tarea
  </button>
</Can>
```

### File 2: `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx:305`
```diff
- const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
```
Bulk action bar:
```tsx
<Can permission="scheduling.bulk_delete">
  <BulkDeleteBar selectedIds={selectedIds} onDelete={handleBulkDelete} />
</Can>
```
Single-row delete (in table row actions):
```tsx
<Can permission="scheduling.delete">
  <IconButton icon={<TrashIcon />} onClick={() => handleDelete(task.id)} />
</Can>
```

---

## API function

**File**: `src/api/auth.api.ts`
```ts
import axiosClient from './axios-client';
import type { MeResponse } from '@/lib/rbac/types';

export const authApi = {
  getMe: (): Promise<MeResponse> =>
    axiosClient.get('/auth/me').then(r => r.data),
};
```

---

## Scenarios (= test cases)

### S1 — useMyPermissions — loading state
```
Given: query is pending
When:  render a component consuming useMyPermissions()
Then:  isLoading=true, permissions=[], roles=[], user=null
```

### S2 — useMyPermissions — super_admin sentinel
```
Given: /api/auth/me returns { permissions: ["*"], roles: [...], user: {...} }
When:  call can("scheduling.delete")
Then:  returns true
When:  call can("any.made.up.permission")
Then:  returns true
```

### S3 — useMyPermissions — regular user
```
Given: /api/auth/me returns { permissions: ["scheduling.read", "scheduling.write"], ... }
When:  call can("scheduling.read")
Then:  returns true
When:  call can("scheduling.delete")
Then:  returns false
```

### S4 — <Can> — granted
```
Given: permissions includes "scheduling.delete"
When:  render <Can permission="scheduling.delete"><button>Delete</button></Can>
Then:  button is in the document
```

### S5 — <Can> — denied
```
Given: permissions does NOT include "scheduling.delete"
When:  render <Can permission="scheduling.delete"><button>Delete</button></Can>
Then:  button is NOT in the document
```

### S6 — <Can> — loading → null
```
Given: isLoading = true
When:  render <Can permission="scheduling.delete"><button>Delete</button></Can>
Then:  button is NOT in the document
```

### S7 — <Can> — loading with fallback
```
Given: isLoading = true
When:  render <Can permission="x" fallback={<span>loading...</span>}><button>X</button></Can>
Then:  "loading..." is in the document
And:   button is NOT in the document
```

### S8 — <Can> — mode="all" both granted
```
Given: permissions = ["a.read", "b.write"]
When:  <Can permissions={["a.read", "b.write"]} mode="all"><div>ok</div></Can>
Then:  "ok" is in the document
```

### S9 — <Can> — mode="all" one missing
```
Given: permissions = ["a.read"]
When:  <Can permissions={["a.read", "b.write"]} mode="all"><div>ok</div></Can>
Then:  "ok" is NOT in the document
```

### S10 — <RequirePermission> — denied → NoPermissionPage
```
Given: user lacks "reports.read"
When:  render <RequirePermission permission="reports.read"><ReportsPage /></RequirePermission>
Then:  "No tenés permisos" text is in the document
And:   ReportsPage content is NOT rendered
```

### S11 — <RequirePermission> — loading → skeleton
```
Given: isLoading = true
When:  render <RequirePermission permission="x"><PageContent /></RequirePermission>
Then:  PageContent is NOT rendered
And:   a loading indicator is present
```

### S12 — super_admin can access all permissions
```
Given: permissions = ["*"]
When:  render <RequirePermission permission="rbac.manage_roles"><Panel /></RequirePermission>
Then:  Panel is rendered
```

### S13 — NoPermissionPage — navigate home
```
Given: NoPermissionPage rendered
When:  user clicks "Volver al inicio"
Then:  navigate("/admin/dashboard") is called
```

### S14 — nav filter — hides item without permission
```
Given: user lacks "billing.read"
When:  Sidebar rendered
Then:  "Finanzas" nav item is NOT in the document
```

### S15 — nav filter — shows all while loading
```
Given: isLoading = true
When:  Sidebar rendered
Then:  all nav items ARE in the document (no premature hiding)
```
